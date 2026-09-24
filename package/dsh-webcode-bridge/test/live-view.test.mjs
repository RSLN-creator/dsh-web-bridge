// live-view.test.mjs — 工作区画面流（路线 B）的护栏（0.20.0）。
//
// 钉住三层：
//   ① 输入映射纯函数（lib/live.js mapMouseInput / mapKeyInput / parseClientMessage）：
//      客户端消息 → CDP Input 参数的形状收敛。反向线：非法动作/缺坐标/超长消息
//      必须被丢弃或裸通过，绝不把垃圾形状送进 CDP。
//   ② hub 全行为（假驱动 + 假 CDP 会话 + 真 WebSocket）：建连握手（hello/pages）、
//      帧下发与 ack、输入派发、非回环 Origin 拒绝。CDP 会话只依赖 {send,on,off,
//      detach} 最小接口，因此可以在无浏览器的情况下把 hub 的每条消息路径都跑到。
//   ③ 接线结构：driver 必须带 live API 并放进返回对象；中继必须有 upgrade 钩子；
//      客户端必须有 LivePane 与镜像回落按钮。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mapMouseInput, mapKeyInput, parseClientMessage, createLiveHub, viewportForPanel } from '../lib/live.js';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);

// ---- ① 输入映射纯函数 -----------------------------------------------------

test('鼠标按下：完整形状（type/x/y/button/clickCount）', () => {
  const p = mapMouseInput({ action: 'pressed', x: 12.6, y: 8.2, button: 'left', buttons: 1, clickCount: 1 });
  assert.equal(p.type, 'mousePressed');
  assert.equal(p.x, 13);           // 取整，不做浮点坐标
  assert.equal(p.y, 8);
  assert.equal(p.button, 'left');
  assert.equal(p.buttons, 1);
  assert.equal(p.clickCount, 1);
});

test('滚轮：mouseWheel + delta 原样透传（缺省补 0）', () => {
  const p = mapMouseInput({ action: 'wheel', x: 1, y: 2, deltaY: -120 });
  assert.equal(p.type, 'mouseWheel');
  assert.equal(p.deltaY, -120);
  assert.equal(p.deltaX, 0);
});

test('反向线：未知动作 / 缺坐标 / 按钮越界 → null 或收敛', () => {
  assert.equal(mapMouseInput({ action: 'teleport', x: 1, y: 2 }), null);
  assert.equal(mapMouseInput({ action: 'pressed', y: 2 }), null);
  const p = mapMouseInput({ action: 'pressed', x: 1, y: 2, button: 'laser', buttons: 99 });
  assert.equal(p.button, 'none');
  assert.equal(p.buttons, 7);      // 位掩码钳到 0..7
});

test('键盘：可打印键带 text，keyup 无 text，修饰键位掩码', () => {
  const down = mapKeyInput({ action: 'key', key: 'a', code: 'KeyA', keyCode: 65, text: 'a', ctrl: true, shift: true });
  assert.equal(down.type, 'keyDown');
  assert.equal(down.text, 'a');
  assert.equal(down.windowsVirtualKeyCode, 65);
  assert.equal(down.modifiers, 2 | 8);   // ctrl=2, shift=8
  const up = mapKeyInput({ action: 'keyup', key: 'a', code: 'KeyA', keyCode: 65 });
  assert.equal(up.type, 'keyUp');
  assert.equal(up.text, undefined);
  assert.equal(up.modifiers, 0);
});

test('parseClientMessage：合法对象过，垃圾/超长/数组一律 null', () => {
  assert.deepEqual(parseClientMessage('{"t":"mouse"}'), { t: 'mouse' });
  assert.equal(parseClientMessage('not json'), null);
  assert.equal(parseClientMessage('[1,2]'), null);
  assert.equal(parseClientMessage('"' + 'x'.repeat(5000) + '"'), null);
  assert.equal(parseClientMessage(''), null);
});

// ---- ② hub 全行为（假驱动 + 真 WebSocket）---------------------------------

/** 假 CDP 会话：记录 send 调用，可手动触发 on 注册的事件。 */
function fakeCdp(pageId) {
  const sent = [];
  const handlers = new Map();
  let detached = false;
  return {
    sent,
    pageId,
    send: async (cmd, params) => { sent.push([cmd, params]); return {}; },
    on: (ev, cb) => { handlers.set(ev, cb); },
    off: (ev) => { handlers.delete(ev); },
    detach: async () => { detached = true; },
    get isDetached() { return detached; },
    emit: (ev, payload) => handlers.get(ev)?.(payload),
  };
}

function fakeDriver() {
  const cdp = fakeCdp('p1');
  const driver = {
    live: {
      async listPages() { return [{ id: 'p1', title: 'Test Page', url: 'about:blank', active: true }]; },
      async attach() { return cdp; },
      async openPage() { return []; },
      async closePage() { return { ok: true }; },
      async activatePage() { return { ok: true }; },
      onPagesChanged() { return () => {}; },
    },
  };
  return { driver, cdp };
}

/** 起一个临时 http server + hub，返回 {url, close, hub}。 */
async function startHub(getDriver) {
  const hub = createLiveHub({ getDriver, log: () => {}, warn: () => {} });
  const server = http.createServer(() => {});
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));
  const port = server.address().port;
  return { hub, port, close: () => new Promise((res) => server.close(res)) };
}

test('hub 全行为：握手 → 页面列表 → 二进制帧+ack → 鼠标派发 → 关闭清场', async () => {
  const { driver, cdp } = fakeDriver();
  const { port, close } = await startHub(() => driver);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/webcode/live?account=deepseek`);
  ws.binaryType = 'arraybuffer';
  const received = [];
  const frames = [];
  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') { received.push(JSON.parse(ev.data)); return; }
    // 与客户端同一套二进制解码：[metaLen u16be][metaJSON][jpeg]
    const view = new DataView(ev.data);
    const metaLen = view.getUint16(0);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ev.data, 2, metaLen)));
    frames.push({ meta, jpeg: new Uint8Array(ev.data, 2 + metaLen) });
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  // 握手 + 页面列表（hub 建连即推，且默认附到驱动当前页 → startScreencast 已发）
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(received[0].t, 'hello');
  assert.equal(received[0].account, 'deepseek');
  const pagesMsg = received.find((m) => m.t === 'pages');
  assert.equal(pagesMsg.pages[0].id, 'p1');
  assert.ok(cdp.sent.some(([cmd]) => cmd === 'Page.startScreencast'), '建连必须启动投屏');

  // 模拟一帧损伤：二进制下发 + ack（jpeg 字节必须与 base64 解码后逐字一致）
  cdp.emit('Page.screencastFrame', { data: 'ZkBSQU1F', metadata: { deviceWidth: 1280, deviceHeight: 800 }, sessionId: 7 });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(frames.length, 1, '帧必须以二进制包到达');
  assert.equal(frames[0].meta.deviceWidth, 1280);
  assert.equal(Buffer.from(frames[0].jpeg).toString('utf8'), 'f@RAME', 'jpeg 字节逐字保真（无 base64 二次转换）');
  const ack = cdp.sent.find(([cmd, p]) => cmd === 'Page.screencastFrameAck');
  assert.deepEqual(ack[1], { sessionId: 7 }, '每帧必须 ack，否则 Chromium 停发');

  // 输入派发：合法鼠标消息 → CDP 参数；非法消息 → 丢弃不抛
  ws.send(JSON.stringify({ t: 'mouse', action: 'pressed', x: 10, y: 20, button: 'left', buttons: 1 }));
  await new Promise((r) => setTimeout(r, 100));
  const dispatch = [...cdp.sent].reverse().find(([cmd]) => cmd === 'Input.dispatchMouseEvent');
  assert.equal(dispatch[1].type, 'mousePressed');
  assert.equal(dispatch[1].x, 10);
  ws.send(JSON.stringify({ t: 'mouse', action: 'teleport' }));
  ws.send('garbage');
  await new Promise((r) => setTimeout(r, 80));

  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(cdp.isDetached, '连接关闭必须 detach CDP 会话');
  await close();
});

test('安全面：非回环 Origin 的 upgrade 被拒绝（socket 立即销毁）', async () => {
  const { driver } = fakeDriver();
  const { port, close } = await startHub(() => driver);
  const err = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/webcode/live?account=deepseek',
      headers: { connection: 'Upgrade', upgrade: 'websocket', origin: 'https://evil.example',
        'sec-websocket-key': 'x3JJHMbDL1EzLkh9GBhXDw==', 'sec-websocket-version': 13 },
    });
    req.on('upgrade', () => resolve(null));
    req.on('error', resolve);
    req.on('close', () => setTimeout(() => resolve(new Error('socket closed')), 30));
    req.end();
  });
  assert.ok(err, '非回环 Origin 不得完成 upgrade');
  await close();
});

test('安全面：驱动缺 live API（如旧版驱动/未知槽抛错）→ 回 bye 并关闭', async () => {
  const { port, close } = await startHub(() => ({}));
  const ws = new WebSocket(`ws://127.0.0.1:${port}/webcode/live?account=deepseek`);
  const first = await new Promise((res) => { ws.onmessage = (ev) => res(JSON.parse(ev.data)); });
  assert.equal(first.t, 'bye');
  await close();
});

// ---- 视口自适应（0.20.2：真机反馈「不适配大小 + 画质低」）-------------------

test('viewportForPanel：面板 CSS 尺寸 ×2 超采样，宽高双钳制（720–1280 / 900–2000）', () => {
  assert.deepEqual(viewportForPanel(460, 860), { width: 920, height: 1720 });   // 典型侧栏
  assert.deepEqual(viewportForPanel(300, 300), { width: 720, height: 900 });    // 窄面板：宽度顶到下限
  assert.deepEqual(viewportForPanel(900, 1600), { width: 1280, height: 2000 }); // 大面板：双上限
  assert.deepEqual(viewportForPanel(), { width: 1024, height: 1440 });          // 缺省（resize 未到）
  assert.deepEqual(viewportForPanel(-5, 0), { width: 1024, height: 1440 });     // 非法回落默认
});

test('hub 行为：建连即下发视口仿真；resize 变尺寸同会话重设（不重建会话）', async () => {
  const { driver, cdp } = fakeDriver();
  const { port, close } = await startHub(() => driver);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/webcode/live?account=deepseek`);
  const received = [];
  ws.onmessage = (ev) => received.push(JSON.parse(ev.data));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(cdp.sent.some(([cmd, p]) => cmd === 'Emulation.setDeviceMetricsOverride' && p.width === 1024 && p.height === 1440),
    '建连默认视口必须有 Emulation 仿真（超采样分辨率）');
  const startBefore = cdp.sent.filter(([cmd]) => cmd === 'Page.startScreencast').length;

  ws.send(JSON.stringify({ t: 'resize', w: 460, h: 860 }));
  await new Promise((r) => setTimeout(r, 120));
  const emu = [...cdp.sent].reverse().find(([cmd]) => cmd === 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual([emu[1].width, emu[1].height], [920, 1720], 'resize 必须按面板 ×2 重设视口');
  assert.equal(cdp.sent.filter(([cmd]) => cmd === 'Page.startScreencast').length, startBefore + 1,
    'resize 重启投屏但不重建 CDP 会话');
  // 重启必须先 stop 再 start（否则新上限不保证生效）
  const lastStop = cdp.sent.map(([cmd]) => cmd).lastIndexOf('Page.stopScreencast');
  const lastStart = cdp.sent.map(([cmd]) => cmd).lastIndexOf('Page.startScreencast');
  assert.ok(lastStop > -1 && lastStop < lastStart, '投屏重启顺序必须 stop → start');

  // 同尺寸重复 resize：跳过（拖拽连发的防抖兜底）
  const before = cdp.sent.length;
  ws.send(JSON.stringify({ t: 'resize', w: 460, h: 860 }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(cdp.sent.length, before, '同尺寸 resize 不得重发任何 CDP 命令');

  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  await close();
});

test('自适应画质：密集帧切 lo（q55），静止后回 hi（q90）；单帧不触发切换', async () => {
  const { driver, cdp } = fakeDriver();
  const { port, close } = await startHub(() => driver);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/webcode/live?account=deepseek`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = () => {};
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await new Promise((r) => setTimeout(r, 150));
  const startsWithQ = () => [...cdp.sent].reverse().find(([cmd]) => cmd === 'Page.startScreencast')?.[1].quality;

  cdp.emit('Page.screencastFrame', { data: 'ZkBSQU1F', metadata: {}, sessionId: 1 });
  await new Promise((r) => setTimeout(r, 450));
  assert.notEqual(startsWithQ(), 55, '单帧不得触发降质');

  for (let i = 0; i < 5; i++) {
    cdp.emit('Page.screencastFrame', { data: 'ZkBSQU1F', metadata: {}, sessionId: 10 + i });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(startsWithQ(), 55, '运动态必须降到 q55 提帧率');
  await new Promise((r) => setTimeout(r, 1400));
  assert.equal(startsWithQ(), 90, '静止后必须回 q90 保文字锐度');

  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  await close();
});

test('WebRTC：rtc-offer 注入目标页、answer 回传、成功停投屏；rtc-failed 回落投屏', async () => {
  const { driver, cdp } = fakeDriver();
  // 假 CDP 对 Runtime.evaluate 回一个成功 answer
  cdp.send = async (cmd, params) => {
    cdp.sent.push([cmd, params]);
    if (cmd === 'Runtime.evaluate') {
      assert.ok(params.expression.includes('getDisplayMedia'), '注入脚本必须走页面自采');
      assert.ok(params.awaitPromise === true, '注入必须 await');
      return { result: { value: JSON.stringify({ ok: true, sdp: 'ANSWER-SDP', candidates: [{ candidate: 'c1' }] }) } };
    }
    return {};
  };
  const { port, close } = await startHub(() => driver);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/webcode/live?account=deepseek`);
  ws.binaryType = 'arraybuffer';
  const msgs = [];
  ws.onmessage = (ev) => { if (typeof ev.data === 'string') msgs.push(JSON.parse(ev.data)); };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await new Promise((r) => setTimeout(r, 150));
  ws.send(JSON.stringify({ t: 'rtc-offer', sdp: 'OFFER-SDP', candidates: [] }));
  await new Promise((r) => setTimeout(r, 150));
  const answer = msgs.find((m) => m.t === 'rtc-answer');
  assert.ok(answer, '必须回 rtc-answer');
  assert.equal(answer.sdp, 'ANSWER-SDP');
  assert.ok(cdp.sent.some(([cmd]) => cmd === 'Page.stopScreencast'), 'RTC 接管后必须停投屏');
  ws.send(JSON.stringify({ t: 'rtc-failed' }));
  await new Promise((r) => setTimeout(r, 120));
  const lastStart = [...cdp.sent].reverse().find(([cmd, p]) => cmd === 'Page.startScreencast');
  assert.ok(lastStart, 'rtc-failed 后必须重启投屏（自动降级）');
  ws.close();
  await new Promise((r) => setTimeout(r, 100));
  await close();
});

// ---- ③ 接线结构（无浏览器无法实例化 driver/client 的部分按仓库惯例源码断言）---

const driverSrc = readFileSync(join(pkg, 'lib', 'browser-driver.js'), 'utf8');
const indexSrc = readFileSync(join(pkg, 'lib', 'index.js'), 'utf8');
const clientSrc = readFileSync(join(pkg, 'lib', 'client.cjs'), 'utf8');

test('接线：liveHeaded 有头三件套（旗标+隐藏）与客户端 video/降级结构', () => {
  assert.ok(driverSrc.includes('cfg.liveHeaded === true ? [') && driverSrc.includes('--use-fake-ui-for-media-stream'), '有头分支必须有 RTC 相关旗标');
  assert.ok(driverSrc.includes('function hideWindowFromTaskbar(') && driverSrc.includes('WS_EX_TOOLWINDOW'.slice(0,0) + 'SetWindowLongPtr'), '必须有任务栏隐藏 helper');
  assert.ok(indexSrc.includes('liveHeaded: true,') && (indexSrc.match(/liveHeaded: cfg.liveHeaded/g)||[]).length >= 2, 'liveHeaded 必须声明并双槽传入');
  assert.ok(clientSrc.includes('new RTCPeerConnection()') && clientSrc.includes('rtc-failed'), '客户端必须有 WebRTC 与自动降级');
  assert.ok(clientSrc.includes('hwb-live-video'), '必须有 video 元素');
});

test('接线：driver 返回对象带 live；activatePage 绝不改写自动化页；拒绝关自动化页', () => {
  assert.ok(/setImageLimitsProvider, live \}/.test(driverSrc), 'driver 返回对象必须含 live');
  const start = driverSrc.indexOf('const live = {');
  const end = driverSrc.indexOf('sessionSlot 与 status', start);
  const body = driverSrc.slice(start, end);
  assert.ok(body.includes('bringToFront'), 'activatePage 用 bringToFront（不 repoint 自动化页）');
  assert.ok(body.includes("reason: 'automation-page'"), '关闭自动化页必须拒绝');
  assert.ok(body.includes('newCDPSession'), 'attach 走 ctx.newCDPSession');
});

test('接线：中继挂 onUpgrade；index.js 建 liveHub 并接 driverFor', () => {
  const relaySrc = readFileSync(join(pkg, 'lib', 'relay.js'), 'utf8');
  assert.ok(relaySrc.includes("httpServer.on('upgrade', cfg.onUpgrade)"));
  assert.ok(indexSrc.includes('createLiveHub({ getDriver: (accountKey) => driverFor(accountKey)'));
});

test('接线：客户端有 LivePane、LIVE_SITES（先 DeepSeek）与镜像回落按钮', () => {
  assert.ok(clientSrc.includes('function LivePane('));
  assert.ok(clientSrc.includes("new Set(['deepseek'])"), 'P1 先 DeepSeek');
  assert.ok(clientSrc.includes('改用镜像页'), '必须保留镜像回落入口');
  assert.ok(clientSrc.includes('/webcode/live?account='));
});

test('接线：客户端上报 resize（建连一次 + ResizeObserver 防抖）且 canvas 按 DPR 绘制', () => {
  assert.ok(clientSrc.includes("send({ t: 'resize', w: Math.round(box.clientWidth), h: Math.round(box.clientHeight) })"));
  assert.ok(clientSrc.includes('new ResizeObserver'), '容器尺寸变化必须上报');
  assert.ok(clientSrc.includes("Math.round(box.clientWidth * dpr)"), 'canvas 必须按 devicePixelRatio 放大，否则超采样白费');
});

test('反向线：点击换算必须对齐 dpr 坐标空间（0.20.2 真机「点击没反应」的首因）', () => {
  assert.ok(clientSrc.includes('(e.clientX - r.left) * f.dpr'), '鼠标 CSS 像素必须乘 dpr 对齐 backing-store 空间');
});
