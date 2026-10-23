# Harness Web Bridge

Use your logged-in web AI (DeepSeek, GLM / Z.ai, Kimi, Qwen, Doubao) as model providers inside
[DeepSeek Harness](https://github.com/RSLN-creator/dsh-web-bridge). Web models emit tool calls, DSH
executes them under its native permission and approval system, and the results go back into the same
web session.

**No API keys** — it drives the site through your own browser login.

```powershell
dsh plugin --profile web add dsh-webcode-bridge
```

> **Restart `dsh web` after installing.** Installing only swaps files on disk; the running process
> still has the old code loaded. This is the single most common "it does not work" report.

## Status & risks (read this first)

**Status**: this is a **work-in-progress project** — behavior and interfaces can change, and a site
redesign can break any site's channel at any time. **Forks and PRs are welcome** (see the repository
root's CONTRIBUTING.md for the commit-message shape and the local gates).

**Risks — evaluate for yourself before using**:

| Risk | What it means |
| --- | --- |
| **Site ToS / account restriction** | The plugin drives your **logged-in web sessions** with automation, which may violate a site's terms of service; accounts can be rate-limited or restricted — **one of the author's own DeepSeek web accounts has been restricted**. |
| **Tool mode = prompt injection** | With "local tool calling" enabled, the bridge injects tool-protocol teaching into the web conversation; that content is **visible to the site**. |
| **Page redesigns break things** | Every site is "the web page as a backend"; when a site ships a redesign its channel can break. |
| **Data locality** | Login state lives only in the plugin's **local** browser profile; no API keys, no telemetry, no cloud component. |

**Default mode**: tool calling is **off by default** — the bridge is then a pure web session: the
web model receives exactly your words, identical to the browser (no prompt injection, no call
replay). Enable it via **Settings → Web Bridge → Local tool calling** or the "local tools" pill
under the composer; enabling asks for a confirmation first. Tool calls always execute under DSH's
native permission system.

## What it does

- **Real sites in the DSH right sidebar** — not a screenshot, not a mock. The actual site is loaded
  through a same-origin mirror, so you can type, scroll and click in it. Login state persists.
- **Per-site protocol teaching** — each site is taught the tool-call shape it actually accepts
  (DeepSeek's native token format, GLM's fenced ```json code block, `<tool_call>` tags elsewhere),
  recomputed from the live tool list every turn.
- **Global and per-site settings** — model, instruction, send gap and prompt-delivery mode can each
  be set globally *and* overridden for one site, without disturbing the others.
- **Multi-account** — one site can hold several independent logins, each with its own browser profile
  and its own request pacing.
- **Observable** — every delivery, fallback and rate-limit event is projected into
  `GET /__webcode/status`.

## Requirements

| | |
| --- | --- |
| Node.js | 22.13 or newer |
| DeepSeek Harness | 0.1.0-rc.6 or newer |
| Browser | None to install — the plugin ships its own Chromium (Playwright). A system browser is used only as a fallback. |

## Install

### From the npm registry (recommended)

```powershell
dsh plugin --profile web add dsh-webcode-bridge
```

Pin a version with `dsh-webcode-bridge@<version>`.

### From a release tarball

Download `dsh-webcode-bridge-<version>.tgz` from
[Releases](https://github.com/RSLN-creator/dsh-web-bridge/releases), then:

```powershell
dsh plugin --profile web add C:\path\to\dsh-webcode-bridge-<version>.tgz
```

### From source

```powershell
pnpm install            # do NOT add --frozen-lockfile, see ../../doc/ci-cd.md
pnpm pack              # produces dsh-webcode-bridge-<version>.tgz
```

Two local helper scripts exist for troubleshooting only: `scripts/verify-pack.mjs` compares the
packed tarball against the working tree file by file, and `scripts/install-profiles.mjs` removes the
old directory before unpacking (which avoids pnpm's "Already up to date" shortcut on a same-version
tarball). Both encode a bug that actually happened.

## Site status

**DeepSeek is the primary target and holds up over long sessions. GLM works, but it is unstable.**

| Site | Status |
| --- | --- |
| DeepSeek `deepseek:deepseek` | Primary. Validated over long multi-turn tool loops on a real browser session, with auto-continue, session-cursor persistence, and recovery from Harness history after a restart. |
| GLM `glm:glm-5.3` / `glm-5.3-flash` | Usable but unstable. The end-to-end tool loop passes on a real session: a random secret present only in the tool result is echoed back verbatim by the model, so the round-trip is genuinely live. |
| Kimi / Qwen / Doubao / Z.ai | Wired up, not validated over long runs. Availability depends on your login state. |
| Claude | Region-restricted; the site says so itself. |
| ChatGPT / Grok / Gemini | Not reachable from our network (502 plus an explanatory page). |

What "unstable" means for GLM, concretely:

- **Thinking cannot be turned off**, and it dominates the stream (1051 of 2472 replies were thinking-only).
- **The site intercepts tool-call tags in prose** through its own native tool layer, so GLM is taught only the fenced code-block shape, with fallback parsing from the thinking stream.
- **Deep-link navigation is stopped by an Aliyun slider captcha**, so probes go through the driver path instead.
- Two failure modes have been fixed and are worth knowing: a stream that died mid-thinking produced an empty reply, and call-fence tails leaked into the reply body as garbage.

Read it as: **DeepSeek is the one to run all day; GLM is a good second opinion.** When GLM fails,
retry — attributable failures surface as coded messages rather than silent degradation.

## Documentation

The full documentation lives in the repository:

| Document | Contents |
| --- | --- |
| [README](../../README.md) | Project overview, install, configuration and troubleshooting. |
| [docs index](../../doc/README.md) | The authoritative entry point for repository documentation. |
| [progress ledger](../../doc/progress.md) | Where the project currently stands and what is next. |
| [long-term issues](../../doc/long-term-issues.md) | Known defects and why they are not fixed yet. |
| [permissions and boundaries](../../doc/permissions-and-boundaries.md) | Dependencies, permissions, external services and failure boundaries. |
| [settings copy](../../doc/settings-copy.md) | What every settings label means, and the full explanation behind it. |
| [CI/CD](../../doc/ci-cd.md) | Build, release and rollback. |
| [CHANGELOG](CHANGELOG.md) | Release history for this package. |

## License

**MIT** — full text in [LICENSE](LICENSE). Third-party notices are kept in
[permissions and boundaries](../../doc/permissions-and-boundaries.md) rather than in the license
body, so GitHub's license detection reports `MIT` instead of `NOASSERTION`.

SSE decoding protocol references the MIT project
[`three-water666/webcode`](https://github.com/three-water666/webcode).
