// protocol-leak.test.mjs - regression guard: protocol text must never reach assistant text.
//
// Background (2026-09-11, real session 8e9c538a): the stored assistant message carried the
// whole protocol body as a prose paragraph:
//
//   I'll start by inspecting the project state.
//   <[fullwidth-bar]DSML[fullwidth-bar] calls>
//   <[fullwidth-bar]DSML[fullwidth-bar] invoke name="pwsh">
//   <[fullwidth-bar]DSML[fullwidth-bar] parameter name="command" string="true">Get-Location; ...
//
// Root cause was NOT rendering: the streaming boundary probe and the parser each knew a
// different set of shapes.
//   - parseAgentReply normalizes full-width DSML, so tools still executed;
//   - the inline streaming marker() only knew half-width tags, a json fence, **Calling: and a
//     bare { line, so it returned -1 for full-width DSML and the protocol body was emitted as
//     assistant text and persisted.
// Display-layer folding cannot fix that: the body is a prose paragraph, not a <pre> block.
//
// This test locks three things:
//   1) the boundary probe recognizes the real-world fixture (its index was -1 before the fix);
//   2) parsing still yields the full call - stripping must never touch the tool loop;
//   3) the probe and the parser must not drift apart in which shapes they accept.
//
// The fixture is extracted verbatim from a real session transcript, not hand-written.
//
// IMPORTANT - why every DSML marker here is built with String.fromCharCode:
// DSH strips DSML-looking marker sequences out of tool arguments (anti protocol-injection),
// so writing those literals in a file-write payload truncates or corrupts the file. Build them
// from character codes instead; never inline the literal marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentReply, findProtocolStart, stripProtocolText, normalizeDsml, proseSafeEnd, partialProtocolAt } from '../lib/agent-preset.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, 'fixtures', 'leaked-dsml-reply.txt');
const leaked = fs.readFileSync(fixturePath, 'utf8');

const BARF = String.fromCharCode(0xff5c);   // full-width vertical bar
const BARH = String.fromCharCode(124);     // half-width vertical bar
const DSML_F = BARF + BARF + 'DSML' + BARF + BARF;
const DSML_H = BARH + 'DSML' + BARH;
const LT = '<';
const GT = '>';
const SL = '/';
const PROSE = "I'll start by inspecting the project state.";
const TAG_F = LT + DSML_F + ' ';

// ---- 1) real fixture: the probe must hit ---------------------------------

test('boundary probe recognizes the real full-width DSML shape (index was -1 before fix)', () => {
  const found = findProtocolStart(leaked);
  assert.ok(found.index >= 0, 'real shape must be detected, else the protocol body is emitted as text');
  assert.equal(found.name, 'pwsh', 'should read the tool name out of the invoke attribute');
  assert.equal(found.transport, true, 'should classify as a tool transport shape');
  assert.equal(leaked.slice(0, found.index).trim(), PROSE, 'boundary must sit at the protocol start');
});

test('stripping leaves only prose, with no protocol residue', () => {
  const prose = stripProtocolText(leaked);
  assert.equal(prose, PROSE);
  for (const mark of ['DSML', 'invoke', 'parameter', 'mcp_action', 'Get-Location']) {
    assert.ok(!prose.includes(mark), 'stripped text must not contain ' + mark);
  }
});

// ---- 2) the tool loop is untouched ---------------------------------------

test('parsing still yields the complete call (stripping never touches the tool loop)', () => {
  const { calls } = parseAgentReply(leaked);
  assert.equal(calls.length, 1, 'the fixture holds exactly one tool call');
  assert.equal(calls[0].name, 'pwsh');
  assert.ok(
    typeof calls[0].arguments.command === 'string' && calls[0].arguments.command.includes('Get-Location'),
    'command must survive intact, else the tool runs with empty arguments',
  );
  assert.equal(calls[0].arguments.description, 'Show working directory and top-level files');
});

test('one text: the UI gets prose and the parser gets the call, simultaneously', () => {
  const prose = stripProtocolText(leaked);
  const { calls } = parseAgentReply(leaked);
  assert.equal(prose, PROSE);
  assert.equal(calls.length, 1);
  assert.ok(calls.length > 0 && prose.length > 0);
});

// ---- 3) probe and parser must not drift ----------------------------------

const SHAPES = [
  ['half-width tool_call tag',
    LT + 'tool_call' + GT + '\n{"mcp_action":"call","name":"pwsh","arguments":{"command":"git log"}}\n' + LT + SL + 'tool_call' + GT],
  ['json fence (mcp_action protocol)',
    '```json\n{"mcp_action":"call","name":"pwsh","arguments":{"command":"ls"}}\n```'],
  ['web Calling rendering',
    '**Calling:** `pwsh`\n{"command":"dir"}'],
  ['full-width bar-DSML calls + invoke + parameter (real main shape)',
    TAG_F + 'calls' + GT + '\n' + TAG_F + 'invoke name="read"' + GT + '\n' +
    TAG_F + 'parameter name="path"' + GT + 'README.md' + LT + SL + DSML_F + ' parameter' + GT + '\n' +
    LT + SL + DSML_F + ' invoke' + GT],
  ['half-width bar-DSML prefix',
    LT + DSML_H + 'tool_calls' + GT + LT + DSML_H + 'invoke name="read"' + GT +
    LT + DSML_H + 'parameter name="path"' + GT + 'README.md' +
    LT + SL + DSML_H + 'parameter' + GT + LT + SL + DSML_H + 'invoke' + GT],
  ['bar-DSML with dropped leading angle bracket',
    DSML_F + 'invoke name="read"' + GT + LT + DSML_F + 'parameter name="path"' + GT + 'PLAN.md' +
    LT + SL + DSML_F + 'parameter' + GT + LT + SL + DSML_F + 'invoke' + GT],
];

test('six protocol shapes: probe and parser agree (neither may accept alone)', () => {
  const drift = [];
  for (const [name, text] of SHAPES) {
    const probed = findProtocolStart(text).index >= 0;
    const parsed = parseAgentReply(text).calls.length > 0;
    if (probed !== parsed) drift.push(name + ': probe=' + probed + ' parse=' + parsed);
  }
  assert.deepEqual(drift, [], 'probe/parser shape sets drifted:\n  ' + drift.join('\n  '));
});

test('six protocol shapes: none leaves protocol residue after stripping', () => {
  for (const [name, text] of SHAPES) {
    const prose = stripProtocolText(text);
    assert.ok(!prose.includes('DSML'), name + ': DSML survived stripping');
    assert.ok(!/<\s*\/?\s*(?:invoke|tool_call|parameter)\b/i.test(prose), name + ': protocol tags survived stripping');
  }
});

// ---- 4) negatives: prose must not be damaged ------------------------------

test('plain prose and ordinary code blocks are not truncated', () => {
  const keep = [
    PROSE,
    PROSE + '\n\nLet me also check the tests.',
    'const keep = 1;\nfunction add(a, b) { return a + b; }',
  ];
  for (const p of keep) assert.equal(stripProtocolText(p), p, 'must be returned unchanged: ' + JSON.stringify(p.slice(0, 40)));
});

test('malformed input never throws', () => {
  const weird = ['', '{', '}', LT, LT + DSML_F, '```', '**Calling:', '<invoke name="', TAG_F + 'calls' + GT, DSML_F, DSML_H];
  for (const w of weird) {
    assert.doesNotThrow(() => findProtocolStart(w), 'findProtocolStart must not throw on ' + JSON.stringify(w));
    assert.doesNotThrow(() => stripProtocolText(w), 'stripProtocolText must not throw on ' + JSON.stringify(w));
  }
  assert.equal(findProtocolStart('').index, -1);
  assert.equal(stripProtocolText(''), '');
});

// ---- 4b) tool_result wrapper (0.14.5, real transcript seq=587) -------------
//
// Evidence: session-c710ef6e (2026-09-14), assistant/message seq=587 carried the web
// model's own echo of the tool results, wrapper and all. Before the fix the anchors only
// knew `tool_call`, so the boundary landed on the JSON *after* the wrapper and the
// literal `<tool_result>\n` (13 chars) / `</tool_result>\n` (14 chars) were emitted as
// assistant prose. The tool_result tag is now an anchor but deliberately NOT a
// transport shape: a result is not a call and must never be executed.

test('tool_result wrapper is a boundary anchor (real seq=587 shape)', () => {
  const open = LT + 'tool_result' + GT + '\n{"mcp_action":"result","name":"edit","status":"success"}';
  const close = LT + SL + 'tool_result' + GT + '\n{"mcp_action":"result","name":"write"}';
  assert.equal(findProtocolStart(open).index, 0, 'leading <tool_result> must be the boundary');
  assert.equal(findProtocolStart(close).index, 0, 'leading </tool_result> must be the boundary');
  assert.equal(stripProtocolText(open), '', 'wrapper must not survive as prose');
  assert.equal(stripProtocolText(close), '', 'closing wrapper must not survive as prose');
});

test('tool_result is an anchor but never a transport call', () => {
  // If this ever flips to transport:true, the bridge would try to *execute* a result.
  for (const text of [LT + 'tool_result' + GT, LT + SL + 'tool_result' + GT]) {
    const found = findProtocolStart(text);
    assert.equal(found.transport, false, 'a tool result is not a tool call: ' + text);
  }
  assert.equal(parseAgentReply(LT + 'tool_result' + GT + '\n{}').calls.length, 0, 'results must not parse as calls');
});

// ---- 4c) <call> / <call_call> fragments (0.14.6, real transcript) ---------
//
// Evidence: session-698700ea (2026-09-14), assistant/message TEXT blocks carried 13
// fragments the anchors did not know about:
//
//   seq=91  step=11  </call_call>
//   seq=119 step=15  </call>   (three times in one step)
//   seq=179 step=23  </call> <call_call> {"mcp_action…
//   seq=289 step=37  </call>
//   seq=326 step=42  </call_call>
//   seq=569 step=80  </call_call>
//   seq=779 step=113 </call_call>
//
// and session-c710ef6e seq=548 had one. The old candidate set had only the PLURAL
// `calls`, so `<call>` (followed by `>`) never matched, and `call_call` was absent
// entirely -> findProtocolStart returned -1 -> the fragments were emitted as prose and
// persisted. The user saw them as `<>call` in the UI.
//
// Same standing rule as tool_result: these join the boundary anchors but NEVER the
// transport test — a fragment is not a call and must never be executed.
//
// Built from character codes (see the IMPORTANT note at the top of this file).

const CALL = LT + 'call' + GT;
const CALL_CLOSE = LT + SL + 'call' + GT;
const CALL_CALL = LT + 'call_call' + GT;
const CALL_CALL_CLOSE = LT + SL + 'call_call' + GT;

test('call / call_call fragments are boundary anchors (real fragment shapes)', () => {
  for (const frag of [CALL, CALL_CLOSE, CALL_CALL, CALL_CALL_CLOSE]) {
    assert.ok(
      findProtocolStart(frag).index >= 0,
      'fragment must be detected, else it is emitted as prose: ' + frag,
    );
  }
  // The real seq=179 shape: a closing fragment followed by another fragment, then JSON.
  const seq179 = CALL_CLOSE + ' ' + CALL_CALL + ' {"mcp_action":"call","name":"pwsh","arguments":{}}';
  assert.equal(findProtocolStart(seq179).index, 0, 'seq=179 shape must be cut at index 0');
  assert.equal(stripProtocolText(seq179), '', 'seq=179 shape must leave no prose behind');
});

test('call fragments are anchors but never transport calls', () => {
  for (const frag of [CALL, CALL_CLOSE, CALL_CALL, CALL_CALL_CLOSE]) {
    const found = findProtocolStart(frag);
    assert.equal(found.transport, false, 'a fragment is not a tool call: ' + frag);
    assert.equal(found.name, '', 'a fragment carries no tool name: ' + frag);
  }
  assert.equal(parseAgentReply(CALL + '\n{}').calls.length, 0, 'fragments must not parse as calls');
});

test('a call fragment does not swallow the prose before it', () => {
  const text = PROSE + '\n' + CALL_CLOSE;
  assert.equal(stripProtocolText(text), PROSE, 'prose before the fragment must survive');
});

test('<calling> is NOT a protocol anchor (word boundary must hold)', () => {
  // `call` followed by `i` are both word characters, so the \b in the anchor fails.
  // If this ever flips, ordinary prose containing <calling> would be truncated.
  const benign = 'Use ' + LT + 'calling' + GT + ' style here.';
  assert.equal(findProtocolStart(benign).index, -1, 'benign <calling> must not be a boundary');
  assert.equal(stripProtocolText(benign), benign, 'benign <calling> must not be stripped');
});

// ---- 4d) <toolcall> / </toolcall> without underscore (0.15.0, real transcripts) ---
//
// This is the family 0.14.6 did NOT cover, and it is not historical: it occurs in the two
// most recent sessions. Per-block scan of the real session logs (TEXT blocks only;
// reasoning blocks are never emitted and are therefore not counted as leaks):
//
//   session-94966bd8 seq=2798  text block is 34 chars: a closing tag, an opening tag and
//                              the head of a call JSON object
//   session-94966bd8 seq=2983  text block is 1,061 chars: prose, then a full call JSON
//                              payload (including a C:\Users\...\cordis path)
//   session-f9010b75 seq=812   text block is 29,650 chars: an entire call JSON emitted as
//                              text, followed by hundreds of repeated closing-tag fragments
//
// Why the old candidate set could not see it: after `<` or `</` the alternation must match
// from the tag start, which is `t`; the set held `tool_call` (needs the underscore) and
// never the underscore-free form. The 0.14.6 addition of `call` did not help either —
// `call` must match from `c`, and the underscore-free family starts with `t`.
//
// Standing rule, same as tool_result and the call fragments: the underscore-free family
// joins the boundary anchors but NEVER the transport test. Whether a tag names a real
// executable call is decided by parseAgentReply from the payload, not from the tag name.
//
// Same hazard note as the top of this file applies: the DSML fixtures are built from
// character codes. Plain half-width tags are written literally in the existing tests, so
// they are used literally here too.
const TOOLCALL_OPEN = LT + 'toolcall' + GT;
const TOOLCALL_CLOSE = LT + SL + 'toolcall' + GT;
const TOOLCALLS_OPEN = LT + 'toolcalls' + GT;
const TOOLCALLS_CLOSE = LT + SL + 'toolcalls' + GT;

test('underscore-free toolcall tags are boundary anchors (real transcript shapes)', () => {
  for (const frag of [TOOLCALL_OPEN, TOOLCALL_CLOSE, TOOLCALLS_OPEN, TOOLCALLS_CLOSE]) {
    assert.ok(
      findProtocolStart(frag).index >= 0,
      'tag must be detected, else it is emitted as prose: ' + frag,
    );
  }
  // The seq=2798 shape: closing tag, opening tag, then the head of a call object.
  const seq2798 = TOOLCALL_CLOSE + TOOLCALL_OPEN + '{"mcp_action":"call","name":"pwsh","arguments":{}}';
  assert.equal(findProtocolStart(seq2798).index, 0, 'seq=2798 shape must be cut at index 0');
  assert.equal(stripProtocolText(seq2798), '', 'seq=2798 shape must leave no prose behind');
});

test('underscore-free toolcall tags are anchors but never transport calls', () => {
  // If this ever flips to transport:true without a corresponding change to the call
  // parser, the streaming loop would stop emitting prose at a tag it can never execute
  // — and the "probe and parser agree" test below would fail first. That is intended.
  for (const frag of [TOOLCALL_OPEN, TOOLCALL_CLOSE, TOOLCALLS_OPEN, TOOLCALLS_CLOSE]) {
    assert.equal(findProtocolStart(frag).transport, false, 'a bare tag is not a tool call: ' + frag);
  }
});

test('an underscore-free tag does not swallow the prose before it', () => {
  // seq=2983: 1,061-char text block was prose followed by the tag and the payload.
  const text = PROSE + '\n' + TOOLCALL_OPEN + '{"mcp_action":"call","name":"read","arguments":{"path":"a.md"}}';
  assert.equal(stripProtocolText(text), PROSE, 'prose before the tag must survive');
});

test('the underscore-free family is an anchor, and the detector must agree (0.14.6 lesson)', () => {
  // The 0.14.6 lesson, restated as an executable assertion: the boundary anchors and the
  // log-scanning detector in test-mock/parse-session-log.mjs must share one set of shape
  // knowledge. When they drift, "the logs show no leak warning" is a FALSE NEGATIVE —
  // exactly how the 13 <call> fragments were missed.
  //
  // The detector cannot be imported here without dragging in the whole session-log
  // reader, so the invariant is pinned on this side: every shape that the anchors accept
  // must also be a shape the detector's pattern set accepts. The detector's set is
  // mirrored below and checked against the anchors.
  const DETECTOR_PATTERNS = [
    /<tool_call>/i,
    /<\/tool_call>/i,
    /<\/?\s*toolcalls?(?![\w-])/i,
    /<\s*[｜|]{1,2}DSML[｜|]{1,2}/i,
    /<\/tool_result>/i,
    /<tool_result>/i,
    /<\/?\s*call_call(?![\w-])/i,
    /<\/?\s*call(?![\w-])/i,
  ];
  const shapes = [
    TOOLCALL_OPEN, TOOLCALL_CLOSE, TOOLCALLS_OPEN, TOOLCALLS_CLOSE,
    LT + 'tool_call' + GT, LT + SL + 'tool_call' + GT,
    CALL, CALL_CLOSE, CALL_CALL, CALL_CALL_CLOSE,
    LT + 'tool_result' + GT, LT + SL + 'tool_result' + GT,
  ];
  const blind = shapes.filter((s) => !DETECTOR_PATTERNS.some((p) => p.test(s)));
  assert.deepEqual(blind, [], 'detector is blind to shapes the anchors accept:\n  ' + blind.join('\n  '));
  // Reverse direction: the anchors must accept every tag family the detector knows about,
  // so a detector hit is never a shape the streaming boundary probe would let through.
  const anchored = [
    LT + 'tool_call' + GT, LT + SL + 'tool_call' + GT,
    TOOLCALL_OPEN, TOOLCALL_CLOSE,
    LT + 'tool_result' + GT, LT + SL + 'tool_result' + GT,
    CALL, CALL_CLOSE, CALL_CALL, CALL_CALL_CLOSE,
  ];
  const unanchored = anchored.filter((s) => findProtocolStart(s).index < 0);
  assert.deepEqual(unanchored, [], 'anchors are blind to shapes the detector flags:\n  ' + unanchored.join('\n  '));
});

test('<toolcalling> is NOT a protocol anchor (word boundary must hold for the new family too)', () => {
  // Same safety line as <calling>: the new alternatives are followed by \b, so a longer
  // word starting with the same letters must not become a boundary. Without this the
  // widened anchor set would start truncating ordinary prose.
  for (const word of ['toolcalling', 'toolcallsign']) {
    const benign = 'Use ' + LT + word + GT + ' style here.';
    assert.equal(findProtocolStart(benign).index, -1, 'benign ' + LT + word + GT + ' must not be a boundary');
    assert.equal(stripProtocolText(benign), benign, 'benign ' + LT + word + GT + ' must not be stripped');
  }
});

// ---- 4e) proseSafeEnd: the leak that actually reached the transcripts ------
//
// This is finding #18 in doc/long-term-issues.md, fixed in 0.15.0. It is the most
// serious of the family because it is NOT a boundary-probe failure: the probe was
// correct and the text was persisted anyway.
//
// Real evidence, read from the codepoints (not by eye) in two live sessions:
//
//   session e5cb719c (a subagent) step 6, 354-char TEXT block:
//     "<" U+FF5C U+FF5C "DSML" U+FF5C U+FF5C **U+0020** "calls>" then
//     `invoke name="pwsh"`, `parameter name="command"`, an unterminated command.
//     findProtocolStart -> {index: 99, transport: true}   <- the probe was RIGHT
//     parseAgentReply    -> 0 calls                        <- the JSON never closed
//
//   session session-a6835ca1 step 22: the same shape, 21,905 chars persisted.
//
// Mechanism, two causes stacked:
//   (a) normalizeDsml did not eat the space after the marker, so it produced
//       `< calls>` and the exact-prefix table in partialProtocolAt missed it
//       entirely (the anchors tolerated `<\s`, which is why this stayed hidden);
//   (b) the closing path treated "no parseable call" as "the whole text is prose"
//       instead of "prose stops at the boundary the probe already found".
//
// The real marker, built from character codes per the standing rule at the top of
// this file (DSH strips DSML-looking sequences out of tool arguments).
const DSML_MARK = LT + BARF + BARF + 'DSML' + BARF + BARF;

test('normalizeDsml eats the space between the marker and the tag name (real leak)', () => {
  // This is cause (a). Before 0.15.0 this returned '< calls>' and every
  // exact-prefix check downstream silently stopped working.
  const raw = DSML_MARK + ' calls>';
  assert.equal(normalizeDsml(raw), LT + 'calls>', 'marker + space + name must collapse to <calls>');
  const withInvoke = DSML_MARK + ' invoke name="pwsh">';
  assert.equal(normalizeDsml(withInvoke), LT + 'invoke name="pwsh">');
});

test('normalizeDsml does NOT eat the space when no known tag name follows', () => {
  // The safety line: if the space were eaten unconditionally, ordinary prose after
  // a stray marker would be spliced into a fake tag (`<hello`). Only the
  // lookahead form collapses.
  const raw = DSML_MARK + ' hello';
  assert.equal(normalizeDsml(raw), LT + ' hello', 'space must survive before an unknown name');
});

test('proseSafeEnd: the real leaked block yields prose only (the 354-char case)', () => {
  // Rebuilt from the codepoints of session e5cb719c step 6.
  const prose = 'The matches included tool-listing boilerplate. Let me filter to actual `todo_write` call records.';
  const leaked = prose + '\n\n'
    + DSML_MARK + ' calls>\n'
    + DSML_MARK + ' invoke name="pwsh">\n'
    + DSML_MARK + ' parameter name="command" string="true">cd D:\\work; node -e "'
    + "const fs=require('fs');\nfor(const f of fs.readdirSync('.').filter(x=>/^session-.*\\.jsonl";
  // The probe finds the boundary (that was never the problem)...
  assert.equal(findProtocolStart(leaked).index, prose.length + 2, 'boundary probe must sit at the marker');
  // ...but the call is unparseable, because the stream was cut mid-JSON.
  assert.equal(parseAgentReply(leaked).calls.length, 0, 'incomplete call must not parse');
  // The fix: prose still stops at the boundary.
  assert.equal(proseSafeEnd(leaked, 0), prose.length + 2, 'prose must stop at the boundary, not run to the end');
  assert.equal(leaked.slice(0, proseSafeEnd(leaked, 0)).trim(), prose, 'exactly the prose must remain');
});

test('proseSafeEnd: never returns less than `from` (monotonic, no re-send)', () => {
  // The streaming loop has already emitted `from` characters. A safe end below it
  // would either resend or mis-slice; the contract is max(from, boundary).
  const prose = 'hello world';
  const text = prose + '\n' + TOOLCALL_OPEN + '{"mcp_action":"call"';
  for (const from of [0, 5, prose.length, prose.length + 3]) {
    assert.ok(proseSafeEnd(text, from) >= from, 'proseSafeEnd must never go backwards (from=' + from + ')');
  }
  // And with no protocol text at all it is simply the end of the string.
  assert.equal(proseSafeEnd(prose, 0), prose.length);
});

test('proseSafeEnd: withholds a stream cut in the MIDDLE of a marker', () => {
  // session session-a6835ca1 seq=812: a 29,650-char message where the stream ended
  // inside protocol noise. The tail can be a half-written marker, and a half
  // marker is not prose.
  const prose = 'Looking at the results now.';
  for (const tail of [BARF, BARF + BARF, BARF + BARF + 'D', BARF + BARF + 'DSM']) {
    const text = prose + ' ' + LT + tail;
    const end = proseSafeEnd(text, 0);
    assert.equal(end, prose.length + 1, 'half marker must be withheld: ' + JSON.stringify(tail));
    assert.equal(text.slice(0, end).trim(), prose);
  }
});

test('proseSafeEnd: ordinary prose ending in a bare < is not damaged beyond the tail', () => {
  // The safety line for the half-marker rule: a lone `<` at the very end is
  // withheld (it may become a tag), but everything before it survives untouched.
  const text = 'Compare a < b and c < d';
  const end = proseSafeEnd(text, 0);
  assert.ok(text.slice(0, end).startsWith('Compare a < b'), 'text before the tail must survive');
  // A complete, non-protocol tag is NOT a boundary: this is prose.
  const html = 'Use <div class="x"> here.';
  assert.equal(proseSafeEnd(html, 0), html.length, 'ordinary HTML must not be treated as protocol');
});

test('proseSafeEnd: never throws on malformed input', () => {
  for (const w of ['', LT, LT + SL, '```', '**Calling:', BARF, DSML_MARK, DSML_MARK + ' ']) {
    assert.doesNotThrow(() => proseSafeEnd(w), 'proseSafeEnd threw on ' + JSON.stringify(w));
    assert.doesNotThrow(() => proseSafeEnd(w, 3));
  }
});

// ---- 5) normalization consistency ----------------------------------------

test('normalizeDsml is idempotent', () => {
  const once = normalizeDsml(leaked);
  assert.equal(normalizeDsml(once), once);
});
