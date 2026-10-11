// delivery-trace.test.mjs — 交付链逐层取证的护栏（0.19.75）。
//
// ## 这份护栏要钉住的核心区分
//
// 复审指出：看门狗计时修好**不等于**内容交付修好——`lastEventAt` 只在适配器收到
// 流事件时推进，而 `domReplyChars` 只是诊断读数，**不会**把 DOM 正文送回流里。
// 所以「2172 字丢在哪一层」需要沿链路逐层取证。
//
// 判据必须能分开两件**下一步完全不同**的事：
//   · 某层**零事件**     ⇒ 丢在「上游→本层」这段（要查上游的发送/绑定）
//   · 某层有事件但更短   ⇒ 丢在**本层**（要查本层的解析/过滤）
// 只报「适配器 0 事件」是末梢症状，分不出这两者——本文件 ②③ 就是钉这个区分。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryTrace, compareStages, STAGES } from '../lib/delivery-trace.js';

// ── ① 取证器本身：计数 / 长度 / 时刻 / 哈希，且**不留原文** ─────────────────

test('① 默认不保留原文（只记计数与哈希），且哈希在 snapshot 那刻定值', () => {
  const t = createDeliveryTrace();
  t.note('capture', '网页正文');
  t.note('capture', '更多');
  const snap = t.snapshot();
  assert.equal(snap.capture.events, 2);
  assert.equal(snap.capture.chars, 6);
  assert.equal(typeof snap.capture.hash, 'string');
  assert.equal(snap.capture.sample, undefined, '默认不得保留原文样本');
  // 冻结语义：快照之后再记事件，不得改变已返回的快照。
  const before = JSON.stringify(snap.capture);
  t.note('capture', '又一段');
  assert.equal(JSON.stringify(snap.capture), before, 'snapshot 必须是冻结读数');
  assert.equal(t.snapshot().capture.events, 3, '新快照才反映新事件');
});

test('①b 零事件层的哈希必须是 null（不是空串哈希）', () => {
  const t = createDeliveryTrace();
  t.note('capture', '正文');
  const snap = t.snapshot();
  assert.equal(snap.adapter.events, 0);
  assert.equal(snap.adapter.hash, null,
    '空串哈希会被误读成「这一层确实送来了一个空内容」，与「什么都没来」含义不同');
});

test('①c sampleChars>0 时才保留样本，且只留前 N 字符', () => {
  const t = createDeliveryTrace({ sampleChars: 4 });
  t.note('capture', '一二三四五六七八');
  assert.equal(t.snapshot().capture.sample, '一二三四');
});

test('①d 未知阶段被忽略（不猜一个新桶）', () => {
  const t = createDeliveryTrace();
  t.note('nonsense', 'x');
  const snap = t.snapshot();
  for (const s of STAGES) assert.equal(snap[s].events, 0);
});

// ── ② 关键区分一：某层**零事件** ⇒ 丢在「上游→本层」这一段 ─────────────────

test('② 捕获有事件、适配器零事件 ⇒ 必须指出丢在「驱动→relay」或更上游的某一段', () => {
  const t = createDeliveryTrace();
  t.note('capture', '网页生成的正文');
  t.note('decoder', '网页生成的正文');
  t.note('driver', '网页生成的正文');
  // relay 与 adapter 都没有事件 —— 这正是 Issue #1 的末梢症状形状
  const r = compareStages(t.snapshot());
  assert.equal(r.diverged, true);
  assert.equal(r.firstLossAt, 'relay', '首个分叉点必须落在 relay（驱动之后的第一层）');
  assert.match(r.detail, /零事件/, '必须说清是「零事件」而不是笼统的「不一致」');
});

// ── ③ 关键区分二：某层有事件但**更短** ⇒ 丢在**本层** ──────────────────────

test('③ 上游 100 字、本层 40 字（下游与流失一致）⇒ 说「丢在本层」，与零事件分开', () => {
  const t = createDeliveryTrace();
  // 真实形状：内容在 decoder→driver 这一段变少（正文层之间长度**可比**），
  // 之后各层逐字相同。
  // （首版只喂了 capture + decoder 两层：一来下游全空，首个分叉会正确落在更下游的
  //  「零事件」判定上；二来 capture 是**原始帧**，与正文长度本来就不可比。见 ③e。）
  t.note('capture', '{raw:"帧原文",x:1}');
  t.note('decoder', 'x'.repeat(100));
  for (const s of ['driver', 'relay', 'adapter']) t.note(s, 'x'.repeat(40));
  const r = compareStages(t.snapshot());
  assert.equal(r.diverged, true);
  assert.equal(r.firstLossAt, 'driver', '首个分叉必须落在真正变少的那一层');
  assert.match(r.detail, /丢在驱动（收到了但更少）/, '必须与「零事件」那一类在文案上可分辨');
  assert.ok(!/零事件/.test(r.detail), '本层有事件时不得说成零事件');
});

test('③e capture 是**原始帧**，不得因「原始帧比正文长」被判成分叉', () => {
  // 这一条防的是「工具天天喊狼来了」：SSE/Connect-RPC 的原始帧含字段名与转义，
  // 必然比解出来的正文长得多。若拿 capture 与 decoder 逐字比，**每一轮正常生成**
  // 都会被报成「丢在解码器」，很快这个工具就没人看了。
  const t = createDeliveryTrace();
  t.note('capture', '{"status":"WIP","parts":[{"content":"正文"}]}'.repeat(20));
  for (const s of ['decoder', 'driver', 'relay', 'adapter']) t.note(s, '正文');
  const r = compareStages(t.snapshot());
  assert.equal(r.diverged, false, '原始帧比正文长是正常的，不得判成分叉：' + r.detail);
  assert.match(r.detail, /长度与正文不可比/, '要在读数里说明为什么这一层不比长度');
});

test('③f 捕获有帧、解码器零正文 ⇒ 这才是真分叉（站点换帧格式的形态）', () => {
  const t = createDeliveryTrace();
  t.note('capture', '{"status":"WIP","parts":[]}');
  const r = compareStages(t.snapshot());
  assert.equal(r.diverged, true, '有帧却解不出正文，必须报分叉');
  assert.equal(r.firstLossAt, 'decoder');
  assert.match(r.detail, /零正文/);
});

// ── ④ 正向对照：全链一致 ⇒ 不得报分叉（修法不能把所有轮次都判成坏）─────────

test('④ 全链逐字一致 ⇒ diverged 必须是 false', () => {
  const t = createDeliveryTrace();
  for (const s of STAGES) t.note(s, '完全一致的正文');
  const r = compareStages(t.snapshot());
  assert.equal(r.diverged, false, '一致的链路不得报分叉：' + r.detail);
  assert.equal(r.firstLossAt, null);
});

test('④b 两侧都无事件的相邻层不算分叉（那是「未验证」，不是「丢了」）', () => {
  const t = createDeliveryTrace();
  t.note('adapter', '只有适配器有事件');
  const r = compareStages(t.snapshot());
  // capture→decoder→driver→relay 全都没有事件，但那是「未验证」而不是「丢在xxx」
  assert.equal(r.diverged, false, '全空的相邻段不得被判成内容丢失：' + r.detail);
  assert.match(r.detail, /未验证/);
});

// ── ⑤ 「下游反而更多」也要记一笔（权威全文 vs 增量通道）───────────────────

test('⑤ 上游零事件、下游有内容 ⇒ 记成「来自本层收尾路径」而不是丢失', () => {
  const t = createDeliveryTrace();
  // 真机形态（0.16.4 记过）：**增量通道**什么都没送，正文只存在于 decoder.finish()
  // 的权威全文里，之后经 driver→relay→adapter 逐字送达。
  // 所以形状必须是「driver 起有内容、之后各层都有」，而不是只喂一层——
  // 只喂一层时下游全空，判定会正确地报「丢在驱动→relay」（首版就是这么写错的）。
  const body = '只存在于权威全文里的正文';
  for (const s of ['driver', 'relay', 'adapter']) t.note(s, body);
  const r = compareStages(t.snapshot());
  assert.equal(r.diverged, false, '下游有内容不是「丢失」：' + r.detail);
  assert.match(r.detail, /自己的收尾路径/, '必须标明内容不是经增量通道来的：' + r.detail);
});

// ── ⑥ 跨轮复用是禁止的：一轮一个实例（旧读数冒充本轮是本仓库记过的缺陷）────

test('⑥ 两个实例互不影响（一轮一个实例，读数不串轮）', () => {
  const a = createDeliveryTrace();
  const b = createDeliveryTrace();
  a.note('capture', '第一轮');
  assert.equal(b.snapshot().capture.events, 0, '不同实例的读数必须完全隔离');
});