// Shared browser-session layer for the Taobao browser session.
// A long-lived Chrome keeps the login state in its own profile directory, and every
// command talks to it over the DevTools Protocol. Node 22+ provides fetch + WebSocket,
// so the only real dependencies are the QR decoder (jsqr) and PNG decoding (pngjs).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'

export const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
/** Shipped version, so a helper process we spawned can prove which release it came from. */
export const VERSION = JSON.parse(readFileSync(join(MODULE_DIR, '..', 'package.json'), 'utf8')).version

// Login state must outlive the installed package: a reinstall rewrites node_modules, so the
// Chrome profile, its HOME shim, and the run dir live under DSH_HOME instead of beside the code.
// TB_DATA_DIR is set by the plugin from its `dataDir` config; both defaults agree.
export const DATA_DIR = process.env.TB_DATA_DIR
  ? resolve(process.env.TB_DATA_DIR)
  : join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'taobao')
export const PROFILE = join(DATA_DIR, 'profile')
export const HOME_DIR = join(DATA_DIR, 'home')
export const RUN_DIR = join(DATA_DIR, 'run')
export const HTTP_PORT = Number(process.env.TB_HTTP_PORT || 3099)
export const CHROME = process.env.TB_CHROME || '/usr/bin/google-chrome'
// Minimum time a decoded QR stays authoritative: it is held on screen this long before another may
// replace it, and forced navigation to the login page is capped at the same interval. Set by the
// plugin from its `qrRefreshMs` config.
export const QR_REFRESH_MS = Number(process.env.TB_QR_REFRESH_MS || 60000)
// What to do with the driven window. The QR is decoded from the page and re-served on the local
// page (`cli.mjs serve`), and searches only read the DOM, so the window itself is machinery the
// user never has to see — left alone it lands on top of the harness and steals focus. `minimized`
// parks it off screen (the one state CDP can set that does that); the page keeps rendering while
// hidden, verified for both a loaded page and one navigated while parked. `normal` leaves the
// window visible, which is what you want when Taobao answers with a slider you solve by hand.
export const WINDOW_MODE = process.env.TB_WINDOW_MODE || 'minimized'
// The legacy /member/login.jhtml entry point answers with a redirect chain that appends
// `redirectURL=...i.taobao.com/my_taobao.htm`. On a half-authenticated session that chain lands on
// the logged-in page instead of a QR, which is what set off the navigation loop. The current
// endpoint renders the login page directly.
export const LOGIN_URL = 'https://login.taobao.com/havanaone/login/login.htm'
export const SEARCH_URL = (q) => 'https://s.taobao.com/search?q=' + encodeURIComponent(q)

// `unb` is the numeric user id Taobao sets only after a real login; the rest are
// corroborating cookies. Anonymous visitors only carry cna/tfstk/cookie2-style values.
const LOGIN_COOKIES = ['unb', '_l_g_', 'lgc', 'tracknick']

// 9411 turned out to be taken by an unrelated local service, so probe instead of assuming.
const PORT_CANDIDATES = Array.from({ length: 24 }, (_, i) => 9500 + i)
const PORT_FILE = join(RUN_DIR, 'port')
// Presence means "a human put the window on screen on purpose; leave it there".
const SHOW_HOLD = join(RUN_DIR, 'show-hold')
let _port = process.env.TB_PORT ? Number(process.env.TB_PORT) : null

for (const d of [PROFILE, HOME_DIR, RUN_DIR]) mkdirSync(d, { recursive: true })

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chromeEnv = () => ({
  ...process.env,
  HOME: HOME_DIR,
  XDG_CONFIG_HOME: join(HOME_DIR, '.config'),
  XDG_CACHE_HOME: join(HOME_DIR, '.cache'),
})

function chromeArgs(headful, port, extra = []) {
  return [
    ...(headful ? [] : ['--headless=new']),
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${PROFILE}`,
    // The DSH file sandbox forbids the setuid sandbox and PID namespaces, and crashpad
    // cannot write outside the workspace.
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    // Keep navigator.webdriver false so the anti-bot layer has less to key on.
    '--disable-blink-features=AutomationControlled',
    // A parked window must keep loading, laying out and running timers: otherwise the login page
    // would stop rotating its QR and the search results would never arrive.
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--window-size=1280,960',
    '--lang=zh-CN',
    ...extra,
  ]
}

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) })
    if (!r.ok) return null
    const j = await r.json()
    return j?.webSocketDebuggerUrl ? j : null
  } catch {
    return null
  }
}

function isFree(port) {
  return new Promise((resolve) => {
    const s = createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

/**
 * Whether the Chrome listening on `port` is the one we started, identified by the profile
 * directory it was launched with.
 *
 * Adopting whatever answers on a candidate port is unsafe: a second profile on the same machine
 * runs its own Chrome out of the same range, takes the lowest free port, and would be adopted
 * along with its login. That is reachable from a blind scan and from our own port file, which is
 * just as stale when the Chrome it names has since been replaced. The profile path appears only in
 * the browser's command line, and Linux exposes that through /proc.
 *
 * `null` means ownership could not be determined (not Linux, no /proc, or nothing readable in it),
 * which callers treat as "the port alone decides" — so this can only tighten, never break, the
 * environments where the check is unavailable.
 */
function ownsPort(port) {
  if (process.platform !== 'linux') return null
  let entries
  try { entries = readdirSync('/proc') } catch { return null }
  const wantPort = `--remote-debugging-port=${port}`
  const wantProfile = `--user-data-dir=${PROFILE}`
  let readable = false
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    let cmd
    try { cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8') } catch { continue }
    if (!cmd) continue
    readable = true
    if (cmd.includes(wantPort) && cmd.includes(wantProfile)) return true
  }
  return readable ? false : null
}

/** Probe `port`, accepting it only when the browser answering there is ours. */
async function adopt(port) {
  const version = await probe(port)
  if (!version) return null
  if (ownsPort(port) === false) return null
  return version
}

/** The port our daemon is already listening on, if any. */
export async function findRunning() {
  // An explicit TB_PORT is a direct instruction, so ownership is not second-guessed there.
  if (_port) {
    const v = await probe(_port)
    if (v) return { port: _port, version: v }
  }
  if (existsSync(PORT_FILE)) {
    const p = Number(readFileSync(PORT_FILE, 'utf8').trim())
    if (p) {
      const v = await adopt(p)
      if (v) { _port = p; return { port: p, version: v } }
    }
  }
  for (const p of PORT_CANDIDATES) {
    const v = await adopt(p)
    if (v) { _port = p; return { port: p, version: v } }
  }
  return null
}

async function pickFreePort() {
  if (_port && (await isFree(_port))) return _port
  for (const p of PORT_CANDIDATES) if (await isFree(p)) return p
  throw new Error('no free port in 9500-9523')
}

export async function port() {
  if (_port) return _port
  const running = await findRunning()
  if (running) return running.port
  throw new Error('browser daemon is not running; run `node tb.mjs start`')
}

async function spawnChrome(headful, port, waitMs) {
  const log = openSync(join(RUN_DIR, 'chrome.log'), 'a')
  const child = spawn(CHROME, chromeArgs(headful, port, ['about:blank']), {
    detached: true,
    stdio: ['ignore', log, log],
    env: chromeEnv(),
  })
  child.unref()
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await sleep(400)
    const v = await probe(port)
    if (v) return { version: v.Browser, wsUrl: v.webSocketDebuggerUrl, pid: child.pid, headful, port }
  }
  try { child.kill('SIGKILL') } catch {}
  return null
}

/** Start Chrome if it is not already listening, preferring a real window on $DISPLAY. */
export async function ensureChrome() {
  const alive = await findRunning()
  if (alive) {
    const parked = await parkBrowser(alive.version.webSocketDebuggerUrl)
    return { started: false, version: alive.version.Browser, port: alive.port, parked }
  }

  const chosen = await pickFreePort()
  _port = chosen
  writeFileSync(PORT_FILE, String(chosen))

  const wantHeadful = !process.env.TB_HEADLESS && Boolean(process.env.DISPLAY)
  if (wantHeadful) {
    const got = await spawnChrome(true, chosen, 25000)
    if (got) return { started: true, ...got, parked: await parkBrowser(got.wsUrl) }
  }
  const got = await spawnChrome(false, chosen, 25000)
  if (got) {
    return { started: true, ...got, headful: false, headfulFallback: wantHeadful, parked: await parkBrowser(got.wsUrl) }
  }
  throw new Error('chrome did not come up; see run/chrome.log')
}

export async function stopChrome() {
  const running = await findRunning()
  if (!running) return false
  const cdp = await connect(running.version.webSocketDebuggerUrl)
  try { await cdp.send('Browser.close') } catch {}
  await sleep(1500)
  _port = null
  return true
}

export class Cdp {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.pending = new Map()
    this.handlers = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
      } else if (msg.method) {
        const h = this.handlers.get(msg.method)
        if (h) h(msg.params)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.seq
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  on(method, fn) { this.handlers.set(method, fn) }
  close() { try { this.ws.close() } catch {} }
}

export function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => res(new Cdp(ws)))
    ws.addEventListener('error', (e) => rej(new Error('ws error: ' + String(e?.message ?? e))))
  })
}

/** CDP names a browser window by an opaque id that has to be looked up per target. */
async function windowFor(cdp, target) {
  const r = await cdp.send('Browser.getWindowForTarget', target?.id ? { targetId: target.id } : {})
  return r?.windowId
}

async function setWindowState(cdp, target, windowState) {
  const windowId = await windowFor(cdp, target)
  if (windowId === undefined) return null
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState } })
  return windowState
}

/**
 * Take the driven window out of the user's way. Parking is a courtesy: a window that cannot be
 * reached is never a reason to fail the command, so every failure here collapses to `null`.
 */
export async function parkWindow(cdp, target) {
  if (WINDOW_MODE !== 'minimized' || heldVisible()) return null
  try { return await setWindowState(cdp, target, 'minimized') } catch { return null }
}

/**
 * A window a human asked for stays visible until they ask for it back. Without this, `show` would
 * be undone by the next poll of the QR page three seconds later, which is worse than not having it.
 */
export function holdWindow(hold) {
  try {
    if (hold) writeFileSync(SHOW_HOLD, String(Date.now()))
    else rmSync(SHOW_HOLD, { force: true })
    return true
  } catch { return false }
}

/** Whether a human is currently holding the window on screen. */
export function heldVisible() {
  try { return existsSync(SHOW_HOLD) } catch { return false }
}

/**
 * Put the window back in front of a human. Restoring the bounds alone would leave it behind the
 * harness window, so the tab is brought to the front too — that activates the window as well.
 */
export async function showWindow(cdp, target) {
  try {
    const state = await setWindowState(cdp, target, 'normal')
    if (state) { try { await cdp.send('Page.bringToFront') } catch { /* not fatal */ } }
    return state
  } catch { return null }
}

/** The window state the browser reports, for commands that describe the session. */
export async function windowState(cdp, target) {
  try {
    const windowId = await windowFor(cdp, target)
    return (await cdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState
  } catch { return null }
}

/**
 * Park the window of a browser we know only by its debugger URL — the startup path, before a page
 * session exists. The window is created together with the browser, so this is what keeps it from
 * appearing on top at all.
 */
export async function parkBrowser(wsUrl) {
  if (WINDOW_MODE !== 'minimized' || heldVisible() || !wsUrl) return false
  let cdp
  try {
    // Bounded: a browser that accepts the socket but never answers the handshake must not hold
    // the command open. Losing the race drops the connection instead of parking the window.
    const opening = connect(wsUrl)
    cdp = await Promise.race([opening, sleep(4000).then(() => null)])
    if (!cdp) {
      opening.then((late) => late?.close()).catch(() => {})
      return false
    }
    const { targetInfos } = await cdp.send('Target.getTargets')
    const page = targetInfos.find((t) => t.type === 'page') ?? targetInfos[0]
    if (!page) return false
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: page.targetId })
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } })
    return true
  } catch {
    return false
  } finally {
    cdp?.close()
  }
}

/**
 * Open a CDP session on the Taobao tab, reusing it across commands so the login page
 * (and any half-finished interaction) survives between invocations.
 */
export async function openPage() {
  const p = await port()
  const list = await (await fetch(`http://127.0.0.1:${p}/json/list`)).json()
  const pages = list.filter((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools://'))
  const target =
    pages.find((t) => /taobao|tmall|alibaba/.test(t.url)) ??
    pages[0] ??
    (await (await fetch(`http://127.0.0.1:${p}/json/new?about:blank`, { method: 'PUT' })).json())

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')
  await cdp.send('Runtime.enable')
  return { cdp, target }
}

export async function goto(cdp, url, settleMs = 1500) {
  const loaded = new Promise((r) => cdp.on('Page.loadEventFired', r))
  try { await cdp.send('Page.navigate', { url }) } catch { /* about:blank edge cases */ }
  await Promise.race([loaded, sleep(30000)])
  if (settleMs) await sleep(settleMs)
}

export async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('page eval failed: ' + (r.exceptionDetails.text ?? 'unknown'))
  return r.result.value
}

export async function currentUrl(cdp) {
  return await evaluate(cdp, 'location.href')
}

export async function readCookies(cdp) {
  const r = await cdp.send('Network.getAllCookies')
  return r.cookies
}

export function loginFromCookies(list) {
  const byName = new Map(list.map((c) => [c.name, c.value]))
  const hits = LOGIN_COOKIES.filter((n) => byName.get(n))
  const unb = byName.get('unb') || null
  return { loggedIn: Boolean(unb) || hits.length >= 2, hits, unb }
}

/** Locate the square canvas the login page draws its QR into. */
export async function findQrCanvas(cdp) {
  const raw = await evaluate(cdp, `(() => {
    const out = []
    for (const c of document.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect()
      out.push({ w: c.width, h: c.height, rw: Math.round(r.width), rh: Math.round(r.height),
                 x: Math.round(r.x), y: Math.round(r.y),
                 ratio: +(c.width / Math.max(1, c.height)).toFixed(3),
                 visible: r.width > 0 && r.height > 0 })
    }
    return JSON.stringify(out)
  })()`)
  const canvases = JSON.parse(raw)
  return canvases.find((c) => c.visible && c.w >= 120 && c.ratio > 0.9 && c.ratio < 1.1) ?? null
}

/** Screenshot the QR region and decode it, so we know it is genuinely scannable. */
export async function captureQr(cdp) {
  const rect = await findQrCanvas(cdp)
  if (!rect) return null
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: rect.x, y: rect.y, width: rect.rw, height: rect.rh, scale: 2 },
  })
  const png = Buffer.from(shot.data, 'base64')
  let payload = null
  try {
    const img = PNG.sync.read(png)
    payload = jsQR(new Uint8ClampedArray(img.data), img.width, img.height)?.data ?? null
  } catch { /* keep the PNG even if decoding fails */ }
  return { png, payload, rect }
}

export async function waitForItems(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() < deadline) {
    last = await evaluate(cdp, `document.querySelectorAll('a[href*="item.taobao.com/item.htm"], a[href*="detail.tmall.com/item.htm"]').length`)
    if (last > 0) return last
    await sleep(1000)
  }
  return last
}

const EXTRACT_JS = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim()
  const pick = (root, sels) => {
    for (const s of sels) {
      const t = clean(root.querySelector(s)?.innerText)
      if (t) return t
    }
    return null
  }
  const anchors = [...document.querySelectorAll('a[href]')].filter((a) =>
    /item\\.taobao\\.com\\/item\\.htm|detail\\.tmall\\.com\\/item\\.htm/.test(a.href))
  const seen = new Set()
  const items = []
  for (const a of anchors) {
    const idm = a.href.match(/[?&]id=(\\d+)/)
    const id = idm ? idm[1] : a.href
    if (seen.has(id)) continue
    seen.add(id)
    let card = null
    let node = a
    for (let i = 0; i < 7 && node; i++) {
      const t = clean(node.innerText)
      if (t.length > 25 && /[¥￥]\\s*\\d/.test(t)) { card = node; break }
      node = node.parentElement
    }
    const host = card || a.parentElement || a
    const raw = clean(host.innerText)

    // Taobao's class names are CSS-modules hashed, but the stable prefix before "--"
    // survives rebuilds, so match on that and fall back to text heuristics.
    const title = pick(host, ['[class*="title--"]', '[class*="Title--"]', '[class*="ItemTitle"]'])
      || clean(raw.split(/[¥￥]/)[0]).slice(0, 120) || null

    // The price is split across two elements ("78" + "3"), which is why the naive
    // text match produced a truncated integer.
    const intPart = pick(host, ['[class*="priceInt--"]', '[class*="price-int"]'])
    const floatPart = pick(host, ['[class*="priceFloat--"]', '[class*="price-float"]'])
    let price = null
    if (intPart) {
      const i = intPart.replace(/[^\\d]/g, '')
      const f = (floatPart || '').replace(/[^\\d]/g, '')
      if (i) price = f ? i + '.' + f : i
    }
    if (price === null) {
      const m = raw.replace(/\\s+/g, '').match(/[¥￥](\\d+(?:\\.\\d+)?)/)
      price = m ? m[1] : null
    }

    // Search-result anchors carry megabytes of tracking params; keep only the item identity,
    // built by concatenation because this whole block is itself a template literal.
    const itemId = (a.href.match(/[?&]id=(\\d+)/) || [])[1]
    const isTaobao = /item\\.taobao\\.com/.test(a.href)
    items.push({
      id,
      source: isTaobao ? 'taobao' : 'tmall',
      url: itemId ? 'https://' + (isTaobao ? 'item.taobao.com' : 'detail.tmall.com') + '/item.htm?id=' + itemId : a.href,
      title,
      price: price === null ? null : Number(price),
      priceNote: pick(host, ['[class*="priceDesc--"]']),
      sales: pick(host, ['[class*="realSales--"]'])
        || (raw.match(/([\\d.]+(?:万)?\\+?)\\s*(?:人付款|人已购|人收货|已售|人想要)/) || [])[1] || null,
      shop: pick(host, ['[class*="shopNameText--"]', '[class*="shopName--"]', '[class*="ShopInfo--"]']),
      shipFrom: pick(host, ['[class*="procity--"]']),
      text: raw.slice(0, 160),
    })
    if (items.length >= 40) break
  }
  return JSON.stringify({
    url: location.href,
    title: document.title,
    loginPrompt: /亲，请登录/.test(document.body ? document.body.innerText : ''),
    count: items.length,
    items,
    bodyStart: clean(document.body ? document.body.innerText : '').slice(0, 240),
  })
})()`

export async function extractItems(cdp) {
  return JSON.parse(await evaluate(cdp, EXTRACT_JS))
}

// Taobao's risk control answers with a slider instead of the page. An agent cannot pass it, so the
// only useful thing to do is put the window back in front of the human and say so. Both the URL
// (the `x5sec` / `_____tmd_____` interstitial) and the visible text are checked.
const CHALLENGE_URL = /x5sec|_____tmd_____|punish|captcha|security-check/i
const CHALLENGE_TEXT = /滑动验证|拖动滑块|按住滑块|请完成验证|点击进行验证/

/** A short description of the challenge on screen, or null when the page is the real one. */
export async function detectChallenge(cdp) {
  try {
    const url = await currentUrl(cdp)
    if (CHALLENGE_URL.test(String(url))) return String(url).slice(0, 120)
    const text = await evaluate(cdp, `document.body ? document.body.innerText.slice(0, 400) : ''`)
    const hit = CHALLENGE_TEXT.exec(String(text ?? ''))
    return hit ? hit[0] : null
  } catch {
    return null
  }
}

export async function searchQuery(cdp, query, target) {
  // A challenge already on screen needs the window in front of the human, not parked again.
  if (!(await detectChallenge(cdp))) await parkWindow(cdp, target)
  await goto(cdp, SEARCH_URL(query), 2000)
  const found = await waitForItems(cdp, 30000)
  const result = await extractItems(cdp)
  result.waitedItemLinks = found
  result.query = query
  const challenge = await detectChallenge(cdp)
  if (challenge) {
    result.challenge = challenge
    await showWindow(cdp, target)
  }
  return result
}
