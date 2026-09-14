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
import { parseAgentReply, findProtocolStart, stripProtocolText, normalizeDsml } from '../lib/agent-preset.js';

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

// ---- 5) normalization consistency ----------------------------------------

test('normalizeDsml is idempotent', () => {
  const once = normalizeDsml(leaked);
  assert.equal(normalizeDsml(once), once);
});
