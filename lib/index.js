/**
 * Taobao product search and QR-code login for DeepSeek Harness.
 *
 * The browser work (a long-lived headful Chrome plus the DevTools-Protocol driver) ships with
 * this package as `lib/engine.mjs` + `lib/cli.mjs`, spawned as a child process; the plugin
 * itself is only the model-facing surface over it. Three behaviours matter:
 *
 * - `taobao_search` never dead-ends on a logged-out session. It detects the missing login,
 *   starts the QR page, and returns the URL to scan instead of failing the call.
 * - The driven window is parked out of the way (see `windowMode`) and Chrome is closed once the
 *   session has been idle for `idleCloseMs` — the browser is machinery, and the QR is re-served
 *   on a local page, so neither the user nor the search ever needs to see it.
 * - Login state lives in the Chrome profile directory under `dataDir`, so it survives both the
 *   browser and the harness restarting, and never sits inside the installed package; the plugin
 *   stores no credential itself. That is also why closing Chrome after a search costs nothing
 *   but a restart: the next call reuses the same profile and does not ask for a new scan.
 *
 * @module @fushouhai/dsh-plugin-taobao
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const execFileAsync = promisify(execFile)

export const name = 'plugin-taobao'
export const inject = ['tools']

/** The browser engine ships with this package, so a deployment needs no path configuration. */
const DEFAULT_CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url))
/** Beside the harness home, not beside the code: a reinstall must not touch login state. */
const DEFAULT_DATA_DIR = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'taobao')
/** Markers the QR page reports, so a leftover page from another release can be told apart. */
const SERVICE = 'dsh-plugin-taobao'
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

export const Config = z.object({
  cliPath: z.string().default(DEFAULT_CLI),
  dataDir: z.string().default(DEFAULT_DATA_DIR),
  qrBaseUrl: z.string().default('http://127.0.0.1:3099'),
  cliTimeoutMs: z.number().default(180000),
  qrRefreshMs: z.number().default(60000),
  // `minimized` keeps the driven Chrome window out of the way — the QR is re-served on the local
  // page and searches only read the DOM, so nothing is lost by parking it. Only a slider challenge
  // needs a human eye, and the engine puts the window back in front by itself when one appears.
  windowMode: z.union([z.const('minimized'), z.const('normal')]).default('minimized'),
  // Close Chrome after this long without a Taobao call. Login lives in the Chrome profile, so the
  // next call just starts the browser again — no re-scan. 0 keeps it running.
  idleCloseMs: z.number().default(300000),
})

/** The child CLI owns the Chrome profile, so it must agree with the plugin on where state lives. */
function cliEnv(config) {
  return {
    ...process.env,
    TB_DATA_DIR: config.dataDir,
    TB_QR_REFRESH_MS: String(config.qrRefreshMs),
    TB_WINDOW_MODE: config.windowMode,
  }
}

/** Run one one-shot `tb` command and parse its JSON report. */
async function runCli(config, args, timeoutMs = config.cliTimeoutMs) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [config.cliPath, ...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      env: cliEnv(config),
    })
    return JSON.parse(stdout)
  } catch (error) {
    const stderr = String(error?.stderr ?? '').trim()
    const stdout = String(error?.stdout ?? '').trim()
    throw new Error(`tb ${args.join(' ')} failed: ${stderr || stdout || error?.message || 'unknown error'}`)
  }
}

async function qrStatus(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/status`, {
      signal: AbortSignal.timeout(2500),
    })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

/** Whether a `/status` body came from a Taobao QR page. Releases before 0.1.1 carry no marker. */
function isQrPage(body) {
  return Boolean(body) && typeof body === 'object' && 'loggedIn' in body && 'rev' in body && 'updatedAt' in body
}

/**
 * The code fingerprint a freshly spawned page would report. `version` alone cannot detect a stale
 * page under a `link:` install, where edits keep the same version string. Null when the files
 * cannot be read, in which case the version and dataDir are trusted on their own.
 */
function pageCodeId(cliPath) {
  try {
    return createHash('sha1')
      .update(readFileSync(cliPath))
      .update(readFileSync(join(dirname(cliPath), 'engine.mjs')))
      .digest('hex')
      .slice(0, 12)
  } catch { return null }
}

/** One line about where the driven Chrome window went, so a summary can say it out loud. */
function windowNote(state) {
  if (state?.window === 'minimized') return '，淘宝浏览器窗口已最小化在后台'
  if (state?.windowMode === 'normal') return '，淘宝浏览器窗口保持可见'
  return ''
}

/**
 * The pid of the `cli.mjs serve` child answering on `port`, for a page old enough not to report its
 * own. Ownership is established from the process environment rather than from the port alone, so
 * this cannot pick up an unrelated service that happens to be listening there.
 */
function servePidOnPort(port) {
  if (process.platform !== 'linux') return null
  let entries
  try { entries = readdirSync('/proc') } catch { return null }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cmd = readFileSync(`/proc/${entry}/cmdline`, 'utf8')
      if (!cmd.includes('cli.mjs') || !cmd.includes('serve')) continue
      const env = readFileSync(`/proc/${entry}/environ`, 'utf8')
      const declared = /(?:^|\0)TB_HTTP_PORT=(\d+)(?:\0|$)/.exec(env)
      if ((declared ? Number(declared[1]) : 3099) === port) return Number(entry)
    } catch { continue }
  }
  return null
}

/** Wait for the QR page on `base` to stop answering. */
async function waitForGone(base, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    await delay(100)
    if (!(await qrStatus(base))) return true
  }
  return false
}

/**
 * Make sure the live QR page is up. The page re-reads the login page every few seconds, so
 * Taobao rotating the QR does not require the user to reload anything.
 *
 * The page is spawned detached so that it survives the harness, which also means an upgrade does
 * not replace it: the old process keeps the port and keeps serving its own stale code. Reusing
 * whatever answers would make every fix to that page silently ineffective, so check who is there
 * and replace a page that is foreign or from another release.
 */
async function ensureQrPage(config) {
  const base = config.qrBaseUrl.replace(/\/$/, '')
  const live = await qrStatus(base)
  const wantCode = pageCodeId(config.cliPath)
  if (
    live?.service === SERVICE && live.version === VERSION && live.dataDir === config.dataDir &&
    (!wantCode || live.codeId === wantCode)
  ) {
    return { base, started: false }
  }
  if (live) {
    if (!isQrPage(live)) {
      throw new Error(`${base} answers but is not a Taobao QR page; point qrBaseUrl at a free port`)
    }
    const pid = Number(live.pid) || servePidOnPort(Number(new URL(base).port) || 80)
    if (!pid) {
      throw new Error(`a stale Taobao QR page holds ${base} and its pid is unknown; kill the "cli.mjs serve" process and retry`)
    }
    try { process.kill(pid, 'SIGTERM') } catch {}
    await waitForGone(base)
  }

  const child = spawn(process.execPath, [config.cliPath, 'serve'], {
    detached: true,
    stdio: 'ignore',
    env: cliEnv(config),
  })
  child.unref()

  for (let attempt = 0; attempt < 40; attempt++) {
    await delay(500)
    if (await qrStatus(base)) return { base, started: true, pid: child.pid }
  }
  throw new Error('the Taobao QR page did not start; check the tb serve process')
}

/** Browser up + login state, in one call. */
async function sessionState(config) {
  await runCli(config, ['start'])
  return await runCli(config, ['status'])
}

/** The shared "you need to scan" payload, so search and login answer identically. */
async function loginRequired(config, state) {
  const page = await ensureQrPage(config)
  let qr = null
  let qrError = ''
  try {
    qr = await runCli(config, ['qr'])
  } catch (error) {
    // The expected failure is a risk-control challenge on the login page: the browser window has
    // already been brought to the front for the user, so say that instead of failing the call.
    qrError = String(error?.message ?? error)
      .split('\n')[0]
      .replace(/^tb qr failed:\s*(ERROR:\s*)?(Error:\s*)?/, '')
  }
  const status = await qrStatus(page.base)
  return {
    loggedIn: false,
    qrUrl: `${page.base}/`,
    qrPayload: String(qr?.payload ?? ''),
    qrFile: String(qr?.file ?? ''),
    sessionUrl: String(state?.url ?? ''),
    pageLive: status !== null,
    pageStarted: page.started,
    qrError,
  }
}

const LOGIN_HINT =
  '未登录。请打开 qrUrl 用手机淘宝扫码（页面会每几秒自动刷新二维码，失效也不用管；' +
  '淘宝那个浏览器窗口会被自动最小化，不会挡住 DSH 页面）。' +
  '扫码并在手机上确认后，再调用一次即可。'

const itemSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    price: { type: 'string', required: true },
    sales: { type: 'string', required: true },
    shop: { type: 'string', required: true },
    url: { type: 'string', required: true },
  },
}

/** `tb` returns nulls and numbers; the model-facing value keeps one flat, predictable shape. */
function toItems(raw) {
  return (Array.isArray(raw) ? raw : []).map((item) => ({
    title: String(item?.title ?? ''),
    price: item?.price === null || item?.price === undefined ? '' : String(item.price),
    sales: String(item?.sales ?? ''),
    shop: String(item?.shop ?? ''),
    url: String(item?.url ?? ''),
  }))
}

function formatItems(items, limit = 25) {
  const lines = items.slice(0, limit).map((item, index) => {
    const price = item.price === '' ? '?' : `¥${item.price}`
    const sales = item.sales === '' ? '' : ` | ${item.sales}`
    const shop = item.shop === '' ? '' : ` | ${item.shop}`
    return `${index + 1}. ${item.title}\n   ${price}${sales}${shop}\n   ${item.url}`
  })
  const more = items.length > limit ? `\n…另有 ${items.length - limit} 条` : ''
  return lines.join('\n') + more
}

export function apply(ctx, config) {
  /**
   * Closing Chrome when nobody is using it is what makes this plugin cheap to leave installed:
   * the login lives in the Chrome profile directory, not in the browser process, so the next call
   * simply starts Chrome again over the same profile — no re-scan. The timer is only ever armed on
   * a logged-in session: closing the browser out from under a QR nobody has scanned yet would
   * throw the login page away.
   */
  let idleTimer = null
  ctx.effect(() => () => { if (idleTimer) clearTimeout(idleTimer) }, 'taobao idle close')

  function armIdleClose(loggedIn) {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    if (!loggedIn || !(config.idleCloseMs > 0)) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      runCli(config, ['stop'], 30000).catch(() => {})
    }, config.idleCloseMs)
    idleTimer.unref?.()
  }

  /** Browser up + login state, with the idle clock restarted from this call. */
  async function session() {
    const state = await sessionState(config)
    armIdleClose(Boolean(state?.loggedIn))
    return state
  }

  ctx.tools.register(
    defineTool({
      name: 'taobao_session',
      description:
        'Report the Taobao browser-session state: whether Chrome is running, whether the account is ' +
        'logged in, the numeric user id, and the current page. Read-only; use it to check login before ' +
        'a search or to confirm that a scan succeeded.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            loggedIn: { type: 'boolean', required: true },
            unb: { type: 'string', required: true },
            url: { type: 'string', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute() {
        const state = await session()
        const unb = state?.unb === null || state?.unb === undefined ? '' : String(state.unb)
        return {
          loggedIn: Boolean(state?.loggedIn),
          unb,
          url: String(state?.url ?? ''),
          summary: state?.loggedIn
            ? `淘宝已登录（unb=${unb}），当前页面 ${state?.url ?? ''}${windowNote(state)}`
            : `淘宝未登录，当前页面 ${state?.url ?? ''}${windowNote(state)}。调用 taobao_login 获取二维码。`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'taobao_login',
      description:
        'Start the Taobao QR-code login and return the URL of a live page showing the QR. Use it when ' +
        'the user wants to log in, or after any Taobao call reports that login is required. If the ' +
        'account is already logged in it returns that immediately and shows no QR.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            loggedIn: { type: 'boolean', required: true },
            qrUrl: { type: 'string', required: true },
            qrPayload: { type: 'string', required: true },
            qrFile: { type: 'string', required: true },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute() {
        const state = await session()
        if (state?.loggedIn) {
          return {
            loggedIn: true,
            qrUrl: '',
            qrPayload: '',
            qrFile: '',
            summary: `淘宝已登录（unb=${state.unb}），无需扫码。`,
          }
        }
        const login = await loginRequired(config, state)
        return {
          loggedIn: false,
          qrUrl: login.qrUrl,
          qrPayload: login.qrPayload,
          qrFile: login.qrFile,
          summary: login.qrError
            ? `淘宝要求人工处理（${login.qrError}），已把淘宝浏览器窗口调到最前，处理完再调用一次。`
            : `需要扫码登录。用手机淘宝打开：${login.qrUrl}\n` +
              `（二维码 PNG 也写到了 ${login.qrFile}）\n` +
              `页面实时刷新，失效会自动换新；淘宝那个浏览器窗口会自动最小化，不会挡住 DSH。\n` +
              `手机确认后调用 taobao_session 确认。`,
        }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'taobao_search',
      description:
        'Search Taobao/Tmall products and return titles, prices, sales counts, shops and item URLs. ' +
        'Use it for 商品搜索 / 商品调研 / 比价. If the session is not logged in it does NOT fail: it ' +
        'starts the QR login page and returns the URL to scan, so the next call succeeds.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'The search keywords, e.g. "蓝牙耳机".',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            loggedIn: { type: 'boolean', required: true },
            needLogin: { type: 'boolean', required: true },
            query: { type: 'string', required: true },
            count: { type: 'number', required: true },
            qrUrl: { type: 'string', required: true },
            items: { type: 'array', required: true, items: itemSchema },
            summary: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        const query = String(args?.query ?? '').trim()
        if (query === '') throw new Error('query must be a non-empty string')

        const state = await session()
        if (!state?.loggedIn) {
          const login = await loginRequired(config, state)
          return {
            loggedIn: false,
            needLogin: true,
            query,
            count: 0,
            qrUrl: login.qrUrl,
            items: [],
            summary: login.qrError
              ? `淘宝要求人工处理（${login.qrError}），已把淘宝浏览器窗口调到最前，处理完再重试。`
              : `${LOGIN_HINT}\n二维码页面：${login.qrUrl}`,
          }
        }

        const result = await runCli(config, ['search', query])
        const items = toItems(result?.items)
        // A challenge is the one case where the browser window has to be in front of the user, and
        // the engine has already put it there; say so instead of reporting an empty result set.
        if (result?.challenge) {
          // Never close the browser while a human is mid-slider: disarmed until a call succeeds.
          armIdleClose(false)
          return {
            loggedIn: true,
            needLogin: false,
            query,
            count: 0,
            qrUrl: '',
            items: [],
            summary:
              `淘宝对「${query}」返回了人工验证（${String(result.challenge).slice(0, 60)}），` +
              `已把淘宝浏览器窗口调到最前，请在窗口里完成验证后重试。`,
          }
        }
        armIdleClose(true)
        return {
          loggedIn: true,
          needLogin: false,
          query,
          count: items.length,
          qrUrl: '',
          items,
          summary:
            `淘宝「${query}」共取到 ${items.length} 条结果：\n\n` + formatItems(items),
        }
      },
    }),
  )
}
