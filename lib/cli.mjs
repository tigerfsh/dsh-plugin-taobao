// cli.mjs — a thin CLI over the long-lived Taobao browser session. The plugin spawns this
// as a child process; it is also runnable by hand.
//   node cli.mjs start            launch the browser daemon (reuses an existing one)
//   node cli.mjs status           report login state, cookies and current page
//   node cli.mjs qr               capture + decode the login QR, write run/qr.png
//   node cli.mjs search "蓝牙耳机"  search once the session is logged in
//   node cli.mjs serve            local page that always shows the current QR
//   node cli.mjs show             bring the driven browser window back to the front
//   node cli.mjs hide             park it out of the way again
//   node cli.mjs stop             close the browser daemon
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import {
  RUN_DIR, HTTP_PORT, LOGIN_URL, QR_REFRESH_MS, DATA_DIR, VERSION, MODULE_DIR, WINDOW_MODE,
  ensureChrome, stopChrome, findRunning, openPage, goto, currentUrl, evaluate,
  readCookies, loginFromCookies, captureQr, searchQuery, detectChallenge,
  parkWindow, showWindow, windowState, holdWindow, heldVisible, sleep,
} from './engine.mjs'

/**
 * Fingerprint of the code this process is running. The version string is not enough to spot a
 * stale page: a `link:` install edited in place keeps the same version, so without this the old
 * process would be mistaken for the current one and would go on serving the old page.
 */
const CODE_ID = createHash('sha1')
  .update(readFileSync(join(MODULE_DIR, 'cli.mjs')))
  .update(readFileSync(join(MODULE_DIR, 'engine.mjs')))
  .digest('hex')
  .slice(0, 12)

const [cmd, ...rest] = process.argv.slice(2)
const say = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2))

/**
 * Make sure the login page is the one showing, without reloading it on every call.
 *
 * A forced navigation is a full reload, and Taobao answers one by bouncing straight back — every
 * bounce paints a fresh QR, so the served image churns once per poll. Since the image is held for
 * `qrRefreshMs` anyway, forcing a navigation more often than that buys nothing and only feeds the
 * loop. The first call always navigates (`lastNavAt` starts at 0).
 */
let lastNavAt = 0
async function ensureLoginPage(cdp, force = false) {
  const url = await currentUrl(cdp)
  if (!force && /login\.taobao\.com|havanaone/.test(url)) return
  if (!force && Date.now() - lastNavAt < QR_REFRESH_MS) return
  lastNavAt = Date.now()
  await goto(cdp, LOGIN_URL, 2500)
}

async function snapshot() {
  const { cdp, target } = await openPage()
  try {
    const cookies = await readCookies(cdp)
    const state = loginFromCookies(cookies)
    return { cdp, target, state, url: await currentUrl(cdp), cookieCount: cookies.length }
  } catch (e) {
    cdp.close()
    throw e
  }
}

/**
 * Keep the driven window out of the user's way, except when Taobao wants a human.
 *
 * Parking is the default because the window is machinery: the QR is re-served on the local page
 * and searches only read the DOM. But a slider challenge is unsolvable by an agent, so the moment
 * one appears the window goes back to the front — and `challengeHold` keeps it there for as long
 * as the challenge lasts, instead of flapping it out of sight on the next 3-second tick.
 */
let challengeHold = false
async function parkOrShow(cdp, target) {
  const challenge = await detectChallenge(cdp)
  if (challenge) {
    if (!challengeHold) {
      challengeHold = true
      await showWindow(cdp, target)
    }
    return challenge
  }
  challengeHold = false
  await parkWindow(cdp, target)
  return null
}

/**
 * Last line of defence for parking: a login that cannot be decoded must never be where this ends.
 * A desktop where a hidden window stops painting the canvas is not one this code has seen, but if
 * it happens the answer is to go back to a visible window — and to hold it there, because that
 * environment has just said it needs one.
 */
async function rescueVisible(cdp, target) {
  if (WINDOW_MODE !== 'minimized' || heldVisible()) return false
  const state = await showWindow(cdp, target)
  // Only a window that really came back counts as this environment needing one; otherwise leave
  // the hold clear so the next attempt can still try to park rather than silently never parking.
  if (!state) return false
  holdWindow(true)
  return true
}

/** Capture the login QR, falling back to a visible window when a parked one will not paint it. */
async function captureQrWithRescue(cdp, target) {
  let qr = null
  for (let i = 0; i < 12 && !qr?.payload; i++) {
    qr = await captureQr(cdp)
    if (!qr?.payload) await sleep(1200)
  }
  if (!qr?.payload && await rescueVisible(cdp, target)) {
    for (let i = 0; i < 12 && !qr?.payload; i++) {
      qr = await captureQr(cdp)
      if (!qr?.payload) await sleep(1200)
    }
  }
  return qr
}

async function cmdStart() {
  const r = await ensureChrome()
  const { cdp } = await openPage()
  const url = await currentUrl(cdp)
  cdp.close()
  say({ ...r, url, windowMode: WINDOW_MODE })
}

async function cmdStatus() {
  await ensureChrome()
  const { cdp, target, state, url, cookieCount } = await snapshot()
  try {
    const title = (await evaluate(cdp, 'document.title')) ?? ''
    say({
      loggedIn: state.loggedIn, unb: state.unb, loginCookies: state.hits, cookieCount, url, title,
      window: await windowState(cdp, target), windowMode: WINDOW_MODE,
    })
  } finally {
    cdp.close()
  }
}

async function cmdQr() {
  await ensureChrome()
  const { cdp, target, state, url } = await snapshot()
  try {
    if (state.loggedIn) {
      say({ loggedIn: true, unb: state.unb, message: '已登录，无需扫码' })
      return
    }
    await ensureLoginPage(cdp)
    const challenge = await parkOrShow(cdp, target)
    if (challenge) throw new Error(`淘宝要求人工验证（${challenge}），已把浏览器窗口调到最前，请先完成验证`)
    const qr = await captureQrWithRescue(cdp, target)
    if (!qr?.payload) throw new Error('没能从登录页取到二维码')
    const file = join(RUN_DIR, 'qr.png')
    writeFileSync(file, qr.png)
    say({ loggedIn: false, from: url, file, canvas: `${qr.rect.w}x${qr.rect.h}`, payload: qr.payload })
  } finally {
    cdp.close()
  }
}

async function cmdSearch() {
  const query = rest.join(' ').trim()
  if (!query) throw new Error('用法: node tb.mjs search "关键词"')
  await ensureChrome()
  const { cdp, target, state } = await snapshot()
  try {
    if (!state.loggedIn) {
      say({ loggedIn: false, hint: '未登录，先跑 node tb.mjs serve 扫码' })
      return
    }
    const result = await searchQuery(cdp, query, target)
    if (result.challenge) result.hint = '淘宝要求人工验证，已把浏览器窗口调到最前，处理完再重试'
    say(result)
  } finally {
    cdp.close()
  }
}

/** Bring the window back on screen by hand, for whenever you want to watch the browser yourself. */
async function cmdShow() {
  await ensureChrome()
  const { cdp, target } = await snapshot()
  try {
    const window = await showWindow(cdp, target)
    // Held, or the serving page would park it again within seconds.
    holdWindow(true)
    say({ window, held: true })
  } finally {
    cdp.close()
  }
}

/** Park it again after a manual look. */
async function cmdHide() {
  await ensureChrome()
  const { cdp, target } = await snapshot()
  try {
    holdWindow(false)
    // The state the browser accepted; reading it straight back races the window manager.
    say({ window: await parkWindow(cdp, target), held: false })
  } finally {
    cdp.close()
  }
}

// ---------------------------------------------------------------- serve ------
// Keeps a valid QR on screen continuously: Taobao rotates the QR every couple of
// minutes, so a static screenshot would be stale by the time it is scanned. The capture
// runs far more often than that, which is why `watchTick` holds each QR for QR_REFRESH_MS
// before it will swap in another one.
const state = { loggedIn: false, unb: null, payload: null, rev: null, png: null, updatedAt: 0, error: null, misses: 0 }
// How long a request keeps the watcher interested. Comfortably longer than the page's 3 s poll,
// so an open page always counts as somebody looking.
const WATCH_WINDOW_MS = 30000

const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>淘宝扫码登录</title><style>
:root{color-scheme:dark light}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  background:#14161a;color:#e8eaed}
.card{background:#1c1f26;border:1px solid #2c313a;border-radius:16px;padding:28px 32px;text-align:center;
  box-shadow:0 12px 40px rgba(0,0,0,.45);max-width:420px}
h1{font-size:17px;margin:0 0 18px;font-weight:600}
img{width:212px;height:212px;image-rendering:pixelated;background:#fff;border-radius:10px;padding:10px;display:block;margin:0 auto}
.meta{font-size:12px;color:#8a94a6;margin:14px 0 0;min-height:18px}
.small{font-size:12px;color:#5f6875;margin:10px 0 0}
body.ok .card{border-color:#2ea043}
body.ok h1{color:#3fb950}
#hint{margin:16px 0 0;font-size:14px}
body.ok #hint{color:#3fb950;font-weight:600}
</style></head><body><div class="card">
<h1>用手机淘宝扫码登录</h1>
<div id="qrbox"><img id="qr" alt="二维码加载中"></div>
<p id="hint">打开 淘宝APP → 左上角「扫一扫」</p>
<p class="meta" id="meta">正在获取二维码…</p>
<p class="small">本页每 3 秒检查一次；二维码至少保留 ${Math.round(QR_REFRESH_MS / 1000)} 秒，登录成功后这里会变成 ✅。
淘宝那个浏览器窗口会被自动最小化到后台，不挡 DSH；想自己看的时候跑插件里的 <code>cli.mjs show</code>。</p>
</div><script>
let rev = null
let timer = null
async function tick(){
  let s
  try { s = await (await fetch('/status',{cache:'no-store'})).json() }
  catch { document.getElementById('meta').textContent = '本地服务已断开'; return }
  if (s.loggedIn){
    document.body.classList.add('ok')
    document.getElementById('hint').textContent = '✅ 登录成功，回到 DSH 会话继续即可'
    document.getElementById('qrbox').style.display = 'none'
    document.getElementById('meta').textContent = s.unb ? ('账号 ID: ' + s.unb) : ''
    // Nothing left to watch: stopping here lets the harness close the browser once it is idle.
    if (timer) clearInterval(timer)
    return
  }
  if (s.rev && s.rev !== rev){ rev = s.rev; document.getElementById('qr').src = '/qr.png?r=' + rev }
  document.getElementById('meta').textContent = s.error ? ('错误: ' + s.error)
    : (s.updatedAt ? ('二维码更新于 ' + new Date(s.updatedAt).toLocaleTimeString()) : '正在获取二维码…')
}
timer = setInterval(tick, 3000); tick()
</script></body></html>`

/* The page polls /status every 3 s, so "somebody asked recently" is exactly "somebody is looking
   at a QR" — and that is the only time this process should be driving a browser. The harness
   closes Chrome once it goes idle, and a poll that resurrected it in the background would undo
   that, so an unwatched daemon goes quiet and wakes up with the page. */
let lastSeenAt = 0
let quiet = false

async function watchTick() {
  if (Date.now() - lastSeenAt > WATCH_WINDOW_MS) { quiet = true; return }
  let cdp
  try {
    if (!(await findRunning())) await ensureChrome()
    const page = await openPage()
    cdp = page.cdp
    const cookies = await readCookies(cdp)
    const st = loginFromCookies(cookies)
    state.loggedIn = st.loggedIn
    state.unb = st.unb
    state.error = null
    if (st.loggedIn) {
      state.payload = null
      state.rev = null
      state.png = null
      // Clear the dwell too, or a later logout would wait out the previous QR's hold before
      // showing the next one.
      state.updatedAt = 0
      await parkOrShow(cdp, page.target)
      return
    }
    // Nobody looked for a while, so the code on the canvas has almost certainly expired on
    // Taobao's side; navigate for real instead of decoding a dead image.
    await ensureLoginPage(cdp, quiet)
    quiet = false
    const challenge = await parkOrShow(cdp, page.target)
    if (challenge) {
      state.error = `淘宝要求人工验证（${challenge}），已把浏览器窗口调到最前`
      return
    }
    let qr = await captureQr(cdp)
    if (!qr?.payload && !state.png) {
      // Three ticks with nothing to show: if the window is parked, a canvas that never paints is
      // a login this page cannot serve, so fall back to a visible window and a fresh page.
      state.misses += 1
      if (state.misses >= 3 && await rescueVisible(cdp, page.target)) {
        state.misses = 0
        await ensureLoginPage(cdp, true)
        qr = await captureQr(cdp)
      }
      if (!qr?.payload) state.error = '二维码还没渲染出来'
    } else {
      state.misses = 0
    }
    if (qr?.payload) {
      const rev = createHash('sha1').update(qr.payload).digest('hex').slice(0, 12)
      // Hold the QR already on screen for a minimum dwell, so a burst of changed payloads cannot
      // swap the image out from under someone mid-scan. Re-decoding a settled canvas measures as
      // stable; sustained churn means the page is being bounced and re-navigated, which
      // ensureLoginPage now throttles separately.
      const heldForMs = state.updatedAt ? Date.now() - state.updatedAt : Infinity
      if (rev !== state.rev && heldForMs >= QR_REFRESH_MS) {
        state.rev = rev
        state.png = qr.png
        state.payload = qr.payload
        state.updatedAt = Date.now()
        console.log(`[qr] ${new Date().toISOString()} rev=${rev} payload=${qr.payload.slice(0, 72)}…`)
      }
    }
  } catch (e) {
    state.error = String(e?.message ?? e)
  } finally {
    cdp?.close()
  }
}

async function cmdServe() {
  await ensureChrome()
  // Warm for the first half minute: the caller is about to hand out this URL.
  lastSeenAt = Date.now()
  await watchTick()
  setInterval(watchTick, 3000)

  const server = createServer((req, res) => {
    lastSeenAt = Date.now()
    const path = (req.url || '/').split('?')[0]
    if (path === '/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
        // Identity first: the plugin reads these to tell whether the page holding its port is
        // actually the one this release would have started, or a leftover it has to replace.
        service: 'dsh-plugin-taobao', version: VERSION, codeId: CODE_ID, pid: process.pid, dataDir: DATA_DIR,
        loggedIn: state.loggedIn, unb: state.unb, rev: state.rev, updatedAt: state.updatedAt, error: state.error,
      }))
      return
    }
    if (path === '/qr.png') {
      if (!state.png) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no qr yet'); return }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      res.end(state.png)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
  })

  await new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(HTTP_PORT, '127.0.0.1', res)
  })
  console.log(`[serve] http://127.0.0.1:${HTTP_PORT}/`)
  console.log(`[serve] QR PNG: http://127.0.0.1:${HTTP_PORT}/qr.png`)
}

const commands = {
  start: cmdStart,
  status: cmdStatus,
  qr: cmdQr,
  search: cmdSearch,
  serve: cmdServe,
  show: cmdShow,
  hide: cmdHide,
  // A window a human asked for is not closed from under them: `show` holds it until `hide`.
  stop: async () => say(
    heldVisible()
      ? { stopped: false, hint: '淘宝窗口正被 show 保持在最前，先跑 hide 再关' }
      : { stopped: await stopChrome() },
  ),
}

try {
  const fn = commands[cmd]
  if (!fn) {
    console.log('用法: node tb.mjs <start|status|qr|search|serve|show|hide|stop> [参数]')
    process.exit(2)
  }
  await fn()
  if (cmd !== 'serve') process.exit(0)
} catch (e) {
  console.error('ERROR: ' + (e?.stack ?? e))
  process.exit(1)
}
