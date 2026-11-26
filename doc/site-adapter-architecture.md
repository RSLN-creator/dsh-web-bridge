# Site adapter architecture and acceptance

## Purpose

Keep website-specific facts together and make the bridge's shared engines independent of frontend
frameworks. The goal is not to detect React, Vue or Svelte. The goal is to adapt the observable
contracts that matter: login, DOM semantics, model selection, request transport, response decoding,
attachments and conversation identity.

## Current layout

`lib/sites/index.js` is the single registry. Its 11 entries map to one file each:

`deepseek`, `glm`, `chatgpt`, `kimi`, `qwen`, `doubao`, `grok`, `claude`,
`gemini`, `zai`, `zai-cn`.

A site module owns its facts: origin, selectors, login evidence, model list, decoder family, supported
capabilities, verified navigation rules and prompt-format metadata. `providers.js` assembles those
declarations into the public provider/model view. It is not a second site registry.

## Shared versus site-specific

| Concern | Owner |
| --- | --- |
| Origin, visible composer/login selectors, login evidence | Site adapter |
| Model labels, model-switch UI contract, image support | Site adapter |
| Decoder family and completion path | Site adapter; common decoder implementation |
| Verified conversation URL parsing/building | Site adapter navigation capability |
| Tool-call format and prompt teaching choice | Site adapter teaching capability |
| Browser lifecycle, Playwright actions, pacing and retry | Shared browser driver |
| SSE framing and decoder implementations | Shared decoder engine |
| Tool protocol normalization and permission execution | Shared protocol + native DSH execution |
| Browser-client slots and mount lifecycle | DSH official client module framework |

Do not duplicate the browser driver, decoder, prompt serializer or permission system per website.
Do not infer a site capability from its frontend framework or an unverified DOM guess.

## Session lifetimes

A DSH agent session, the plugin's browser profile and the website's own conversation are different
records:

- DSH persists messages and tool history under its session ID.
- The browser profile persists website authentication.
- The website conversation ID identifies the remote chat to resume.

Restarting a terminal or DSH process can restore the first record without recreating the third.
The plugin's session cursor links the DSH session to the website conversation, and the persistent
browser profile keeps the login cookies. If the remote conversation cannot be safely resumed, the
bridge must report it; it must not silently claim continuity.

## Evaluation cycles

### Cycle 1 — DSH Web framework

Acceptance gates: valid `dsh.client.platform`, real package-name `dsh.client.inject` values,
exported `./client`, lazy module-loader factory, and valid DSH slot-owner dependencies. The
automated manifest and client/server contract test must pass; the live Web UI check confirms the
plugin appears, slots mount and the account/settings views render.

### Cycle 2 — all website adapters

Acceptance gates:

1. `migratedSiteIds()` exactly matches `SITES.map(site => site.id)`.
2. `provider-surface.test.mjs` preserves provider IDs, model IDs/order, group labels, aliases and
   image capability results.
3. Each declared navigation capability has parse/build round-trip coverage; an unsupported site
   remains explicitly unsupported.
4. Prompt-format choices come from adapter data; existing prompt baseline tests prove the rendered
   text has not drifted.
5. Each change to login evidence, selector or network capability has a unit/fixture guard plus a
   manual live check before release.

The test suite validates code and fixtures; it cannot prove a live site has not introduced a new
anti-bot page or changed server behavior. Live checks must be paced, sequential and limited according
to `doc/verify.md` and `doc/PROJECT-INTENT.md`.

## Honest maintenance boundary

A CSS framework or SPA framework change alone should not require a site-specific code change when
accessible DOM semantics and network contracts remain stable. A change to authentication, DOM
semantics, network endpoints, event-stream schema, rate limits or conversation IDs may require an
adapter update. No client-side bridge can guarantee zero maintenance against those external changes.

## Pending work

- Complete remote QR capture and display with a real browser/Web-client acceptance run.
- Move remaining evidenced site-only behavior branches into adapter capabilities where doing so
  preserves the existing public behavior.
- Keep DSH session resume, browser profile persistence and website conversation continuity explicitly
  separate in tests and diagnostics.
