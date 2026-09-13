// image-blocks.test.mjs — harness 传图链路的护栏（0.13.0）。
//
// 症状：harness 截图 / 粘贴的图片传不到网页端，模型说「没看到图」。
//
// 真机根因（2026-09-13 代码取证）：0.12.9 的 imagesOfMessages 只认 **wire 形状**
//     b.url / b.imageUrl.url / b.image_url.url / b.source.data / b.data / b.base64
// 而 DSH 原生（harness 截图走的）图片块的真实形状是
//     { type: 'image', attachment: ImageAttachmentRef }
//（证据：dsh-llm/lib/types/types.d.ts 的 ImageBlock、
//  dsh-tool-fs/lib/index.js 里构造 image 块的那处）
// 两者**零交集** → imagesOfMessages 恒返回 [] → turn.meta.images 从不设置 →
// 驱动的 uploadImages 从不执行 → 每一次截图传图都被静默丢弃。
//
// 本文件锁三件事：
//   1. 原生 attachment 块必须被识别（这是 harness 传图的唯一形态）。
//   2. 像素必须经 attachments 服务取（块里没有字节），且两级降级都可用。
//   3. 取不到时**明确报错**，不得静默丢弃（静默正是旧 bug 的本质）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { imagesOfMessages, resolveImages } from '../lib/index.js';

/** 造一个 DSH 原生 image block（与真实形状一致：只有引用，没有字节）。 */
const durableBlock = (over = {}) => ({
  type: 'image',
  attachment: { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 1234, width: 10, height: 10, name: 'shot.png', ...over },
});

test('识别 DSH 原生 image block：harness 截图走的就是这条', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: '看图' }, durableBlock()] }];
  const out = imagesOfMessages(msgs);
  assert.equal(out.length, 1, '原生 attachment 块必须被识别（旧实现恒返回 0）');
  assert.equal(out[0].kind, 'durable');
  assert.ok(out[0].ref, '必须带 attachment 引用');
  assert.equal(out[0].contentType, 'image/png');
  assert.equal(out[0].name, 'shot.png');
});

test('wire 形状仍然兼容（OpenAI 前端 / 旧会话回放）', () => {
  const dataUrl = 'data:image/png;base64,' + 'A'.repeat(40);
  const msgs = [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'image', source: { data: 'B'.repeat(40), mediaType: 'image/jpeg' } },
      { type: 'image', base64: 'C'.repeat(40), mediaType: 'image/webp' },
    ],
  }];
  const out = imagesOfMessages(msgs);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((o) => o.kind), ['inline', 'inline', 'inline']);
  assert.equal(out[0].contentType, 'image/png');
  assert.equal(out[1].contentType, 'image/jpeg');
});

test('http(s) URL 走 remote 分支（由 resolveRemoteImages 抓取）', () => {
  const out = imagesOfMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/a.png' } }] }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'remote');
  assert.equal(out[0].url, 'https://example.com/a.png');
});

test('非图片块一律忽略，不得误吞', () => {
  const out = imagesOfMessages([
    { role: 'user', content: [{ type: 'text', text: 'no image' }, { type: 'image', attachment: null }, null] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user' },                                  // 无 content
    null,
  ]);
  assert.deepEqual(out, []);
});

test('resolveImages：原生块经 attachments.readImageRequest 取到请求版本', async () => {
  const calls = [];
  const attachments = {
    imageLimits: { maxImagesPerMessage: 6, maxImageBytes: 1024 * 1024 },
    async readImageRequest(ref, policy, signal) {
      calls.push({ ref, policy });
      return { mediaType: 'image/png', data: Buffer.from('PNGDATA'), width: 800, height: 600 };
    },
    async readImage() { throw new Error('不应走到这里'); },
  };
  const { images, skipped } = await resolveImages(imagesOfMessages([
    { role: 'user', content: [durableBlock()] },
  ]), attachments, undefined);

  assert.equal(skipped.length, 0);
  assert.equal(images.length, 1);
  assert.equal(images[0].contentType, 'image/png');
  assert.equal(images[0].data, Buffer.from('PNGDATA').toString('base64'));
  assert.equal(images[0].source, 'attachment-request');
  // 预算必须与 dsh-llm-deepseek 的默认档一致（否则与原生 DeepSeek 路由不同档）
  assert.equal(calls[0].policy.maxPixels, 640_000);
  assert.equal(calls[0].policy.maxBytes, 1_048_576);
});

test('resolveImages：request 版本失败时降级到原始字节', async () => {
  const attachments = {
    imageLimits: {},
    async readImageRequest() { throw new Error('route does not support request projection'); },
    async readImage(ref) { return { ref, data: Buffer.from('RAWBYTES') }; },
  };
  const { images, skipped } = await resolveImages(imagesOfMessages([
    { role: 'user', content: [durableBlock()] },
  ]), attachments, undefined);
  assert.equal(skipped.length, 0);
  assert.equal(images.length, 1);
  assert.equal(images[0].data, Buffer.from('RAWBYTES').toString('base64'));
  assert.equal(images[0].source, 'attachment-raw');
});

test('resolveImages：取不到像素必须**报出**，绝不静默丢弃', async () => {
  // 附件服务根本不可用
  const r1 = await resolveImages(imagesOfMessages([{ role: 'user', content: [durableBlock()] }]), null, undefined);
  assert.equal(r1.images.length, 0);
  assert.equal(r1.skipped.length, 1, '不可读的图片必须出现在 skipped 里（静默丢弃是旧 bug 的本质）');
  assert.match(r1.skipped[0].reason, /附件服务不可用/);

  // 服务在、但两级读取都失败
  const attachments = {
    imageLimits: {},
    async readImageRequest() { throw new Error('boom-request'); },
    async readImage() { throw new Error('boom-raw'); },
  };
  const r2 = await resolveImages(imagesOfMessages([{ role: 'user', content: [durableBlock()] }]), attachments, undefined);
  assert.equal(r2.images.length, 0);
  assert.equal(r2.skipped.length, 1);
  assert.match(r2.skipped[0].reason, /boom-raw/);
});

test('resolveImages：内联图片不需要 attachments 服务也能用', async () => {
  const dataUrl = 'data:image/png;base64,' + Buffer.from('INLINE').toString('base64');
  const { images, skipped } = await resolveImages(
    imagesOfMessages([{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }]),
    null, undefined,
  );
  assert.equal(skipped.length, 0);
  assert.equal(images.length, 1);
  assert.equal(images[0].data, Buffer.from('INLINE').toString('base64'));
});

test('resolveImages：空输入是安全的空结果', async () => {
  const r = await resolveImages([], null, undefined);
  assert.deepEqual(r, { images: [], skipped: [] });
});