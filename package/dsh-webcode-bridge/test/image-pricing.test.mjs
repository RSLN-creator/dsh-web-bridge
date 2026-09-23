// image-pricing.test.mjs — 0.19.3 护栏：桥缺 imageRequestPricing 让「手动压缩」必炸。
//
// ## 真机故障（用户原话）
//
// 「压缩每次手动触发就会：this.adapters.get(...)?.adapter.imageRequestPricing is not a
// function 报错！压缩功能 webcode 做不到！你可以自己验证！」
//
// ## 根因（不是压缩实现的问题）
//
// DSH 运行时取路由图片计价用的是**可选链取方法再接调用**：
//   `this.adapters.get(provider)?.adapter.imageRequestPricing(provider, model)`
// （dsh-llm/lib/index.js:1964）。`?.` 只护住两个取值，护不住方法本身——adapter 存在
// 而方法缺席时照样抛 TypeError。桥的 adapter 是对象字面量，在 lib/image-pricing.js 之前
// 没有实现它；而 token meter 的 `measure()` 每次测量都经 `_routeImagePricing`
// （dsh-token-meter/lib/index.js:644→689）走到那一行，`/compact` 拿的正是
// `ctx.tokenMeter.measure(...)`——于是「每次都炸」，与压缩实现无关。
//
// ## 本护栏钉住五件事
//
// ① **同源**：三条占位文案必须与 DSH 安装目录里的真函数逐字相同（那三个函数是唯一真相，
//    桥按字面量复刻，因为 profile 里没有 `@deepseek-ai/dsh-llm` 且契约要求同步返回）。
//    任一文案在 DSH 侧改动，这里立刻变红。
// ② **契约**：`priceImages` 同步返回、逐出现位置对齐（长度不等调用方会主动抛）、
//    绝不抛（畸形块也要给出一条价）。
// ③ **真计价**：文本路由按 textOnly 占位、带图路由保留图片按身份文本、被 offload 的优先
//    按 offload 占位；`visualTokens` 恒 0（webcode 站点没有公开视觉计量，桥不编造数字）。
// ④ **原故障形状**：用与 DSH 同一行的写法（`?.adapter.imageRequestPricing(...)`）复现——
//    空 adapter 必须抛，带本实现必须不抛。这条是回归本体，不是修辞。
// ⑤ **接线**：lib/index.js 的 adapter 字面量里必须真的声明了这个方法且接到本模块，
//    防止有人在某次重构里把它连同注释一起删掉。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  webcodeImageRequestPricing,
  textOnlyImagePlaceholder,
  offloadedImagePlaceholder,
  retainedImagePlaceholder,
} from '../lib/image-pricing.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * 找一份可 import 的 `@deepseek-ai/dsh-llm`。
 *
 * 为什么按候选表找而不是硬编码一条路径：本仓库同时跑在开发者机器与 CI 上，
 * 而这条断言的价值恰恰来自「对着**真实安装**的 DSH 比」。找不到就显式跳过并在输出里
 * 说明原因——静默通过会把这个护栏变成安慰剂。
 */
function locateDshLlm() {
  const candidates = [
    process.env.DSH_LLM_PATH,
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'),
    path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* 读不了就当没有，继续找下一个 */ }
  }
  return null;
}

const dshLlmPath = locateDshLlm();
const dshLlm = dshLlmPath ? await import(pathToFileURL(dshLlmPath).href) : null;

/** 合成 ref：DSH 的三条文案只读 attachmentId/name/width/height/mediaType。 */
const REF = Object.freeze({ attachmentId: 'sha256:0123456789abcdef', name: 'shot.png', width: 1280, height: 720, mediaType: 'image/png' });
const REF_ANON = Object.freeze({ attachmentId: 'sha256:fedcba9876543210', width: 64, height: 64, mediaType: 'image/jpeg' });

// ---------------------------------------------------------------------------
// ① 同源
// ---------------------------------------------------------------------------

test('① 三条占位文案与 DSH 真函数逐字相同（单源 + 护栏）', { skip: dshLlm ? false : `未找到 @deepseek-ai/dsh-llm（试过 DSH_LLM_PATH 与常见安装位置），跳过逐字比对` }, () => {
  for (const ref of [REF, REF_ANON]) {
    assert.equal(textOnlyImagePlaceholder(ref), dshLlm.textOnlyImageText(ref),
      'textOnly 占位与 dsh-llm 的 textOnlyImageText 出现漂移——改文案必须同时改两边');
    assert.equal(offloadedImagePlaceholder(ref), dshLlm.offloadedImageText(ref, undefined),
      'offload 占位与 dsh-llm 的 offloadedImageText(ref, 无 access) 出现漂移');
    assert.equal(retainedImagePlaceholder(ref), dshLlm.requestImageHandleText(ref, { width: ref.width, height: ref.height }, undefined),
      '保留图片的身份文本与 dsh-llm 的 requestImageHandleText(ref, 源尺寸, 无 access) 出现漂移');
  }
});

// ---------------------------------------------------------------------------
// ② 契约
// ---------------------------------------------------------------------------

test('② priceImages 同步返回，且逐出现位置对齐（长度不等调用方会抛）', () => {
  const pricing = webcodeImageRequestPricing({ acceptsImages: false });
  const images = [
    { type: 'image', attachment: REF },
    { type: 'image', attachment: REF_ANON, offloaded: true },
    { type: 'image', attachment: REF },
  ];
  const out = pricing.priceImages(images);
  assert.ok(!(out instanceof Promise), '契约要求同步返回（types/index.d.ts:142-148）');
  assert.equal(out.length, images.length, '一个出现位置一条价——错位会被 token meter 判为故障');
  for (const price of out) {
    assert.equal(typeof price.text, 'string');
    assert.equal(price.visualTokens, 0, 'webcode 没有公开视觉计量，不得编造 visualTokens');
  }
});

test('②b 绝不抛：畸形块、空数组、非数组都要活着返回', () => {
  const pricing = webcodeImageRequestPricing({ acceptsImages: true });
  assert.deepEqual(pricing.priceImages([]), []);
  assert.deepEqual(pricing.priceImages(undefined), [], '非数组不许抛（每次测量都会调到这里）');
  const weird = pricing.priceImages([{}, { attachment: null }, { offloaded: true }]);
  assert.equal(weird.length, 3, '畸形块也必须一对一给出价格，否则调用方按长度差抛错');
  for (const price of weird) assert.equal(typeof price.text, 'string');
});

// ---------------------------------------------------------------------------
// ③ 真计价
// ---------------------------------------------------------------------------

test('③ 文本路由：图片按 textOnly 占位计价（不是「引用 JSON 的字符数」）', () => {
  const pricing = webcodeImageRequestPricing({ acceptsImages: false });
  const [price] = pricing.priceImages([{ type: 'image', attachment: REF }]);
  assert.equal(price.text, textOnlyImagePlaceholder(REF));
  assert.ok(price.text.includes('accepts text only'), '文本路由送进模型的就是这句占位');
});

test('③b 带图路由：保留图片按身份文本计价；offloaded 标记优先于路由能力', () => {
  const pricing = webcodeImageRequestPricing({ acceptsImages: true });
  const [retained, offloaded] = pricing.priceImages([
    { type: 'image', attachment: REF },
    { type: 'image', attachment: REF, offloaded: true },
  ]);
  assert.equal(retained.text, retainedImagePlaceholder(REF));
  assert.ok(retained.text.includes('request preview 1280x720px'), '尺寸口径写进文案，便于核对');
  assert.equal(offloaded.text, offloadedImagePlaceholder(REF), 'offload 决策与路由是否带图无关');
});

// ---------------------------------------------------------------------------
// ④ 原故障形状（回归本体）
// ---------------------------------------------------------------------------

test('④ 复现原故障：同一行写法下空 adapter 必抛、本实现必不抛', () => {
  // 与 DSH 运行时逐字同形的取法（dsh-llm/lib/index.js:1964）。
  const call = (adapter) => ({ adapters: new Map([['webcode', { adapter }]]) }).adapters.get('webcode')?.adapter.imageRequestPricing('webcode', 'deepseek-web');

  assert.throws(() => call({}), TypeError,
    '空 adapter 必须在这里抛——这正是用户看到的 is not a function；抛不出说明本用例没复现到故障');

  const pricing = call({ imageRequestPricing: () => webcodeImageRequestPricing({ acceptsImages: false }) });
  assert.ok(pricing && typeof pricing.priceImages === 'function', '补上方法后同一行取法必须拿到计价对象');
  assert.equal(pricing.priceImages.length >= 1, true);
});

// ---------------------------------------------------------------------------
// ⑤ 接线
// ---------------------------------------------------------------------------

test('⑤ lib/index.js 的 adapter 真的声明了 imageRequestPricing 并接到本模块', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'lib', 'index.js'), 'utf8');
  assert.ok(src.includes("import { webcodeImageRequestPricing } from './image-pricing.js';"),
    '接线被删：adapter 又会缺方法，手动压缩回到必炸状态');
  assert.match(src, /imageRequestPricing\(_provider, model\)\s*\{/,
    'adapter 字面量里必须有该方法的实现（缺了就是本次故障复发）');
  assert.ok(src.includes('webcodeImageRequestPricing({ acceptsImages })'),
    '方法体必须真的调用计价工厂，而不是返回一个占位 undefined');
});

// ---------------------------------------------------------------------------
// ⑥ 官方 token meter 真的消费了它
// ---------------------------------------------------------------------------

/**
 * 找一份可 import 的 `dsh-token-meter/lib/types/route-pricing.js`。
 * 它**不在** package exports 里（只导出 `.` / `./client` / `./src/*` / `./estimate`），
 * 所以只能按安装路径取——与上面取 dsh-llm 真函数同一手法。
 */
function locateMeterRoutePricing() {
  const candidates = [
    process.env.DSH_TOKEN_METER_PATH,
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-token-meter', 'lib', 'types', 'route-pricing.js'),
    path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-token-meter', 'lib', 'types', 'route-pricing.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-token-meter/lib/types/route-pricing.js',
  ].filter(Boolean);
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* 读不了就当没有 */ }
  }
  return null;
}

test('⑥ 官方 token meter 真的消费本计价（读数会变），错位会被它主动拦下', { skip: locateMeterRoutePricing() ? false : '未找到 dsh-token-meter，跳过「官方 meter 真实消费」这一跳' }, async () => {
  const meterDir = path.dirname(path.dirname(path.dirname(locateMeterRoutePricing())));
  const { priceSurface } = await import(pathToFileURL(path.join(meterDir, 'lib', 'types', 'route-pricing.js')).href);
  const { estimateStructuralBlock, estimateContent } = await import(pathToFileURL(path.join(meterDir, 'lib', 'types', 'estimate.js')).href);

  // 一个带图片的 surface 节点，形状与 dsh-token-meter 的 analyzeNode 一致。
  const imageBlock = { type: 'image', attachment: REF };
  const node = {
    seq: 1,
    heuristicTokens: 500,
    imageStructuralTokens: estimateStructuralBlock(imageBlock),
    fileStructuralTokens: 0,
    images: [imageBlock],
    files: [],
  };

  const before = priceSurface([node], undefined, undefined).surfaceTokens;
  assert.equal(before, 500, 'pricing=undefined 时官方 meter 保留固定启发式（这就是 0.19.3 之前 webcode 的图片计价）');

  const after = priceSurface([node], webcodeImageRequestPricing({ acceptsImages: false }), undefined).surfaceTokens;
  assert.notEqual(after, before,
    '桥的计价必须真的改变 meter 读数——否则「让图片计入 token meter」是空头承诺（形状对但没被消费）');
  const expected = 500 - node.imageStructuralTokens
    + estimateContent([{ type: 'text', text: textOnlyImagePlaceholder(REF) }]);
  assert.equal(after, expected,
    'meter 的算法必须是「减去结构化启发式 + 加上按占位文本估算」——对不上说明我们读错了消费口径');

  // 契约的判据是双向的：本实现永不触发这条 throw，但必须证明这条 throw 真的存在
  //（否则「对齐」只是我们自己的说法，没有可失败的判据）。
  assert.throws(() => priceSurface([node], { priceImages: () => [] }, undefined),
    /answered 0 prices for 1 occurrences/,
    '官方 meter 对错位计价会主动抛错；本实现返回等长数组，因此永不触发它');
});
