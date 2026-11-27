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
| Measured attachment inline ceilings and composer hard ceilings | Site adapter `limits`; shared driver derives compatibility snapshots |
The read-only prompt variant catalogue in `lib/prompt-variants.js` derives membership from
the adapter's `teaching.toolCallFormat` and `teaching.skillCatalogMode`; it does not maintain a
second site-ID allow/exclude list. If an adapter declares a new teaching profile, the shared
preview requires a reviewed variant definition before that profile can be used. Each site row is
serialized again with that adapter's own `siteId` and `sitePrompt`, so a shared protocol profile
does not copy another site's local instructions into its preview.

| Search-toggle and strict request-metadata verification | Site adapter contract metadata; shared projection |
| Browser lifecycle, Playwright actions, pacing and retry | Shared browser driver |
| SSE framing and decoder implementations | Shared decoder engine |
| Tool protocol normalization and permission execution | Shared protocol + native DSH execution |
| Browser-client slots and mount lifecycle | DSH official client module framework |

Do not duplicate the browser driver, decoder, prompt serializer or permission system per website.
Do not infer a site capability from its frontend framework or an unverified DOM guess.

### Measured message-delivery limits

Message-length ceilings are site facts, not shared browser-driver routing knowledge. They live in each
adapter's optional `limits` object and are validated at registry load:

- DeepSeek, GLM and Kimi declare `attachInlineLimitChars: 8000`. These are measured safety ceilings
  that tighten a positive user-configured inline threshold; they do not enable attachments.
- Kimi additionally declares `composerHardLimitChars: 200000`. This is a hard fallback ceiling:
  even an explicit inline preference must use attachment delivery above it because inline text was
  observed to truncate. It is distinct from the 8,000-character preference threshold.

Evidence retained from the original driver comments and probe records:

- DeepSeek: `test-mock/real-attach-adjudicate.mjs` and
  `test-mock/real-attach-ingest.mjs`; typical first-turn messages measured 48,937 and 53,797
  characters while the site accepted attachment payloads.
- Kimi: `test-mock/real-attach-ingest-kimi.mjs`; a 38,807-character inline turn was silently
  shortened to approximately 20,158 characters. The later one-shot `keyboard.insertText` probe
  read back 50,000, 100,000 and 200,000 characters exactly, so 200,000 is the evidenced hard
  ceiling rather than an extrapolated larger value.
- GLM: the 2026-09-27 12,911-character incident read back only 12,870 characters and raised
  `PROMPT_TRUNCATED`; see `doc/research/2026-09-27-glm-native-tool-call.md`. The 8,000-character
  ceiling moves this long prompt to the already-validated attachment path.

`browser-driver.js` keeps `SITE_ATTACH_INLINE_LIMIT` and
`SITE_COMPOSER_HARD_LIMIT` as compatibility snapshots derived from adapter data. The effective
threshold still returns zero for a user-configured zero/invalid value, preserving the existing
"attachments disabled" contract. Sites without measured limits continue using shared defaults.

### Site request contract metadata

Verified website-specific request facts belong in the adapter's `contract` descriptor. The shared
`lib/contract.js` projection derives every site's runtime contract through the same function; it
does not branch on site IDs. Current DeepSeek metadata owns its search-toggle matcher, request
metadata keys and strict model-type verification. Sites without those live-evidenced capabilities
retain the conservative shared defaults.

The registry validates descriptor types and key lists at module load. The `alwaysOptionals` field
is a compatibility switch for historical contract-object key presence; it is not a new browser
capability. The projection defaults it to the existing generic shape and adapters may opt out only
when their established public contract omitted those optional keys.

### Local settings UI contract

Site-local settings are declared by the adapter in `settingsUi` and projected through
`/status → driver.sites`. The shared CJS renderer must not duplicate website IDs or infer a
control from a site name. The metadata is a deliberately small contract, not arbitrary UI markup:

- `globalThinkMode`, `searchMode`, and `siteThinkMode` are opt-in boolean capabilities.
- `siteMode` is a select descriptor with a non-empty `label`, optional `title`, and 1–32 unique
  non-empty string `options`.

The registry validates every adapter declaration at module load. Unsupported keys, malformed
descriptors, duplicate options, and non-JSON values fail before the metadata can reach the browser.
A new control type must first gain a shared renderer and contract tests; adapters must not advertise
controls the local UI cannot render or persist.

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

### How terminal session resume works in DSH

The current DSH CLI documents `dsh --profile tui --resume <id>` as an example for a terminal
application profile, with the qualification that the TUI profile must be installed. The launcher
forwards `--resume` to that app; it is not a global launcher flag. At the API layer, the documented
restoration path is `ctx.agents.resume({ resumeSessionId })`.

The shipped JSONL persistence backend stores append-only Session events on disk (Zstandard-compressed
by default). A resumed Agent restores that history and adds recovery markers for interrupted turns.
A terminal can continue after process restart because a stable Session ID selects durable history.
A tmux pane that never exited is different: it is still the same live process. The optional DSH
tmux-context package only adds the current tmux session/window/pane location to the model context;
it does not restore a browser or remote web chat.

For this bridge, terminal resume therefore needs all three links to remain valid: the DSH Session ID,
the plugin's persistent browser profile, and the remote site's conversation ID/session cursor. The
DSH Session ID alone does not recreate the other two.

The automated composition check is `package/dsh-webcode-bridge/test/cursor-persistence.test.mjs`
(⑥). It starts two real `apply()` instances and two real browser-driver instances against one
profile directory. It verifies that the same DSH Session ID restores an incremental cursor while
the new driver returns to the exact stored remote conversation URL and ID. The fixture replaces
only the final generated answer; browser navigation, driver-session persistence and DSH cursor
persistence are exercised through production code.


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

- The QR selector now filters known CAPTCHA/slider/puzzle metadata (fixture-guarded in test/login-state.test.mjs); still run a real DSH Web QR scan on each reachable QR-login site and verify login completion plus cookie persistence after driver restart.
- Move remaining evidenced site-only behavior branches into adapter capabilities where doing so preserves existing behavior.
