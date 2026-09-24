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
import { mapMouseInput, mapKeyInput, parseClientMessage, createLiveHub } from '../lib/live.js';

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

test('hub 全行为：握手 → 页面列表 → 帧下发+ack → 鼠标派发 → 关闭清场', async () => {
  const { driver, cdp } = fakeDriver();
  const { port, close } = await startHub(() => driver);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/webcode/live?account=deepseek`);
  const received = [];
  ws.onmessage = (ev) => received.push(JSON.parse(ev.data));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  // 握手 + 页面列表（hub 建连即推，且默认附到驱动当前页 → startScreencast 已发）
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(received[0].t, 'hello');
  assert.equal(received[0].account, 'deepseek');
  const pagesMsg = received.find((m) => m.t === 'pages');
  assert.equal(pagesMsg.pages[0].id, 'p1');
  assert.ok(cdp.sent.some(([cmd]) => cmd === 'Page.startScreencast'), '建连必须启动投屏');

  // 模拟一帧损伤：下发 frame + ack
  cdp.emit('Page.screencastFrame', { data: 'ZkBSQU1F', metadata: { deviceWidth: 1280, deviceHeight: 800 }, sessionId: 7 });
  await new Promise((r) => setTimeout(r, 100));
  const frameMsg = received.find((m) => m.t === 'frame');
  assert.equal(frameMsg.d, 'ZkBSQU1F');
  assert.equal(frameMsg.m.deviceWidth, 1280);
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

// ---- ③ 接线结构（无浏览器无法实例化 driver/client 的部分按仓库惯例源码断言）---

const driverSrc = readFileSync(join(pkg, 'lib', 'browser-driver.js'), 'utf8');
const indexSrc = readFileSync(join(pkg, 'lib', 'index.js'), 'utf8');
const clientSrc = readFileSync(join(pkg, 'lib', 'client.cjs'), 'utf8');

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
