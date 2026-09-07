// popup.js — consent gate + connection status.
'use strict';

const $ = (id) => document.getElementById(id);

function sendBg(msg) {
  return chrome.runtime.sendMessage(msg).catch(() => null);
}

async function refresh() {
  const st = await sendBg({ cmd: 'get-status' });
  if (!st) return;
  const { cfg: c, wsState, activeRequest } = st;
  $('agree').checked = c.consentAccepted;
  $('enabled').checked = c.enabled;
  $('enabled').disabled = !c.consentAccepted;
  if (document.activeElement !== $('bridgeUrl')) $('bridgeUrl').value = c.bridgeUrl;

  const el = $('ws-state');
  el.textContent = wsState === 'open' ? '已连接' : wsState === 'connecting' ? '连接中…' : '离线';
  el.className = 'state' + (wsState === 'open' ? ' on' : wsState === 'closed' || wsState === 'offline' ? ' err' : '');

  const parts = [];
  if (!c.consentAccepted) parts.push('未同意风险告知');
  else if (!c.enabled) parts.push('已同意，未启用');
  if (activeRequest) parts.push('执行中: ' + activeRequest.requestId.slice(0, 12));
  $('status').textContent = parts.join(' · ') || (wsState === 'open' ? '就绪：DSH 侧可调用 Web AI (webcode) 模型' : '');
}

$('agree').addEventListener('change', async (e) => {
  const accepted = e.target.checked;
  await sendBg({ cmd: 'set-config', config: { consentAccepted: accepted, enabled: accepted ? undefined : false } });
  // keep enabled untouched when agreeing; force-disable when revoking
  if (!accepted) await sendBg({ cmd: 'set-config', config: { enabled: false } });
  refresh();
});

$('enabled').addEventListener('change', async (e) => {
  await sendBg({ cmd: 'set-config', config: { enabled: e.target.checked } });
  refresh();
});

$('bridgeUrl').addEventListener('change', async (e) => {
  await sendBg({ cmd: 'set-config', config: { bridgeUrl: e.target.value.trim() } });
  refresh();
});

$('openSite').addEventListener('click', () => sendBg({ cmd: 'open-deepseek' }));
$('reconnect').addEventListener('click', async () => {
  await sendBg({ cmd: 'set-config', config: { enabled: $('enabled').checked } });
  refresh();
});

refresh();
setInterval(refresh, 1500);
