// cli.mjs — a thin CLI over the long-lived Taobao browser session. The plugin spawns this
// as a child process; it is also runnable by hand.
//   node cli.mjs start            launch the browser daemon (reuses an existing one)
//   node cli.mjs status           report login state, cookies and current page
//   node cli.mjs qr               capture + decode the login QR, write run/qr.png
//   node cli.mjs search "蓝牙耳机"  search once the session is logged in
//   node cli.mjs serve            local page that always shows the current QR
//   node cli.mjs stop             close the browser daemon
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import {
  RUN_DIR, HTTP_PORT, LOGIN_URL, QR_REFRESH_MS,
  ensureChrome, stopChrome, openPage, goto, currentUrl, evaluate,
  readCookies, loginFromCookies, captureQr, searchQuery, sleep,
} from './engine.mjs'

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
async function ensureLoginPage(cdp) {
  const url = await currentUrl(cdp)
  if (/login\.taobao\.com|havanaone/.test(url)) return
  if (Date.now() - lastNavAt < QR_REFRESH_MS) return
  lastNavAt = Date.now()
  await goto(cdp, LOGIN_URL, 2500)
}

async function snapshot() {
  const { cdp } = await openPage()
  try {
    const cookies = await readCookies(cdp)
    const state = loginFromCookies(cookies)
    return { cdp, state, url: await currentUrl(cdp), cookieCount: cookies.length }
  } catch (e) {
    cdp.close()
    throw e
  }
}

async function cmdStart() {
  const r = await ensureChrome()
  const { cdp } = await openPage()
  const url = await currentUrl(cdp)
  cdp.close()
  say({ ...r, url })
}

async function cmdStatus() {
  await ensureChrome()
  const { cdp, state, url, cookieCount } = await snapshot()
  try {
    const title = (await evaluate(cdp, 'document.title')) ?? ''
    say({ loggedIn: state.loggedIn, unb: state.unb, loginCookies: state.hits, cookieCount, url, title })
  } finally {
    cdp.close()
  }
}

async function cmdQr() {
  await ensureChrome()
  const { cdp, state, url } = await snapshot()
  try {
    if (state.loggedIn) {
      say({ loggedIn: true, unb: state.unb, message: '已登录，无需扫码' })
      return
    }
    await ensureLoginPage(cdp)
    let qr = null
    for (let i = 0; i < 12 && !qr?.payload; i++) {
      qr = await captureQr(cdp)
      if (!qr?.payload) await sleep(1200)
    }
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
  const { cdp, state } = await snapshot()
  try {
    if (!state.loggedIn) {
      say({ loggedIn: false, hint: '未登录，先跑 node tb.mjs serve 扫码' })
      return
    }
    say(await searchQuery(cdp, query))
  } finally {
    cdp.close()
  }
}

// ---------------------------------------------------------------- serve ------
// Keeps a valid QR on screen continuously: Taobao rotates the QR every couple of
// minutes, so a static screenshot would be stale by the time it is scanned. The capture
// runs far more often than that, which is why `watchTick` holds each QR for QR_REFRESH_MS
// before it will swap in another one.
const state = { loggedIn: false, unb: null, payload: null, rev: null, png: null, updatedAt: 0, error: null }

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
<p class="small">本页每 3 秒检查一次；二维码至少保留 ${Math.round(QR_REFRESH_MS / 1000)} 秒，登录成功后这里会变成 ✅。</p>
</div><script>
let rev = null
async function tick(){
  let s
  try { s = await (await fetch('/status',{cache:'no-store'})).json() }
  catch { document.getElementById('meta').textContent = '本地服务已断开'; return }
  if (s.loggedIn){
    document.body.classList.add('ok')
    document.getElementById('hint').textContent = '✅ 登录成功，回到 DSH 会话继续即可'
    document.getElementById('qrbox').style.display = 'none'
    document.getElementById('meta').textContent = s.unb ? ('账号 ID: ' + s.unb) : ''
    return
  }
  if (s.rev && s.rev !== rev){ rev = s.rev; document.getElementById('qr').src = '/qr.png?r=' + rev }
  document.getElementById('meta').textContent = s.error ? ('错误: ' + s.error)
    : (s.updatedAt ? ('二维码更新于 ' + new Date(s.updatedAt).toLocaleTimeString()) : '正在获取二维码…')
}
tick(); setInterval(tick, 3000)
</script></body></html>`

async function watchTick() {
  let cdp
  try {
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
      return
    }
    await ensureLoginPage(cdp)
    const qr = await captureQr(cdp)
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
    } else if (!state.png) {
      state.error = '二维码还没渲染出来'
    }
  } catch (e) {
    state.error = String(e?.message ?? e)
  } finally {
    cdp?.close()
  }
}

async function cmdServe() {
  await ensureChrome()
  await watchTick()
  setInterval(watchTick, 3000)

  const server = createServer((req, res) => {
    const path = (req.url || '/').split('?')[0]
    if (path === '/status') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({
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

const commands = { start: cmdStart, status: cmdStatus, qr: cmdQr, search: cmdSearch, serve: cmdServe, stop: async () => say({ stopped: await stopChrome() }) }

try {
  const fn = commands[cmd]
  if (!fn) {
    console.log('用法: node tb.mjs <start|status|qr|search|serve|stop> [参数]')
    process.exit(2)
  }
  await fn()
  if (cmd !== 'serve') process.exit(0)
} catch (e) {
  console.error('ERROR: ' + (e?.stack ?? e))
  process.exit(1)
}
