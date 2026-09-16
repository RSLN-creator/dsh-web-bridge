// real-probe-session-api.mjs — inspect real DeepSeek web session list + history payload shapes.
import { createBrowserDriver } from '../lib/browser-driver.js';

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/',
  profileDir: 'd:/9_Code_Workspace/dsh-webcode-bridge/.edge-real-profile',
  headless: true,
  requestTimeoutMs: 60_000,
  logger: console,
});

const timer = setTimeout(() => { console.log('GLOBAL-TIMEOUT'); process.exit(2); }, 120_000);
try {
  const conn = await driver.connect();
  console.log('loggedIn=', conn.loggedIn);
  if (!conn.loggedIn) process.exit(3);

  // 1) session list payload shape
  const listRaw = await driver.webApi('/api/v0/chat_session/fetch_page?count=5', { method: 'GET' });
  console.log('LIST status=', listRaw.status, 'ok=', listRaw.ok);
  const listJson = listRaw.json ?? {};
  const listData = listJson.data ?? listJson;
  const biz = listData?.biz_data ?? listData;
  console.log('LIST top-level keys=', Object.keys(listJson).join(','));
  console.log('LIST data keys=', Object.keys(listData || {}).join(','));
  console.log('LIST biz keys=', Object.keys(biz || {}).join(','));
  const arr = biz?.chat_sessions || biz?.sessions || biz?.chat_session_list;
  if (Array.isArray(arr)) {
    console.log('LIST n=', arr.length);
    console.log('LIST item keys=', Object.keys(arr[0] || {}).join(','));
    console.log('LIST sample=', JSON.stringify(arr[0], null, 2).slice(0, 800));
  } else {
    console.log('LIST raw biz=', JSON.stringify(biz).slice(0, 800));
  }

  // 2) history payload shape for a real session id (if any)
  if (Array.isArray(arr) && arr[0]) {
    const sid = arr[0].id || arr[0].chat_session_id;
    if (sid) {
      const hRaw = await driver.webApi('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(sid), { method: 'GET' });
      console.log('\nHISTORY status=', hRaw.status, 'ok=', hRaw.ok);
      const hJson = hRaw.json ?? {};
      const hData = hJson.data ?? hJson;
      const hBiz = hData?.biz_data ?? hData;
      console.log('HISTORY top-level keys=', Object.keys(hJson).join(','));
      console.log('HISTORY biz keys=', Object.keys(hBiz || {}).join(','));
      const hArr = hBiz?.chat_messages || hBiz?.messages || hBiz?.history;
      if (Array.isArray(hArr)) {
        console.log('HISTORY n=', hArr.length);
        console.log('HISTORY item keys=', Object.keys(hArr[0] || {}).join(','));
        console.log('HISTORY sample=', JSON.stringify(hArr[0], null, 2).slice(0, 1000));
      } else {
        console.log('HISTORY raw biz=', JSON.stringify(hBiz).slice(0, 800));
      }
    }
  }
} catch (e) {
  console.error('PROBE-ERR:', e?.message);
} finally {
  clearTimeout(timer);
  try { await driver.close(); } catch {}
}
