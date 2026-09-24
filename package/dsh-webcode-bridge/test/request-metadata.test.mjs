// request-metadata.test.mjs — 0.19.11 护栏：完成请求的「可判定摘要」。
//
// 用户报障（原话）：「现在的还是无法传递给 deepseek 里面…」——而桥当时连
// 「这一轮的完成请求到底带没带文件」都答不出来。旧实现的键名正则只认
// model/thinking/search，**且只收标量**，于是 `ref_file_ids`（unified UI 时代
// 附件在场的唯一权威字段，真机取证见 test-mock/archive/real-probe-20-newui-facts.mjs:152）
// 被两道门连续挡掉。这组断言把两扇门都钉住。

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRequestMetadata } from '../lib/browser-driver.js';

test('ref_file_ids 数组必须留下（旧实现被键名+类型两道门挡掉）', () => {
  const out = summarizeRequestMetadata({ ref_file_ids: ['file-a', 'file-b'], model_type: 'default' });
  assert.deepEqual(out.ref_file_ids, ['file-a', 'file-b']);
  assert.equal(out.ref_file_idsCount, 2, '数量必须单独成键：面板一眼能看出「带没带」');
});

test('prompt 只记长度，正文绝不进读数', () => {
  const secret = 'x'.repeat(1234);
  const out = summarizeRequestMetadata({ prompt: secret, thinking_enabled: true });
  assert.equal(out.promptChars, 1234);
  assert.equal(out.prompt, undefined, '正文不许进 /status');
  assert.equal(JSON.stringify(out).includes(secret), false);
});

test('标量口径与旧实现逐字一致（model_type / thinking_enabled / search_enabled 一个不少）', () => {
  const out = summarizeRequestMetadata({ model_type: 'expert', thinking_enabled: false, search_enabled: true, chat_session_id: 'x', stream: true });
  assert.equal(out.model_type, 'expert');
  assert.equal(out.thinking_enabled, false);
  assert.equal(out.search_enabled, true);
  assert.equal(out.chat_session_id, undefined, '无关键不得进读数');
  assert.equal(out.stream, undefined);
});

test('id 列表封顶 12 枚（读数不是抓包转储）', () => {
  const out = summarizeRequestMetadata({ ref_file_ids: Array.from({ length: 30 }, (_, i) => 'f' + i) });
  assert.equal(out.ref_file_ids.length, 12);
  assert.equal(out.ref_file_idsCount, 30);
});

test('空对象 / 非对象 → null（不产出假读数）', () => {
  assert.equal(summarizeRequestMetadata(null), null);
  assert.equal(summarizeRequestMetadata({ a: 1 }), null);
  assert.equal(summarizeRequestMetadata({ ref_file_ids: [1, 2] }), null, '非字符串数组不是文件 id，不得假装是');
});
