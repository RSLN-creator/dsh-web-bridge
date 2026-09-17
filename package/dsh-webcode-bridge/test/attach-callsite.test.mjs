// attach-callsite.test.mjs — 「超长提示词真的走了附件」这条接线（0.16.3）。
//
// ## 为什么需要它（这是本项目反复踩过的一类假绿）
//
// 0.16.2 里 `uploadTextAttachment` 与 `promptTransportPlan` **都写好了**，但：
//   ① `attachInlineLimitChars` 默认 0（关闭），
//   ② `uploadTextAttachment` 的定义被插进了 `uploadImages` 的 `if (!hit) { … }` 内部。
// 结果是所有纯函数单测全绿，而这条能力**一次都没在真机上跑过**——用户抱怨的
// 「说做了、其实没做」正是这个形状。
//
// 本文件把「调用点真的接了」变成离线可判的判据：不是测 `uploadTextAttachment`
// 自己（那是 upload-attachment-structure.test.mjs 的事），而是测 **runTurn 有没有
// 在正确的条件下调用它、并把上传结果如实记录下来**。
//
// ## 为什么走源码断言而不是注入假 page
//
// 真实的附件投递需要一个 Playwright 页面（隐藏 input + 预览节点 + 轮询确认）。
// 本机没有可用的离线页面替身，而 mock fetch 那种「建模失真」的替身已经被
// doc/progress.md 记过一次教训（`client-render.test.mjs` 的 mock 不看方法，
// 把「服务端没这条路由」整个盖住）。因此这里选择**断言接线事实**，并明确写出
// 它的边界：它证明的是「调用点接了、条件对了、读数记了」，
// **不证明**「DeepSeek 网页真的接受了 .md 附件」——后者只能在真机上读
// `GET /__webcode/attach-entry` 与 `GET /__webcode/status` 的 `attachTransport`。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.dirname(here);
const src = fs.readFileSync(path.join(pkg, 'lib', 'browser-driver.js'), 'utf8');

/** 取 `start` 起的一段源码。长度要够读到**回落分支**的 attachTransport 赋值——
 *  那一段在 try/catch 之后，比成功路径远 1k 字符左右；截短了会得到一条假红
 *  （「回落路径没有记录」），而真因只是本函数的窗口太小。 */
function sliceFrom(marker, length = 4_800) {
  const at = src.indexOf(marker);
  assert.ok(at >= 0, '在 lib/browser-driver.js 里找不到锚点：' + marker);
  return src.slice(at, at + length);
}

const callSite = sliceFrom('if (!attachEvidence) {');

// ── ① 调用点必须真的调用 uploadTextAttachment ──────────────────────────────

test('① runTurn 的投递计划分支必须真的调用 uploadTextAttachment（不是只写了计划）', () => {
  assert.match(callSite, /await uploadTextAttachment\(attachText, \{ name: attachName \}\)/,
    '调用点没有调用 uploadTextAttachment：计划算出来了但没人用，等于这条能力只停在纸面上');
});

// ── ② 阈值真的从配置面读进来（否则「默认开」是假的）───────────────────────

test('② 计划必须读 cfg.attachInlineLimitChars，且 attachEnabled 与阈值同源', () => {
  assert.match(callSite, /inlineLimit: cfg\.attachInlineLimitChars/, '阈值没从配置面读');
  assert.match(callSite, /attachEnabled: cfg\.attachInlineLimitChars > 0/,
    'attachEnabled 必须与阈值同源：两处各写一份判据必然漂移，'
    + '「0 = 关闭」的语义会静默失效');
});

// ── ③ 超上限必须**尾部**保留 + 头部留痕（绝不静默丢内容）──────────────────

test('③ 截断时保留尾部、并在文件开头写明「已省略前 N 字符」', () => {
  assert.match(callSite, /attachText\.slice\(-plan\.payloadChars\)/,
    '截断必须保留**尾部**（尾部才是当下要执行的那一步），不能默认切头');
  assert.match(callSite, /【本文件已省略前 ' \+ omitted \+ ' 字符】/,
    '丢掉头部必须留痕：少这句话，模型会把「没看到」当成「不存在」，用户也看不出投了半截');
  assert.match(callSite, /omitted = plan\.total - plan\.payloadChars/, 'omitted 的计算口径必须可复算');
});

// ── ④ composer 正文必须换成本地指令：要求模型先读附件 ──────────────────────

test('④ 上传成功后 composer 正文必须换短指令，且明确要求先读附件全文', () => {
  const swap = src.slice(src.indexOf("message = '提示词正文已作为附"), src.indexOf("message = '提示词正文已作为附") + 400);
  assert.ok(swap.length > 0, '上传成功后没有替换 composer 正文——等于附件与指令都没送出去');
  assert.match(swap, /请先读取该附件全文/,
    '正文必须要求模型先读附件：模型未必会自动读，少这句就可能拿着 40 字指令空转');
});

// ── ⑤ 成功与回落两条路径都必须留下可核对读数 ──────────────────────────────

test('⑤ attachTransport 必须记录成功与回落两种结果（不能只留 warn 日志）', () => {
  assert.match(callSite, /attachTransport = \{\s*\n\s*at: Date\.now\(\), name: info\.name/,
    '成功路径没有落 attachTransport');
  assert.match(callSite, /attachTransport = \{ at: Date\.now\(\), fallback: true, code:/,
    '回落路径没有落 attachTransport：附件失败被 catch 吞掉后只留一行 warn，'
    + '用户侧看到「照样发出去了」，于是「到底有没有真的走附件」无从判断');
  assert.match(src, /^\s*attachTransport,$/m, 'attachTransport 必须进 status() 投影，否则 /status 读不到');
});

// ── ⑥ 反向安全线：图片轮不得被附件逻辑二次覆盖 ────────────────────────────

test('⑥ 已有图片附件时不得再走文本附件（`!attachEvidence` 守卫）', () => {
  assert.match(callSite, /^if \(!attachEvidence\) \{/,
    '缺少 `!attachEvidence` 守卫：带图轮会再塞一个 .md 附件，'
    + '而图片轮的附件确认证据与文本附件共用同一套探针，冲突时判不出是谁的');
});

// ── ⑦ inline 分支必须归零截断字段（口径与事实一致）────────────────────────
//
// 实测发现的歧义（0.16.3 修）：`attachSupported:false`（页面没有上传入口）且 chars
// 超上限时，plan 曾返回 `mode:'inline', truncate:true, payloadChars:1500000`，
// 而 inline 路径**一个字符都不会截**——2,000,000 字符原样写进输入框。
// 字段名说的是「会发多少」，读数却是「假如走附件会上传多少」。今天没有故障
// （调用点只在 attach 分支读它），但它是下一次「按读数做决策」的陷阱。

test('⑦ inline 分支的 payloadChars 必须等于真正外发的 total，truncate 必须为 false', async () => {
  const { promptTransportPlan } = await import('../lib/browser-driver.js');
  const inlineCases = [
    // 页面没有上传入口（探测结果）⇒ 回落 inline
    { chars: 2_000_000, inlineLimit: 60_000, attachEnabled: true, attachSupported: false, maxChars: 1_500_000 },
    // 配置关掉附件（0 = 关闭）⇒ 永远 inline
    { chars: 2_000_000, inlineLimit: 0, attachEnabled: false, attachSupported: true, maxChars: 1_500_000 },
    // 未超阈值 ⇒ inline
    { chars: 100, inlineLimit: 60_000, attachEnabled: true, attachSupported: true, maxChars: 1_500_000 },
  ];
  for (const o of inlineCases) {
    const plan = promptTransportPlan(o);
    assert.equal(plan.mode, 'inline', JSON.stringify(o));
    assert.equal(plan.truncate, false,
      'inline 路径不截断任何字符，truncate 就必须是 false：' + JSON.stringify(plan));
    assert.equal(plan.payloadChars, plan.total,
      'inline 时 payloadChars 必须等于真正外发的 total：' + JSON.stringify(plan));
    assert.equal(plan.kept, null, 'inline 没有「保留了多少」这回事：' + JSON.stringify(plan));
  }
  // 对照：真的走附件且超上限时，这三个字段才表达「截断后上传多少」。
  const attach = promptTransportPlan({
    chars: 2_000_000, inlineLimit: 60_000, attachEnabled: true, attachSupported: true, maxChars: 1_500_000,
  });
  assert.equal(attach.mode, 'attach');
  assert.equal(attach.truncate, true);
  assert.equal(attach.payloadChars, 1_500_000);
  assert.equal(attach.kept, 1_500_000);
});
