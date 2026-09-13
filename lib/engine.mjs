// Shared browser-session layer for the Taobao browser session.
// A long-lived Chrome keeps the login state in its own profile directory, and every
// command talks to it over the DevTools Protocol. Node 22+ provides fetch + WebSocket,
// so the only real dependencies are the QR decoder (jsqr) and PNG decoding (pngjs).
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import jsQR from 'jsqr'
import { PNG } from 'pngjs'

export const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

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
export const LOGIN_URL = 'https://login.taobao.com/member/login.jhtml'
export const SEARCH_URL = (q) => 'https://s.taobao.com/search?q=' + encodeURIComponent(q)

// `unb` is the numeric user id Taobao sets only after a real login; the rest are
// corroborating cookies. Anonymous visitors only carry cna/tfstk/cookie2-style values.
const LOGIN_COOKIES = ['unb', '_l_g_', 'lgc', 'tracknick']

// 9411 turned out to be taken by an unrelated local service, so probe instead of assuming.
const PORT_CANDIDATES = Array.from({ length: 24 }, (_, i) => 9500 + i)
const PORT_FILE = join(RUN_DIR, 'port')
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

/** The port our daemon is already listening on, if any. */
export async function findRunning() {
  if (_port) {
    const v = await probe(_port)
    if (v) return { port: _port, version: v }
  }
  if (existsSync(PORT_FILE)) {
    const p = Number(readFileSync(PORT_FILE, 'utf8').trim())
    if (p) {
      const v = await probe(p)
      if (v) { _port = p; return { port: p, version: v } }
    }
  }
  for (const p of PORT_CANDIDATES) {
    const v = await probe(p)
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
    if (v) return { version: v.Browser, pid: child.pid, headful, port }
  }
  try { child.kill('SIGKILL') } catch {}
  return null
}

/** Start Chrome if it is not already listening, preferring a real window on $DISPLAY. */
export async function ensureChrome() {
  const alive = await findRunning()
  if (alive) return { started: false, version: alive.version.Browser, port: alive.port }

  const chosen = await pickFreePort()
  _port = chosen
  writeFileSync(PORT_FILE, String(chosen))

  const wantHeadful = !process.env.TB_HEADLESS && Boolean(process.env.DISPLAY)
  if (wantHeadful) {
    const got = await spawnChrome(true, chosen, 25000)
    if (got) return { started: true, ...got }
  }
  const got = await spawnChrome(false, chosen, 25000)
  if (got) return { started: true, ...got, headful: false, headfulFallback: wantHeadful }
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

export async function searchQuery(cdp, query) {
  await goto(cdp, SEARCH_URL(query), 2000)
  const found = await waitForItems(cdp, 30000)
  const result = await extractItems(cdp)
  result.waitedItemLinks = found
  result.query = query
  return result
}
