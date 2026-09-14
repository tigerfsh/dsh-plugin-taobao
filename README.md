# dsh-plugin-taobao

Taobao/Tmall product search with QR-code login, as tools for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Chinese e-commerce sites gate search behind a login wall, so an agent that tries to browse them
gets an empty result page instead of products. This plugin keeps a long-lived browser session and,
when that session is not logged in, hands back a QR-code URL for you to scan — it never dead-ends
the agent on an auth wall.

## Tools

| Tool | Purpose |
|---|---|
| `taobao_search` | Search Taobao/Tmall; returns titles, prices, sales counts, shops and item URLs. |
| `taobao_login` | Start the QR login and return the URL of a page showing the code. |
| `taobao_session` | Read-only: is the browser up, is the account logged in, which page is open. |

If the session is not logged in, `taobao_search` still succeeds: it returns
`needLogin: true` plus `qrUrl`, and the next call works once you have scanned.

## Requirements

- Node.js >= 22 (the browser driver uses the built-in `fetch` and `WebSocket`).
- A Chrome/Chromium binary. Defaults to `/usr/bin/google-chrome`; override with `$TB_CHROME`.
- A graphical display for the first login. With `$DISPLAY` set the browser runs headful, which is
  what you want: if Taobao shows a slider or risk-control challenge, you can solve it by hand.

## Install

```sh
dsh plugin --profile web add @fushouhai/dsh-plugin-taobao
```

Nothing needs to be built: `lib/` is the source, `package.json` declares no `scripts`, and the
shipped files are exactly what `files` lists.

The package declares `dsh.bundle`, so the install registers `tool-taobao` under
`dsh.profile.bundles` and the tools appear after the next restart of the harness. Reconciliation
runs against installed state, so `remove` takes the layer back out again. `dsh plugin` is a thin
pnpm forwarder that runs inside the profile directory, so any pnpm argument works (`add`, `remove`,
`why`, `update`).

The DSH core packages are optional `peerDependencies`: the launcher already exposes them to
out-of-tree plugins through its own module fallback, and they are marked optional so the installer
does not pull a second copy of the harness's own packages into the profile. Note that the public
`latest` tag of `@deepseek-ai/dsh-tools` can lag the installed harness — use the matching channel.

### From a checkout

A path spec installs as a `link:`, so local edits take effect immediately — the route to use while
hacking on the plugin. pnpm does not install a linked package's dependencies, so the checkout needs
its own `npm install` first; without it the harness cannot load the plugin and reports
`ERR_MODULE_NOT_FOUND: @deepseek-ai/schemastery`.

```sh
cd /path/to/dsh-plugin-taobao && npm install
dsh plugin --profile web add /path/to/dsh-plugin-taobao
# relative paths are anchored to where you ran dsh, not to the profile
dsh plugin --profile web add ../dsh-plugin-taobao
```

### From git

Install straight from GitHub, with no checkout. Use this to pin a ref or to try an unreleased
commit.

```sh
dsh plugin --profile web add github:tigerfsh/dsh-plugin-taobao
# the same over SSH, if the repository is private or HTTPS is blocked
dsh plugin --profile web add git+ssh://git@github.com:tigerfsh/dsh-plugin-taobao.git
# pin a branch, tag or commit
dsh plugin --profile web add github:tigerfsh/dsh-plugin-taobao#main
```

The `allowBuilds` prompt pnpm raises for git-hosted plugins does not apply here, for the same
reason nothing needs to be built.

Mounting the row by hand is the other route, and the one to use when you want to set `cliPath` or
`dataDir` in the same place; see [Configuration](#configuration). Use only one of the two routes.

## Configuration

Every field has a working default; an unconfigured mount is the normal case.

| Field | Default | Meaning |
|---|---|---|
| `cliPath` | the bundled `lib/cli.mjs` | The browser engine to spawn. |
| `dataDir` | `$DSH_HOME/taobao` | Where the Chrome profile and run files live. |
| `qrBaseUrl` | `http://127.0.0.1:3099` | Local page showing the current QR code. |
| `cliTimeoutMs` | `180000` | Per-command timeout; the first launch is the slow one. |
| `qrRefreshMs` | `60000` | Shortest interval before the shown QR may be replaced, and between forced navigations to the login page. |

To mount the row by hand instead of through `dsh.profile.bundles`, after adding the dependency:

```yaml
- insert:
    - id: tool-taobao
      name: '@fushouhai/dsh-plugin-taobao'
```

To override a field, address the row from the same patch layer
(`$DSH_HOME/profiles/<profile>/cordis.patch.yml`):

```yaml
- id: tool-taobao
  config:
    dataDir: /some/other/place
```

Mount it from exactly one layer. The loader throws `duplicate loader entry id: tool-taobao` at boot
if the same id is declared twice, so do not both list the package under `dsh.profile.bundles` and
insert the row by hand.

## How login state works

Login lives in the Chrome profile directory under `dataDir`, not in this package and not in the
harness. It therefore survives browser restarts and harness restarts, and reinstalling or upgrading
the plugin never touches it. It does expire after days or weeks; when it does, `taobao_search`
returns the QR again and you re-scan.

The QR itself is decoded from the login page canvas and re-served as a live local page. The capture
loop runs every few seconds, but `qrRefreshMs` throttles two things. The served image is held that
long before another code may replace it — Taobao issues a new code only every couple of minutes, so
a re-decode that disagrees is usually capture noise. Forced navigation to the login page is capped
at the same interval: a half-authenticated session makes Taobao bounce the page away to the
logged-in home page, and re-navigating on every poll would paint a fresh QR each time and flicker
the image out from under you.

## Please read before using this against real accounts

Automating Taobao is against its user agreement. This plugin drives a real logged-in browser
session and reads search-result pages, which is indistinguishable from a very polite human
browsing slowly. Keep it that way:

- Low frequency, one search at a time. Bulk crawling is what gets accounts restricted or banned.
- Prefer an account you can afford to lose over your primary one.
- Taobao's risk control may still present a slider (`x5sec` / `_____tmd_____`) after a scan. With a
  display attached you can solve it manually; in headless mode you cannot.

For anything commercial or at scale, use the official open platforms instead — 淘宝开放平台 /
阿里妈妈淘宝客, 京东联盟, 拼多多开放平台 — which exist precisely so this is not necessary.

## License

MIT
