// relay-lanes.test.mjs — 0.19.4 护栏：relay 的**按账号多通道**并发语义。
//
// ## 用户指令（原话）
//
// 「已有使用账号不允许同时再使用！！一个网址可以多个账号，多个对话！但是必须每个对于
// 唯一账号！并发的真机等待？怎么说就是说需要不能同时发过多请求，错峰！但是不是让你只留
// 一个协议进行转接意思！还是多账户并发多会话那样需要真实多个转接！」
//
// 拆成四条可失败的判据（本文件的四条断言）：
//   ① **同账号**绝不允许同时在途（第二条必须等第一条结束）；
//   ② **不同账号**要真并发（时间上必须有重叠）——这正是「不是只留一个转接」的含义；
//   ③ 全局仍有**并发上限**（把上限压到 1 时，不同账号也必须串行）；
//   ④ 全局**错峰**：两次发出之间至少隔 `minSendIntervalMs`（可设为 0 关闭）。
//
// ## 为什么直接测 relay 而不是测整个桥
//
// 这条语义属于执行器（`relay.js`），与站点协议、marker 解析无关。直接构造 relay +
// 假 executor，判据是「时间区间是否重叠」——不依赖任何网络、也不受 60s 发送间隔影响，
// 因此可以在毫秒级跑完，且不会因为别处的改动变红。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../lib/relay.js';

/** 假 executor：记录每次「发出/收束」的时刻与通道，便于判断时间区间是否重叠。 */
function makeRelay(cfgExtra = {}) {
  const events = [];
  const relay = createRelay({
    port: 0,
    requireConsent: false,
    logger: { log() {}, warn() {} },
    ...cfgExtra,
    executor: async (prompt, { meta }) => {
      const lane = String(meta?.accountKey ?? '?');
      events.push({ kind: 'start', prompt, lane, at: Date.now() });
      await new Promise((r) => setTimeout(r, 80));
      events.push({ kind: 'end', prompt, lane, at: Date.now() });
      return { text: 'ok' };
    },
  });
  return { relay, events };
}

const starts = (events, lane) => events.filter((e) => e.kind === 'start' && e.lane === lane).map((e) => e.at);
const ends = (events, lane) => events.filter((e) => e.kind === 'end' && e.lane === lane).map((e) => e.at);

test('① 同账号绝不同时在途：第二条等第一条结束后才开始', async () => {
  const { relay, events } = makeRelay({ minSendIntervalMs: 0 });
  await Promise.all([
    relay.submit('first', { meta: { accountKey: 'glm' } }),
    relay.submit('second', { meta: { accountKey: 'glm' } }),
  ]);
  const [s1, s2] = starts(events, 'glm');
  const [e1] = ends(events, 'glm');
  assert.ok(s1 < s2, '两条请求都必须真的跑过');
  assert.ok(s2 >= e1, `同账号第二条在第一条收束之前就开始了（${s2} < ${e1}）——同一登录态被并发驱动`);
});

test('② 不同账号真并发：两条请求的时间区间必须重叠', async () => {
  const { relay, events } = makeRelay({ minSendIntervalMs: 0, maxConcurrentLanes: 2 });
  await Promise.all([
    relay.submit('a', { meta: { accountKey: 'glm' } }),
    relay.submit('b', { meta: { accountKey: 'glm#2' } }),
  ]);
  const [sA] = starts(events, 'glm');
  const [sB] = starts(events, 'glm#2');
  const [eA] = ends(events, 'glm');
  const [eB] = ends(events, 'glm#2');
  // 区间重叠 = 后开始的那个早于先结束的那个。
  const overlap = Math.max(sA, sB) < Math.min(eA, eB);
  assert.ok(overlap,
    `两个账号没有并发（A ${sA}-${eA}，B ${sB}-${eB}）——这正是用户否掉的「只留一个转接」`);
});

test('③ 全局并发上限：压到 1 时不同账号也必须串行', async () => {
  const { relay, events } = makeRelay({ minSendIntervalMs: 0, maxConcurrentLanes: 1 });
  await Promise.all([
    relay.submit('a', { meta: { accountKey: 'glm' } }),
    relay.submit('b', { meta: { accountKey: 'glm#2' } }),
  ]);
  const all = [...starts(events, 'glm'), ...starts(events, 'glm#2')].sort((x, y) => x - y);
  const allEnds = [...ends(events, 'glm'), ...ends(events, 'glm#2')].sort((x, y) => x - y);
  assert.equal(all.length, 2);
  assert.ok(all[1] >= allEnds[0], '上限=1 时第二条必须在第一条收束之后才开始');
});

test('④ 全局错峰：两次发出之间的间隔不小于 minSendIntervalMs', async () => {
  const gap = 150;
  const { relay, events } = makeRelay({ minSendIntervalMs: gap, maxConcurrentLanes: 2 });
  await Promise.all([
    relay.submit('a', { meta: { accountKey: 'glm' } }),
    relay.submit('b', { meta: { accountKey: 'glm#2' } }),
  ]);
  const all = [...starts(events, 'glm'), ...starts(events, 'glm#2')].sort((x, y) => x - y);
  assert.equal(all.length, 2);
  // 留 25ms 容差：定时器不保证精确，判据要能区分「约等于 150」与「几乎同时」。
  assert.ok(all[1] - all[0] >= gap - 25,
    `两次发出只隔了 ${all[1] - all[0]}ms（应 ≥ ${gap - 25}ms）——错峰没生效`);
});

test('⑤ status 透出通道明细与队列位置（用户要的「透出队列位置」）', async () => {
  const { relay } = makeRelay({ minSendIntervalMs: 0, maxConcurrentLanes: 1 });
  const p1 = relay.submit('a', { meta: { accountKey: 'glm' } });
  const p2 = relay.submit('b', { meta: { accountKey: 'glm' } });
  const s = relay.status();
  assert.equal(s.maxConcurrentLanes, 1);
  assert.equal(s.minSendIntervalMs, 0);
  assert.equal(s.busy, true, '兼容字段：还有在途就必须是 true');
  assert.equal(s.activeRequests, 1);
  assert.equal(s.queueLength, 1, '同账号第二条应当排在那条通道的队列里');
  const lane = s.lanes.find((l) => l.key === 'glm');
  assert.ok(lane, 'status 必须逐通道透出（否则「为什么这个账号还没发出去」只能靠猜）');
  assert.equal(lane.busy, true);
  assert.equal(lane.queued, 1);
  await Promise.all([p1, p2]);
  const after = relay.status();
  assert.equal(after.busy, false);
  assert.equal(after.queueLength, 0);
  assert.deepEqual(after.lanes, [], '收束后不应留下空的通道条目');
});

test('⑥ 没有 accountKey 的调用彼此串行（退化成单通道，不误当并发）', async () => {
  const { relay, events } = makeRelay({ minSendIntervalMs: 0, maxConcurrentLanes: 4 });
  await Promise.all([
    relay.submit('a', { meta: { siteId: 'deepseek' } }),
    relay.submit('b', { meta: { siteId: 'deepseek' } }),
  ]);
  const all = events.filter((e) => e.kind === 'start');
  const allEnds = events.filter((e) => e.kind === 'end');
  assert.equal(all.length, 2);
  assert.ok(all[1].at >= allEnds[0].at,
    '没有账号键的调用没有「同账号唯一」语义，但仍必须彼此串行（落到同一条默认通道）');
});
