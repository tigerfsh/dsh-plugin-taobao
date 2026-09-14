/**
 * Taobao product search and QR-code login for DeepSeek Harness.
 *
 * The browser work (a long-lived headful Chrome plus the DevTools-Protocol driver) ships with
 * this package as `lib/engine.mjs` + `lib/cli.mjs`, spawned as a child process; the plugin
 * itself is only the model-facing surface over it. Two behaviours matter:
 *
 * - `taobao_search` never dead-ends on a logged-out session. It detects the missing login,
 *   starts the QR page, and returns the URL to scan instead of failing the call.
 * - Login state lives in the Chrome profile directory under `dataDir`, so it survives both the
 *   browser and the harness restarting, and never sits inside the installed package; the plugin
 *   stores no credential itself.
 *
 * @module @fushouhai/dsh-plugin-taobao
 */
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

export const Config = z.object({
  cliPath: z.string().default(DEFAULT_CLI),
  dataDir: z.string().default(DEFAULT_DATA_DIR),
  qrBaseUrl: z.string().default('http://127.0.0.1:3099'),
  cliTimeoutMs: z.number().default(180000),
  qrRefreshMs: z.number().default(60000),
})

/** The child CLI owns the Chrome profile, so it must agree with the plugin on where state lives. */
function cliEnv(config) {
  return {
    ...process.env,
    TB_DATA_DIR: config.dataDir,
    TB_QR_REFRESH_MS: String(config.qrRefreshMs),
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

/**
 * Make sure the live QR page is up. The page re-reads the login page every few seconds, so
 * Taobao rotating the QR does not require the user to reload anything.
 */
async function ensureQrPage(config) {
  const base = config.qrBaseUrl.replace(/\/$/, '')
  if (await qrStatus(base)) return { base, started: false }

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
  const qr = await runCli(config, ['qr'])
  const status = await qrStatus(page.base)
  return {
    loggedIn: false,
    qrUrl: `${page.base}/`,
    qrPayload: String(qr?.payload ?? ''),
    qrFile: String(qr?.file ?? ''),
    sessionUrl: String(state?.url ?? ''),
    pageLive: status !== null,
    pageStarted: page.started,
  }
}

const LOGIN_HINT =
  '未登录。请打开 qrUrl 用手机淘宝扫码（页面会每几秒自动刷新二维码，失效也不用管）。' +
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
        const state = await sessionState(config)
        const unb = state?.unb === null || state?.unb === undefined ? '' : String(state.unb)
        return {
          loggedIn: Boolean(state?.loggedIn),
          unb,
          url: String(state?.url ?? ''),
          summary: state?.loggedIn
            ? `淘宝已登录（unb=${unb}），当前页面 ${state?.url ?? ''}`
            : `淘宝未登录，当前页面 ${state?.url ?? ''}。调用 taobao_login 获取二维码。`,
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
        const state = await sessionState(config)
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
          summary:
            `需要扫码登录。用手机淘宝打开：${login.qrUrl}\n` +
            `（二维码 PNG 也写到了 ${login.qrFile}）\n` +
            `页面实时刷新，失效会自动换新；手机确认后调用 taobao_session 确认。`,
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

        const state = await sessionState(config)
        if (!state?.loggedIn) {
          const login = await loginRequired(config, state)
          return {
            loggedIn: false,
            needLogin: true,
            query,
            count: 0,
            qrUrl: login.qrUrl,
            items: [],
            summary: `${LOGIN_HINT}\n二维码页面：${login.qrUrl}`,
          }
        }

        const result = await runCli(config, ['search', query])
        const items = toItems(result?.items)
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
