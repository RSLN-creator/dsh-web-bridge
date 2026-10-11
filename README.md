# Harness Web Bridge

**English** · [中文](README.zh-CN.md)

Use your logged-in web AI — DeepSeek, GLM (Z.ai), Kimi, Qwen, Doubao — as model providers inside
[DeepSeek Harness](https://github.com/RSLN-creator/dsh-web-bridge). Web models emit tool calls, DSH
executes them under its native permission and approval system, and the results go back into the same
web session.

**No API keys.** It drives the site through your own browser login.

```
dsh plugin --profile web add dsh-webcode-bridge
```

---

## Why

Most "web model" integrations are fragile in the same three ways: they scrape HTML, they lose the
conversation when the page reloads, and they bypass the host's tool permissions. This plugin is
built the other way around:

| Concern | How it is handled |
| --- | --- |
| **Tool permissions** | The web model only *proposes* calls. DSH runs them with its own permission and approval system — the bridge cannot bypass it. |
| **Session continuity** | A per-session cursor keeps the web conversation alive across turns, across restarts, and after history rewrites. When the web session is lost the bridge replays the full first turn instead of silently starting over. |
| **Long prompts** | Over-threshold bodies are delivered as a file attachment, bypassing the composer's write-stall and truncation limits, with an automatic fallback to plain text if any step fails. |
| **Rate limits** | A configurable send gap (global **and per site**) plus automatic backoff-and-retry on the site's own rate-limit response. |

## Features

- **Real site rendering in the DSH right sidebar.** Not a screenshot, not a mock — the actual site,
  loaded through a same-origin mirror so you can type, scroll and click in it. Login state persists.
- **Per-site protocol teaching.** Each site is taught the tool-call shape it actually accepts
  (DeepSeek's native token format, GLM's ```json code block, `<tool_call>` tags elsewhere). The
  protocol is recomputed from the live tool list every time, so it never drifts.
- **Per-site and global settings.** Model, instruction, send gap and prompt-delivery mode can each
  be set globally *and* overridden for a single site — changing one site never disturbs the others.
- **Multi-account.** One site can hold several independent logins; each gets its own browser profile
  and its own request pacing.
- **Observable.** Every delivery, fallback and rate-limit event is projected into
  `GET /__webcode/status`, so "did it actually work" is answerable from the UI instead of from logs.

## Requirements

| | |
| --- | --- |
| Node.js | **22.13 or newer** |
| DeepSeek Harness | **0.1.0-rc.6 or newer** |
| Browser | None to install — the plugin ships its own Chromium (Playwright). A system browser is used only as a fallback. |

## Install

### From npm (recommended)

```powershell
dsh plugin --profile web add dsh-webcode-bridge
```

### From a release tarball

Download `dsh-webcode-bridge-<version>.tgz` from
[Releases](https://github.com/RSLN-creator/dsh-web-bridge/releases), then:

```powershell
dsh plugin --profile web add C:\path\to\dsh-webcode-bridge-<version>.tgz
```

### From source

```powershell
cd package/dsh-webcode-bridge
pnpm install            # do NOT add --frozen-lockfile, see doc/ci-cd.md
pnpm pack              # produces dsh-webcode-bridge-<version>.tgz
```

> **Restart `dsh web` after installing.** Installing only swaps files on disk; the running process
> still has the old code loaded. This is the single most common "it does not work" report.

### Do not install by repository URL

The plugin lives in the `package/dsh-webcode-bridge` subdirectory of this repository; **the
repository root has no `package.json`**. Pointing `dsh plugin` at the repository therefore finds no
manifest, and the plugin ends up installed as a plain dependency with DSH warning:

```
dsh: warning: dsh-webcode-bridge declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

and the plugin configuration UI shows *"Plain dependency (no dsh metadata declared), not a profile
layer plugin"* (已安装，未生效 / installed but not active). That warning means **the wrong directory
was installed**, not that this package is missing metadata — it does declare `dsh.bundle.patch`
(see `package/dsh-webcode-bridge/package.json`). Install one of these instead:

```powershell
# by package name
dsh plugin --profile web add dsh-webcode-bridge

# or by the package subdirectory / a built tarball
dsh plugin --profile web add https://github.com/RSLN-creator/dsh-web-bridge/tree/main/package/dsh-webcode-bridge
dsh plugin --profile web add C:\path\to\dsh-webcode-bridge-<version>.tgz
```

Nothing needs to be added to the repository root to fix this.

> **This plugin targets the `web` profile.** It declares `dsh.client.platform = "web"` and mounts its
> panel through the DSH web settings UI. Installing it into the `desktop` profile is not supported —
> use `--profile web` as shown above.

## Quick start

1. **Start** — `dsh web`, then open <http://127.0.0.1:3080>.
2. **Sign in to a site** — open the native *Settings → Web Bridge* panel and click **Log in** for the
   site you want. A real browser window opens; once you are signed in it closes and the session is
   reused headlessly from then on. Each site keeps its own login.
3. **Pick a model** — the model picker gains a **Harness Web Bridge** group listing every model from
   every signed-in site. Choose the default for new sessions in Settings.
4. **Use it** — the site appears in the DSH right sidebar (the official
   `@deepseek-ai/dsh-client-ui-sidebar-right` tabs; no third-party sidebar plugin involved). Ask a
   question there and the web model runs with local tools.

Tool calls produced by the web model run on your machine under DSH's normal permission prompts, and
the results are returned to the same web conversation.

## Configuration

All settings live in *Settings → Web Bridge* and can also be edited through the standalone settings
page. Settings are stored per profile.

### Global

| Setting | What it does |
| --- | --- |
| **Default model** | Which model a new session starts on. |
| **Global instruction** | A paragraph appended to the first message of every new web session. |
| **Send gap** | Minimum wait between two sends to the same site. Default basis is *since last send* (protects against send-rate limiting); *since last reply finished* protects against talking too fast. |
| **Prompt delivery** | `Attachment` (default): over-threshold bodies are uploaded as a file. `Plain text`: always write into the composer (the pre-0.16 behaviour). |

### Per site

Each site gets its own tab where you can override, independently of the global value:

- **Account / login** — one row per login on that site, with add/switch.
- **Model** — which model this site should use.
- **Instruction** — an extra instruction that only applies to this site.
- **Send gap** — its own pacing; `Follow global` clears the override.
- **Prompt delivery** — `Follow global` / `Attachment` / `Plain text`.

The fallback chain is always **site override → global → built-in default**, and clearing an override
deletes the key rather than writing a third value — so "never configured" and "configured to follow
global" stay distinguishable in the settings file.

### Environment variables

| Variable | Effect |
| --- | --- |
| `WEBCODE_PROMPT_STORE_DIR` | Where the per-site prompt files are written. `off` disables writing them entirely. Default `~/.dsh/webcode`. |

## Site status

**DeepSeek is the primary target and holds up over long sessions. GLM works but is unstable.**

| Site | Status |
| --- | --- |
| DeepSeek `deepseek:deepseek` | **Primary.** Validated over long multi-turn tool loops on a real browser session, with auto-continue, cursor persistence and recovery from Harness history after a restart. |
| GLM `glm:glm-5.3` / `glm-5.3-flash` | **Usable but unstable.** The end-to-end loop passes on a real session — a random secret that exists only in the tool result is echoed back verbatim. |
| Kimi / Qwen / Doubao / Z.ai | **Wired up, not validated over long runs.** Availability depends on your login. Run the per-site check below to see where your machine stands. |
| Claude | Region-restricted; the site itself says so. |
| ChatGPT / Grok / Gemini | Not reachable from our network (502 plus an explanatory page). |

### Checking a site on your own machine

"Wired up" is not the same as "verified", so there is a per-site acceptance entry point that runs
the same minimum real loop against whichever site you have signed in. It ships in the **source
checkout**, not in the installed package (it is a development tool, like `test-mock/real-verify.mjs`),
so run it from a clone:

```powershell
cd package/dsh-webcode-bridge
node test-mock/site-verify.mjs --list          # every registered site
node test-mock/site-verify.mjs --site kimi     # one site
node test-mock/site-verify.mjs --site kimi --site qwen
```

It reads the login you already have and never signs in or solves a captcha for you. Each check gets
one of four verdicts, and only real pages plus real requests can produce `PASS`:

| Verdict | Meaning |
| --- | --- |
| `PASS` | A real page and a real request support the conclusion. |
| `FAIL` | A real page reproduced a failure (with the readings attached). |
| `BLOCKED` | An external condition got in the way (not signed in, captcha, rate limit) — **not** a product verdict. |
| `UNVERIFIED` | This entry point does not cover that item, so nothing is claimed. |

It covers the minimum loop — login verdict, composer usable, real send, read-back, body in the
stream, tool call parsable, turn settles. It does **not** cover long-run stability, multi-turn tool
convergence, restart recovery, vision upload, or thinking-effort read-back; those need their own
probes. A `--site kimi` run on a fresh empty profile currently reports a login-verdict inconsistency
(the panel can show "signed in" for a site that is not), recorded as long-term issue #53.

What "unstable" means for GLM, concretely:

- **Thinking cannot be turned off**, and it dominates the stream (1051 of 2472 replies were thinking-only).
- **The site intercepts tool-call tags in prose** through its own native tool layer, so GLM is taught
  only the ```json code-block shape, with fallback parsing from the thinking stream.
- **Deep-link navigation is stopped by an Aliyun slider captcha**, so probes go through the driver path.
- Two failure modes have been fixed: a stream that died mid-thinking produced an empty reply, and
  call-fence tails leaked into the reply body as garbage.

Read it as: **DeepSeek is the one to run all day; GLM is a good second opinion.** When GLM fails,
retry — attributable failures surface as coded messages rather than silent degradation.

## How it works

A few design notes worth knowing before you read the source.

### Right sidebar, one origin per site

Each site is served from `http://<siteId>.localhost:8931/`, so the pathname the site sees matches its
real site and SPA routers and root-relative assets work unchanged. The exception is **DeepSeek, which
is always mounted at the relay root** — it validates the hostname, and a subdomain gives a blank
`Unknown hostname` page. `*.localhost` resolves to loopback, so the exposure surface is unchanged.

Sites often load scripts and styles from a *different* origin with `crossorigin`, and that origin's
`Access-Control-Allow-Origin` may be an illegal wildcard (`https://*.deepseek.com`), which browsers
refuse outright. `lib/mirror.js` therefore rewrites those URLs to same-origin `/__static/<host>/…`,
strips `integrity` and `crossorigin`, rewrites the runtime `fetch`/`XHR` calls that target those
origins, and installs an idempotent runtime hook to catch lazily-built chunk URLs.

**Order matters:** rewrite the site HTML first, *then* inject the bootstrap. Reversed, the constants
inside the bootstrap get rewritten too and the runtime comparison never matches. `test/mirror.test.mjs`
locks this in.

### Prompt delivery

Bodies over the threshold go up as an attached `.md` file instead of being typed into the composer,
which sidesteps two measured failure modes: `PROMPT_WRITE_STALLED` (the composer stops growing while
being written) and `PROMPT_TRUNCATED` (the site accepts only half). **Any** failure on that path
falls back to plain text — delivery is an implementation detail, "the message gets sent" is the
contract.

Two sites (DeepSeek, Kimi) have their own lower thresholds because their composers were measured to
truncate earlier than the global default. Sites where upload is confirmed to *not be read* are
downgraded at runtime and remembered.

### Token accounting

Token estimates use three measured densities (0.19.3 onward) — CJK **0.75**, prose ASCII **0.30**,
other ASCII (digits, punctuation, source) **0.70** — plus a 10% margin. The rule is that the estimate
**never understates**; the single source of truth is `TOKEN_DENSITY` in `lib/metrics.js`. Speed
figures are measured from the site's own SSE stream and are kept separate from the estimate.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Nothing appears after installing | **Restart `dsh web`.** Then check that the plugin is listed for the `web` profile. |
| A site shows "not logged in" but you are logged in | The bridge uses its **own** browser profile. Sign in through *Settings → Web Bridge → Log in*, not in your daily browser. |
| Right sidebar is blank for one site | That site's page failed to load. The panel shows a per-site explanation with a retry button rather than raw JSON. |
| "Import login state from this machine" fails | Expected on Edge 128+: cookies are app-bound encrypted (`v20`), so copying a profile cannot decrypt them. Use **Log in** instead. |
| Long prompt was typed instead of attached | Check the **Prompt delivery** setting for that site — a per-site override may be set to `Plain text`. |

`GET /__webcode/status` exposes the live readouts (last delivery, transport mode, session slot,
rate-limit retries, fresh-conversation reasons) — that is the first place to look when the UI is
ambiguous.

## Development

```powershell
cd package/dsh-webcode-bridge
pnpm test              # regression, parsing and Harness adapter contracts
pnpm lint:comments     # comment discipline gate
pnpm ci:local          # full local CI
```

Useful single-file runs:

```powershell
node test/glm-session-replay.test.mjs        # replay a real GLM session shape offline
node test-mock/real-mirror-matrix.mjs        # right-sidebar acceptance matrix, 10 sites
node test-mock/run-real-longrun.mjs          # long real-browser tool loop
node scripts/verify-pack.mjs                 # tarball vs working tree, byte for byte
```

## Documentation

| Document | Contents |
| --- | --- |
| [docs index](doc/README.md) | The authoritative entry point for repository documentation. |
| [progress ledger](doc/progress.md) | Where the project currently stands and what is next. |
| [long-term issues](doc/long-term-issues.md) | Known defects and why they are not fixed yet. |
| [permissions and boundaries](doc/permissions-and-boundaries.md) | Dependencies, permissions, external services and failure boundaries. |
| [settings copy](doc/settings-copy.md) | What every settings label means, and the full explanation behind it. |
| [CI/CD](doc/ci-cd.md) | Build, release and rollback. |

## License

**MIT** — full text in [LICENSE](LICENSE). Third-party notices are kept in
[permissions and boundaries](doc/permissions-and-boundaries.md) rather than in the license body, so
GitHub's license detection reports `MIT` instead of `NOASSERTION`.

SSE decoding protocol references the MIT project
[`three-water666/webcode`](https://github.com/three-water666/webcode).
