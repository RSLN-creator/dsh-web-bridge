// accounts.js — 「站点 × 账户槽」的纯身份层（0.14.7）。
//
// 为什么需要这一层：
//   0.14.6 之前，一个站点只有**一份**登录态——driver 按 siteId 建一份 Edge profile
//   （`<profileDir>/sites/<siteId>`），会话槽文件是 `webcode-sessions-<siteId>.json`，
//   登录态文件是 `<profileDir>/webcode-login-state.json`。也就是「同一网站开两个号」
//   在结构上不可能：第二个号会把第一个号的登录态覆盖掉。
//
// 0.14.7 把「站点」升维成「站点 × 槽」，而**默认槽的 id 与路径逐字保持 0.14.6 的样子**：
//
//   站点 glm 的默认槽 → accountKey `glm`   、模型 id `glm:glm-5.3`   、目录 `<profileDir>/sites/glm`
//   站点 glm 的第 2 槽 → accountKey `glm#2` 、模型 id `glm@2:glm-5.3` 、目录 `<profileDir>/sites/glm/2`
//
// 这条「默认槽零位移」纪律不是洁癖：历史设置值（`defaultModel`、`subAgentSite`）、
// 已落盘的会话槽文件、`MODEL_ALIAS_IDS` 与既有测试断言全都指向默认槽的旧形状。
// 一旦默认槽改了路径或 id 形状，这些全部要迁移——迁移就是风险。
// 背景见 doc/long-term-issues.md 第 16 条与
// reference/local-refs/agent-teams-reference-notes.md §7.4。
//
// 本文件是**纯函数层**：不读磁盘、不读设置服务、不碰全局状态、不抛意外异常。
// 与 `metrics.computeSendGap`、`agent-preset.composerWritePlan` 同一纪律——
// 决策抽成纯函数，调用方只做 IO。这样槽语义可以被离线单测逐条钉住。

import path from 'node:path';

/** 默认槽的规范名。它在 accountKey / 模型 id 里**不出现**（见下方 format*）。 */
export const DEFAULT_SLOT = 'default';

/**
 * 槽别名 → 规范槽名。
 *
 * `#1` 是「第一个账户」的口语写法，与默认槽是同一份登录态。
 * 刻意**不**允许存在名为字面量 `1` 的独立槽：否则 `glm#1` 与 `glm` 会指向两份不同的
 * 登录态，而用户在界面上根本分不出这两个的区别。
 */
const SLOT_ALIASES = Object.freeze({ '1': DEFAULT_SLOT });

/** 槽名允许的字符集。`#` 是分隔符本身，`@` 是模型 id 的分隔符，都不能出现在槽名里。 */
const SLOT_RE = /^[A-Za-z0-9_-]{1,32}$/;
const SITE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 归一化槽名；非法返回 null（调用方决定是抛错还是丢弃）。 */
export function normalizeSlot(slot) {
  // 注意 trim 要在判空**之前**：`'  '` 这种「只有空白」的设置值在 webcode-settings.json
  // 里很常见（手改、或 UI 清空输入框后残留），它表达的是「没填」而不是「槽名叫空白」。
  const raw = slot === undefined || slot === null ? '' : String(slot).trim();
  const key = raw === '' ? DEFAULT_SLOT : raw;
  const canonical = SLOT_ALIASES[key] || key;
  if (!SLOT_RE.test(canonical)) return null;
  return canonical;
}

/**
 * 解析 accountKey → `{ siteId, slot }`。
 *
 *   'glm'    → { siteId: 'glm', slot: 'default' }
 *   'glm#2'  → { siteId: 'glm', slot: '2' }
 *   'glm#1'  → { siteId: 'glm', slot: 'default' }（别名）
 *
 * 非法输入**抛错**（而不是回落到默认槽）：accountKey 决定用哪份登录态，
 * 静默回落会让用户以为「账户2 没登录」，实际是拼错了去读了默认槽。
 */
export function parseAccountKey(key) {
  const raw = String(key ?? '').trim();
  if (!raw) throw new Error('账号槽为空');
  const at = raw.indexOf('#');
  const siteId = (at === -1 ? raw : raw.slice(0, at)).trim();
  const slotRaw = at === -1 ? DEFAULT_SLOT : raw.slice(at + 1);
  // 写了 `#` 却不写槽名（`glm#`）是拼写错误，不是「默认槽」——必须抛错。
  // 静默当成默认槽会让用户以为切到了账户2，实际一直在用默认账户。
  if (at !== -1 && String(slotRaw).trim() === '') throw new Error('账号槽槽名为空: ' + key);
  if (!SITE_ID_RE.test(siteId)) throw new Error('账号槽站点 id 非法: ' + key);
  const slot = normalizeSlot(slotRaw);
  if (!slot) throw new Error('账号槽槽名非法: ' + key);
  return { siteId, slot };
}

/**
 * `{ siteId, slot }` → accountKey。默认槽**不带** `#` 后缀。
 *
 * 这条与 formatModelId 一起构成「默认槽零位移」：默认槽产出的字符串
 * 与 0.14.6 的手写值逐字相同，历史设置值因此不需要任何迁移。
 */
export function formatAccountKey(siteId, slot) {
  const s = normalizeSlot(slot);
  if (!s) throw new Error('账号槽槽名非法: ' + slot);
  if (!SITE_ID_RE.test(String(siteId ?? ''))) throw new Error('账号槽站点 id 非法: ' + siteId);
  return s === DEFAULT_SLOT ? String(siteId) : siteId + '#' + s;
}

/** `{ siteId, slot }` → 限定模型 id。默认槽仍是 `site:model`。 */
export function formatModelId(siteId, slot, modelId) {
  const s = normalizeSlot(slot);
  if (!s) throw new Error('账号槽槽名非法: ' + slot);
  const mid = String(modelId ?? '').trim();
  if (!mid) throw new Error('账号槽模型 id 为空');
  return s === DEFAULT_SLOT ? siteId + ':' + mid : siteId + '@' + s + ':' + mid;
}

/**
 * 解析限定模型 id → `{ siteId, slot, modelId }`；**不是**限定形状时返回 null。
 *
 *   'glm:glm-5.3'        → { siteId: 'glm', slot: 'default', modelId: 'glm-5.3' }
 *   'glm@2:glm-5.3'      → { siteId: 'glm', slot: '2',       modelId: 'glm-5.3' }
 *   'deepseek-web'       → null（历史别名，交给 providers.ALIASES 解析）
 *   'glm-4.6'            → null（裸 id，交给 providers 的裸 id 分支）
 *
 * 刻意返回 null 而不是抛错：调用方（resolveWebModel）要先试别名、再试裸 id，
 * 「不是这个形状」是正常路径而非异常。
 */
export function parseModelId(id) {
  const raw = String(id ?? '').trim();
  const colon = raw.indexOf(':');
  if (colon === -1) return null;
  const left = raw.slice(0, colon);
  const modelId = raw.slice(colon + 1);
  const at = left.indexOf('@');
  const siteId = at === -1 ? left : left.slice(0, at);
  const slotRaw = at === -1 ? DEFAULT_SLOT : left.slice(at + 1);
  // `glm@:x` —— 写了 `@` 却没有槽名：这不是合法形状，返回 null 交给调用方走别名/裸 id 分支，
  // 绝不能当成「默认槽」，否则一个拼错的 id 会被静默路由到默认账户。
  if (at !== -1 && String(slotRaw).trim() === '') return null;
  if (!SITE_ID_RE.test(siteId)) return null;
  const slot = normalizeSlot(slotRaw);
  if (!slot) return null;
  if (!modelId) return null;
  return { siteId, slot, modelId };
}

/**
 * 槽的 Edge profile 目录。
 *
 * `primary` = 该站点是否把 driver **直接挂在 profileDir 根上**（当前只有 deepseek，
 * 因为它的前端会校验宿主名，必须挂在中继根）。这个标志只影响默认槽：
 *
 *   primary + default      → `<profileDir>`                （与 0.14.6 逐字相同）
 *   非 primary + default    → `<profileDir>/sites/<siteId>`  （与 0.14.6 逐字相同）
 *   任意 + 非默认槽          → `<profileDir>/sites/<siteId>/<slot>`
 *
 * 即：**默认槽一个字符都不动**，非默认槽一律落在 `sites/<siteId>/<slot>`。
 * 之所以敢把槽目录嵌在 profileDir 里面，是因为 `sites/<siteId>` 本来就已经是
 * profileDir 的子目录——这个布局是既有的，不是新发明。
 */
export function slotProfileDir(profileDir, siteId, slot, { primary = false } = {}) {
  const s = normalizeSlot(slot);
  if (!s) throw new Error('账号槽槽名非法: ' + slot);
  const root = String(profileDir);
  if (s === DEFAULT_SLOT) return primary ? root : path.join(root, 'sites', String(siteId));
  return path.join(root, 'sites', String(siteId), s);
}

/**
 * 界面显示名。默认槽**不加**后缀。
 *
 * 「默认槽不加后缀」是硬约束：`test/model-labels.test.mjs` 用正则钉住了
 * 「显示名必须是站点短键/模型 id」，而默认槽的显示名要与其 0.14.6 的取值逐字相同，
 * 否则既有用户的下拉里会凭空多出「(账户1)」这种他们没有配置过的东西。
 */
export function accountLabel(siteName, slot) {
  const s = normalizeSlot(slot);
  if (!s || s === DEFAULT_SLOT) return String(siteName ?? '');
  return String(siteName ?? '') + ' (账户' + s + ')';
}

/**
 * 归一化设置里的 `accounts` 数组。
 *
 * 返回**合法条目**的数组（每项 `{ siteId, slot, key, enabled }`），非法条目**丢弃**。
 * 为什么丢弃而不抛错：`webcode-settings.json` 是用户可以手改的文件，
 * 一个拼错的槽不该让整个桥接起不来——但也绝不「猜」用户的意图（不回落、不补默认）。
 * 调用方可以用 `raw.length !== out.length` 判断是否发生过丢弃并记一条 warn。
 *
 * 重复 key 只保留第一条（先到先得），因为两条同 key 的槽在界面上无法区分。
 */
export function normalizeAccounts(raw) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!entry || typeof entry !== 'object') continue;
    const siteId = String(entry.siteId ?? '').trim();
    if (!SITE_ID_RE.test(siteId)) continue;
    const slot = normalizeSlot(entry.slot);
    if (!slot) continue;
    const key = formatAccountKey(siteId, slot);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ siteId, slot, key, enabled: entry.enabled !== false });
  }
  return out;
}

/**
 * 取某站点已启用的槽（含默认槽）。
 *
 * **默认槽总是存在**，无论设置里有没有写它——它是 0.14.6 的行为本身，
 * 不能因为用户没在 `accounts` 里列出就消失。
 */
export function slotsForSite(accounts, siteId) {
  const list = normalizeAccounts(accounts).filter((a) => a.siteId === siteId && a.enabled);
  if (!list.some((a) => a.slot === DEFAULT_SLOT)) {
    list.unshift({ siteId, slot: DEFAULT_SLOT, key: formatAccountKey(siteId, DEFAULT_SLOT), enabled: true });
  }
  return list;
}

/**
 * 槽级发送间隔的查表（**不**做 clamp，clamp 在调用方）。
 *
 * 回落链（0.14.7 定为槽级，见 plan §2.2）：
 *   ① `sendGapMsBySlot[accountKey]` —— 该槽的显式值
 *   ② `sendGapMsBySlot[siteId]`     —— 站点级覆盖（默认槽的 key 就是 siteId，所以这一档
 *                                        同时承担「历史 siteId 形态的键」的兼容职责）
 *   ③ `settings.sendGapMs`          —— 全局值（0.14.6 的唯一一档）
 *
 * 返回原始数值；无法解析时返回 `undefined`，由调用方决定兜底。
 */
export function sendGapForSlot(settings, accountKey, siteId) {
  const bySlot = settings && typeof settings === 'object' ? settings.sendGapMsBySlot : null;
  if (bySlot && typeof bySlot === 'object') {
    const hit = bySlot[accountKey];
    if (hit !== undefined && hit !== null && hit !== '') return hit;
    if (siteId) {
      const siteHit = bySlot[siteId];
      if (siteHit !== undefined && siteHit !== null && siteHit !== '') return siteHit;
    }
  }
  const global = settings && typeof settings === 'object' ? settings.sendGapMs : undefined;
  return global;
}
