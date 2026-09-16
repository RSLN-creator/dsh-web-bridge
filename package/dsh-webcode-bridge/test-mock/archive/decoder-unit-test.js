// decoder-unit-test.js — feed the mock's exact DeepSeek SSE frame sequence
// into the extension decoder (loaded as a plain script) and check output.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(dirname(dirname(here)));
const code = readFileSync(join(repo, 'extension', 'vendor', 'decoder.js'), 'utf8');
new Function(code)(); // defines globalThis.WebCodeDeepSeekStreamDecoder

const Decoder = globalThis.WebCodeDeepSeekStreamDecoder;
if (!Decoder) { console.log('FAIL: decoder global missing'); process.exit(1); }

const deltas = [];
const dec = new Decoder({ onDelta: (t) => deltas.push(t) });

const answer = 'MOCK-ANSWER: 已收到网页桥接请求。prompt 前缀：M2 诊断';
const think = '（思考片段：不应出现在桥接输出中）';
const frames = [
  'event: ready\ndata: ' + JSON.stringify({ response_message_id: 'm1' }) + '\n\n',
  'event: message\ndata: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: 'm1', status: 'WIP', fragments: [{ type: 'THINK', content: '' }, { type: 'RESPONSE', content: '' }] } } }) + '\n\n',
];
for (let i = 0; i < think.length; i += 6) frames.push('event: message\ndata: ' + JSON.stringify({ o: 'APPEND', p: 'response/fragments/0/content', v: think.slice(i, i + 6) }) + '\n\n');
for (let i = 0; i < answer.length; i += 12) frames.push('event: message\ndata: ' + JSON.stringify({ o: 'APPEND', p: 'response/fragments/-1/content', v: answer.slice(i, i + 12) }) + '\n\n');
frames.push('event: message\ndata: ' + JSON.stringify({ o: 'SET', p: 'response/status', v: 'FINISHED' }) + '\n\n');
frames.push('event: close\ndata: {}\n\n');

// feed in odd-sized chunks like network capture would
let buf = '';
for (const f of frames) buf += f;
const pieces = [];
for (let i = 0; i < buf.length; i += 97) pieces.push(buf.slice(i, i + 97));
for (const p of pieces) dec.push(p);

const result = dec.finish();
let ok = true;
const check = (name, cond, detail = '') => { console.log((cond ? '  ✅ ' : '  ❌ ') + name + (detail ? ' — ' + detail : '')); if (!cond) ok = false; };

check('complete', result.complete === true, JSON.stringify(result).slice(0, 120));
check('text matches answer', result.text === answer, JSON.stringify(result.text?.slice(0, 60)));
check('deltas streamed', deltas.length >= 2, deltas.length + ' deltas');
check('THINK never in deltas', !deltas.join('').includes('思考'), deltas.join('').slice(0, 60));
check('deltas reconstruct answer', deltas.join('') === answer, deltas.join('').length + ' chars');

// Scenario 2: opening frame pre-fills RESPONSE content (the "missing first
// words" bug) — the initial content must be streamed via onDelta.
const deltas2 = [];
const dec2 = new Decoder({ onDelta: (t) => deltas2.push(t) });
dec2.push('event: ready\ndata: ' + JSON.stringify({ response_message_id: 'm9' }) + '\n\n');
dec2.push('event: message\ndata: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: 'm9', status: 'WIP', fragments: [{ type: 'RESPONSE', content: '开头几个词' }] } } }) + '\n\n');
dec2.push('event: message\ndata: ' + JSON.stringify({ o: 'APPEND', p: 'response/fragments/-1/content', v: '，后续内容' }) + '\n\n');
dec2.push('event: message\ndata: ' + JSON.stringify({ o: 'SET', p: 'response/status', v: 'FINISHED' }) + '\n\n');
dec2.push('event: close\ndata: {}\n\n');
const r2 = dec2.finish();
check('scenario2 complete', r2.complete === true, JSON.stringify(r2).slice(0, 100));
check('scenario2 initial content streamed', deltas2.join('').startsWith('开头几个词'), JSON.stringify(deltas2));
check('scenario2 full text', r2.text === '开头几个词，后续内容', JSON.stringify(r2.text));

// Scenario 3: re-sent response object must not double-stream
dec2.push('event: message\ndata: ' + JSON.stringify({ v: { response: { role: 'ASSISTANT', message_id: 'm9', status: 'FINISHED', fragments: [{ type: 'RESPONSE', content: '开头几个词，后续内容' }] } } }) + '\n\n');
check('scenario3 no double stream', deltas2.join('') === '开头几个词，后续内容', JSON.stringify(deltas2));

console.log(ok ? 'DECODER: PASS' : 'DECODER: FAIL');
process.exit(ok ? 0 : 1);
