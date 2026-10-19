// model-picker.js — 各站点「真的切换网页模型」的唯一实现（0.13.0）。
//
// 为什么需要它（真机取证 2026-09-13）：0.12.9 的驱动拿到 model.id === 'auto'
// 就直接 return，**页面上一个动作都不做**；而每个站点的目录里又只有这一条 auto。
// 于是「模型选择」是个空承诺——UI 里有下拉，网页上什么都不会变。
//
// 本模块把站点差异收口成一份声明式契约（写在 providers.js 的 modelPicker 里），
// 执行逻辑只有一份，并且做两件旧实现没做的事：
//   1. **按名字精确匹配选项**，不做前缀匹配。z.ai 的实际模型是
//      `GLM-5.3-Flash` / `GLM-5.3` / `GLM-5.2` —— "GLM-5.3" 是
//      "GLM-5.3-Flash" 的前缀，前缀匹配会选错模型。
//   2. **点击后回读当前模型名**确认切换真的生效；读不到或读出不匹配就如实
//      报告 unverified，而不是假装成功（这正是旧实现的病）。
//
// 契约形状（providers.js 每站点可选）：
//   modelPicker: {
//     trigger:    '选择器' | ['选择器', ...]   // 打开模型弹层的按钮
//     option:     '选择器'                     // 弹层里的选项
//     optionName: ['选择器', ...]              // 选项内「名字」节点的选择器，依次尝试
//     selected:   '选择器'                     // 回读当前模型名的节点（可选）
//     scopedToComposer: true                   // 触发按钮是否只在 composer 容器内找
//   }
//
// 契约缺失 = 该站点的模型 UI 未真机校准 → 返回 unverified，绝不猜着点。

/**
 * 回读是否算「确认切换成功」——**纯函数**，便于反向护栏直接打它。
 *
 * ⚠ 2026-10-14 真机修（z.ai）：原判据是 `applied.includes(chosen.name)`，
 * 拿**已点击那一项的整行文本**当右侧。而选项行可能带营销后缀
 * （z.ai 逐字：`GLM-5.3-Flash NEW 轻量旗舰模型，高质量极速响应`），
 * 触发按钮回读的却只有模型名（`GLM-5.3-Flash`）
 * ⇒ `'GLM-5.3-Flash'.includes('GLM-5.3-Flash NEW …')` 恒为 false。
 * 后果：**明明切换成功却记成 `readback-mismatch`**（真机日志逐字
 * `模型回读不一致：目标 GLM-5.3-Flash，回读 GLM-5.3-Flash`，两个字符串看起来一样），
 * 于是 `selectModelGeneric` 降级为 `strict:false`——「严格模式」对该站点静默失效。
 *
 * ## 判据（现在只有一个方向：**回读必须覆盖目标名**）
 *
 * 基准**恒为目标名 `wanted`**，回读必须是它的超串：`a.includes(w)`。这一条同时覆盖
 * 两种真实形态（都只会让回读**更长**）：触发按钮带装饰（`GLM-5.3-Flash ▾`）与选项行
 * 带营销后缀（`GLM-5.3-Flash NEW 轻量旗舰模型…`）。
 *
 * ## 0.19.82：删掉两个「更短也放行」的方向（长期问题 #67，红线 1 洞）
 *
 * 旧实现有两处会让**比目标更短**的回读被放行，两处都是「绝不静默降级模型」的洞：
 *
 *   ① 第二半判据 `base.includes(a)`（**基准是回读的超串**）：页面回读 `GLM-5.3`、
 *      目标 `GLM-5.3-Flash` ⇒ `'glm-5.3-flash'.includes('glm-5.3')` 为真 ⇒
 *      **切换没生效却判 `confirmed:true`**，用户选了 Flash 却跑在 5.3 上。
 *   ② 基准候选 `if (c.length < w.length && w.startsWith(c)) base = c`（**被点中项比目标短**）：
 *      菜单里一旦没有精确项、只有更笼统的 `GLM-5.3`（`pickExactOption` 规则 ③ 会挑中它），
 *      base 就缩成 `GLM-5.3`，于是回读 `GLM-5.3` 又被放行 —— 同一个洞的第二次入口。
 *      这一条在**生产数据下无法成立为「合法宽容」**：`wanted` 取的是 `providers.js` 的
 *      `labels[0]`（`GLM-5.3` / `GLM-Flash` / `K3`…），**从来自带后缀**，所以「选项名比目标短」
 *      从来不是缩写的正义形态，而正是「网页提供了更笼统的档位」。它的注释原本举的例子
 *      （目标写成 `GLM-5.3-Flash NEW`）在目录里不存在。
 *
 * ## 误判方向是刻意选的（不对称代价）
 *
 * 判 false 的代价只是 `strict:false` ⇒ `readback-mismatch` + warn（切换本身仍然发生，
 * 见 `browser-driver.js:4440`）；判 true 的代价是**静默降级**。两者不对称，宁少放行。
 * 因此本判据与 `currentModelIsTarget` 现在**同方向**（候选 ≥ 目标），只是用途不同：
 * 后者问「要不要动手」，前者问「动完手有没有生效」。
 *
 * 反向护栏见 `test/model-picker.test.mjs` 的 #67 三条 + 对照两条（页面更短必须 false、
 * 回读更完整必须 true、装饰必须 true）。
 *
 * @param {string|null} applied 从页面回读到的当前模型名
 * @param {string} chosenName 被点击那一项的名字（可能带后缀，仅用于诊断，不参与放行）
 * @param {string} wanted 我们要的目标名
 * @returns {boolean}
 */
export function readbackConfirms(applied, chosenName, wanted) {
  if (!applied) return false;
  const a = normalizeModelName(applied);
  const w = normalizeModelName(wanted || '');
  if (!a || !w) return false;
  // 单方向：回读必须覆盖目标名。装饰与营销后缀只会让回读更长，因此这一条足够；
  // 「回读更短」只可能意味着页面上停着一个更笼统的型号 ⇒ 红线 1，必须报未生效。
  return a.includes(w);
}

/**
 * 归一化模型名用于比较：去掉空白、大小写、以及尾部的营销标记。 */
export function normalizeModelName(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\u200b-\u200d\ufeff]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 从候选项文本里挑出与目标名精确相等的那个。
 *
 * 只做**精确相等**，外加一条明确放宽：选项的展示名可能带后缀（如 z.ai 的
 * 「GLM-5.3-Flash NEW」）——那也要求名字是**独立的 token 边界**，
 * 不能是另一个更长模型名的前缀。
 *
 * @param candidates [{ name, text, index }]
 * @param wanted 目标模型名（providers 里的 labels[0] 或 name）
 * @returns 命中的候选下标，或 -1
 */
export function pickExactOption(candidates, wanted) {
  const want = normalizeModelName(wanted);
  if (!want) return -1;
  const names = candidates.map((c) => normalizeModelName(c.name || c.text));
  // ① 名字节点逐字相等 —— 主路径
  const exact = names.indexOf(want);
  if (exact >= 0) return exact;
  // ② 名字节点以目标名开头，且紧跟一个非字母数字边界（空格/连字符以外的
  //    分隔符），同时**不是**另一个更长的候选名。这条是为了容忍
  //    「GLM-5.3 旗舰模型」这类名字节点里混进了描述的情况。
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (!n.startsWith(want)) continue;
    const rest = n.slice(want.length);
    if (!/^[\s\-–—·|/]/.test(rest)) continue;          // 必须是分隔符，不是字母
    // 排他性：没有别的候选以同一个前缀 + 更长名字存在
    const ambiguous = names.some((o, j) => j !== i && o.startsWith(want) && o.length > n.length);
    if (!ambiguous) return i;
  }
  // ③ 反向：候选名是目标名的前缀且后面是分隔符（选项名比目标短，
  //    例如目标写成 "GLM-5.3-Flash NEW" 而节点只有 "GLM-5.3-Flash"）
  for (let i = 0; i < names.length; i++) {
    const n = names[i];
    if (want.startsWith(n) && /^[\s\-–—·|/]/.test(want.slice(n.length))) return i;
  }
  return -1;
}

/**
 * 「页面上当前显示的模型**就是**目标模型吗」——幂等快路的判据（**纯函数**）。
 *
 * ## 为什么不能复用 `pickExactOption`
 *
 * `pickExactOption` 的三条规则里有两条**方向相反**的宽容：
 *   ② 候选**以目标开头** + 分隔符（候选更长：`GLM-5.3-Flash NEW` ← 目标 `GLM-5.3-Flash`）
 *   ③ 目标**以候选开头** + 分隔符（候选更短：目标 `GLM-5.3-Flash` → 候选 `GLM-5.3`）
 * 对「在菜单里挑一项」这两个方向都无害（挑出来的仍是同族项，且后面还有回读确认）；
 * 但对「**要不要动手**」这个判断，规则 ③ 是**危险的**：
 *   页面当前 = `GLM-5.3`、目标是 `GLM-5.3-Flash` ⇒ 规则 ③ 说「命中」
 *   ⇒ 快路判定「已经是目标」⇒ **跳过本该发生的切换**
 *   ⇒ 用户选了 Flash、网页停在 5.3 —— 这正是**红线 1「绝不静默降级模型」**禁止的。
 *
 * ## 因此本函数只允许「候选 ≥ 目标」这一个方向
 *
 *   ① 规范化后**逐字相等**；
 *   ② 候选**以目标开头**，且紧跟一个分隔符（容忍 `GLM-5.3-Flash NEW` 这类营销后缀）。
 *
 * **不允许**候选比目标短（那意味着要切到更具体的档位，必须真的去点）。
 *
 * @param {string|null} current 页面上当前显示的模型名
 * @param {string} wanted 目标模型名（providers 的 labels[0]）
 * @returns {boolean} true = 已经是目标，无需任何 UI 动作
 */
export function currentModelIsTarget(current, wanted) {
  const c = normalizeModelName(current);
  const w = normalizeModelName(wanted);
  if (!c || !w) return false;
  if (c === w) return true;
  // 只允许「候选更长」：以目标开头 + 紧跟分隔符（不是字母数字，避免 GLM-5.3X 这类误判）
  if (c.startsWith(w) && /^[\s\-–—·|/]/.test(c.slice(w.length))) return true;
  return false;
}

/** 把契约里的选择器字段（字符串或数组）拍成有序数组。 */
function selList(v) {
  if (!v) return [];
  return (Array.isArray(v) ? v : [v]).filter((s) => typeof s === 'string' && s.trim());
}

/**
 * 在页面里读取模型弹层：先开触发，再**轮询等待**选项出现，每个选项连同「名字」返回。
 *
 * 两个真机教训（2026-09-13 verify-model-switch 首跑，8/8 fail）：
 *   1. 点击与查询**不能在同一 tick**：弹层是 React/Svelte 异步渲染的，点完立刻
 *      querySelectorAll 拿到的是 0 个选项（首跑每个站点第一条都报 no-options，
 *      而第二条却能读到——因为菜单被上一次点击留在页面上了）。
 *   2. 菜单可能已经开着（上一次调用留下的）：先探测，已有选项就不再点，否则点
 *      会把已开的菜单**关掉**。
 */
const OPEN_AND_READ = async (cfg) => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity || '1') > 0.05;
  };
  const text = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  const firstMatch = (root, sels) => {
    for (const s of sels) {
      try {
        const hit = [...root.querySelectorAll(s)].filter(vis);
        if (hit.length) return hit[0];
      } catch { /* 非法选择器：跳过 */ }
    }
    return null;
  };
  const readOptions = () => {
    const options = [];
    const seen = new Set();
    for (const el of document.querySelectorAll(cfg.option)) {
      if (!vis(el)) continue;
      const nameEl = cfg.optionName?.length ? firstMatch(el, cfg.optionName) : null;
      const name = text(nameEl) || text(el);
      const full = text(el);
      const key = name + '@' + full.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({ name, full, tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 100) });
      if (options.length >= 60) break;
    }
    return options;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // 触发范围：站点声明 scopedToComposer 时只在输入框容器里找（kimi 的模型
  // 按钮与「发送」等控件同容器，全页找容易点到别的同名节点）。
  let scope = document;
  if (cfg.scopedToComposer) {
    const composer = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
      .find((e) => vis(e) && e.getBoundingClientRect().width > 40);
    if (composer) {
      let box = composer;
      for (let i = 0; i < 6 && box.parentElement; i++) box = box.parentElement;
      scope = box;
    }
  }

  // 分段控件：选项常驻页面、点击即切换，**不点触发**（触发就是选项本身，
  // 点它会把当前模式先切走）。直接枚举即可。
  if (cfg.segmented) {
    const options = readOptions();
    return { ok: options.length > 0, reason: options.length ? undefined : 'no-options', options };
  }

  // 菜单已经开着就不用点（点会把已开的菜单关掉）
  let options = readOptions();
  let triggerText = null;
  if (!options.length) {
    const trigger = firstMatch(scope, cfg.trigger) || firstMatch(document, cfg.trigger);
    if (!trigger) return { ok: false, reason: 'trigger-not-found' };
    triggerText = text(trigger);
    // 0.19.81：**触发器被禁用**要如实报「不可用」，不要报成「菜单里没有这一项」。
    //
    // 真机（z.ai，2026-10-15）：站点在「发过一条消息之后」把模型按钮
    // `disabled=true`（60/60 采样、持续 ≥47s）。旧实现照点不误，菜单不开，
    // 读到 0 选项 ⇒ 上层报 `MODEL_UNAVAILABLE …（no-options）`
    // ⇒ **把「按钮此刻不可用」误导成「模型不在菜单里」**，排障方向全错。
    // 这里区分两者：禁用时立刻返回 `trigger-disabled`（附按钮文本，便于归因），
    // 让调用方与用户看到真因。
    if (trigger.disabled === true || trigger.getAttribute('aria-disabled') === 'true') {
      return { ok: false, reason: 'trigger-disabled', triggerText, disabled: true };
    }
    trigger.click();
    // 轮询等待异步渲染的弹层（最多 ~3s）
    for (let i = 0; i < 20 && !options.length; i++) {
      await sleep(150);
      options = readOptions();
    }
    // 点完仍无选项、且此刻按钮已变禁用 ⇒ 同样是「不可用」而非「菜单缺项」。
    // （点击与禁用可能同时发生：站点在生成中把按钮置灰。）
    if (!options.length && (trigger.disabled === true || trigger.getAttribute('aria-disabled') === 'true')) {
      return { ok: false, reason: 'trigger-disabled', triggerText, disabled: true };
    }
  }
  return { ok: true, triggerText, options };
};

/** 回读当前模型名（页面上下文）。 */
const READ_CURRENT = (sel) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  for (const s of sel) {
    try {
      const hit = [...document.querySelectorAll(s)].filter(vis);
      if (hit.length) {
        const t = (hit[0].textContent || '').trim().replace(/\s+/g, ' ');
        if (t) return t;
      }
    } catch { /* 跳过 */ }
  }
  return null;
};

/**
 * 按「选中态 class」回读当前选项名（分段控件用）。
 *
 * 豆包的「对话 / 工作」没有 aria-selected，选中态只体现在 class 上：
 *   选中 → `text-dbx-text-primary`
 *   未选 → `text-dbx-text-secondary`
 * 因此契约给出 `selectedStateClass`，这里找出 class 含它且不含
 * `unselectedStateClass` 的那个选项，返回它的名字。
 */
const READ_SELECTED_BY_CLASS = (payload) => {
  const { cfg, selectedStateClass, unselectedStateClass } = payload;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  const firstMatch = (root, sels) => {
    for (const s of sels) {
      try {
        const hit = [...root.querySelectorAll(s)].filter(vis);
        if (hit.length) return hit[0];
      } catch { /* 跳过 */ }
    }
    return null;
  };
  for (const el of document.querySelectorAll(cfg.option)) {
    if (!vis(el)) continue;
    const cls = String(el.className || '');
    if (!cls.includes(selectedStateClass)) continue;
    if (unselectedStateClass && cls.includes(unselectedStateClass)) continue;
    const nameEl = cfg.optionName?.length ? firstMatch(el, cfg.optionName) : null;
    const t = text(nameEl) || text(el);
    if (t) return t;
  }
  return null;
};

const CLICK_OPTION = (payload) => {
  const { cfg, wantName } = payload;
  const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const text = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
  const firstMatch = (root, sels) => {
    for (const s of sels) {
      try {
        const hit = [...root.querySelectorAll(s)].filter(vis);
        if (hit.length) return hit[0];
      } catch { /* 跳过 */ }
    }
    return null;
  };
  const want = String(wantName || '').trim().toLowerCase();
  for (const el of document.querySelectorAll(cfg.option)) {
    if (!vis(el)) continue;
    const nameEl = cfg.optionName?.length ? firstMatch(el, cfg.optionName) : null;
    const name = (text(nameEl) || text(el)).trim().toLowerCase();
    if (name === want) { el.click(); return { ok: true, clicked: text(el).slice(0, 80) }; }
  }
  return { ok: false, reason: 'option-not-found' };
};

/**
 * 选模型。返回结构化结果，**不抛**（调用方决定是否升级为错误）。
 *
 * 支持两种网页形态：
 *   ① **弹层式**（z.ai / GLM / Kimi）：点触发 → 枚举弹层选项 → 点选项 → 关弹层。
 *   ② **分段控件式**（豆包的「对话 / 工作」）：没有弹层，两个按钮常驻页面，
 *      点击即切换。`segmented: true` 时直接枚举并点击，不需要也不应该先点触发
 *      ——（分段控件的"触发"就是选项本身，点它会先把模式切走）。
 *
 * @param {object} page Playwright 页面
 * @param {object} model 已解析的网页模型（labels[0] 是网页上的名字）
 * @param {object} contractPicker 站点声明的 `providers.modelPicker` 契约
 * @param {{resume?: boolean}} [opts] `resume=true` ⇒ 本轮是**续聊**（导航回既有会话），
 *   不是新建会话。分段控件的模式是**会话属性**，只在新会话创建时生效——见下方 F15 注释。
 * @returns {{
 *   ok: boolean, reason?: string, ui?: string,
 *   requested?: string, applied?: string|null, options?: string[],
 *   confirmed?: boolean
 * }}
 */
export async function selectWebModel(page, model, contractPicker, { resume = false } = {}) {
  const picker = contractPicker;
  if (!pickerUsable(picker)) {
    return { ok: false, reason: 'no-picker-contract' };
  }
  const cfg = {
    trigger: selList(picker.trigger),
    option: picker.option,
    optionName: selList(picker.optionName),
    scopedToComposer: picker.scopedToComposer === true,
    segmented: picker.segmented === true,
  };
  // 目标名：labels 优先（网页上显示的就是它），否则用网页上的原始名字
  // （webName）——**不能用 name**：0.14.0 起 name 是 `z.ai/glm-5.3` 这种带站点
  // 短键的显示名，而网页上永远不会出现这个前缀，拿它比对必然 option-not-in-list。
  const wanted = (model.labels && model.labels[0]) || model.webName || model.name;

  // ── 幂等快路（0.19.81，真机修出）───────────────────────────────────────────
  //
  // ## 缺陷（z.ai 真机，2026-10-15，60/60 采样）
  //
  // **站点在「发过一条消息之后」把模型按钮 `disabled=true`**（实测持续 ≥47s 全程禁用），
  // 而 `selectModel` 是**每一轮都调**的（`browser-driver.js:3515`，不分 fresh/resume）。
  // ⇒ 第二轮（回填工具结果）走到这里 → 点禁用按钮 → 菜单不开 → 读到 0 选项
  // ⇒ 报 `MODEL_UNAVAILABLE: 未能切换到 GLM-5.3-Flash（no-options）`。
  //
  // ⚠ **那个报错是误导的**：真实原因不是「菜单里没有这一项」，而是「按钮此刻不可用」。
  //   排障时会往「模型表过期 / 选项改名」方向查，全都查错方向。
  //
  // ## 为什么快路能修好它（且不是绕过判据）
  //
  // 真机读数：**禁用期间触发按钮的文本仍可读**（`GLM-5.3`），而 `picker.selected`
  // 本来就是「页面上常驻显示当前模型名」的节点（z.ai 的触发按钮就在其中）。
  // ⇒ 若**当前已经是目标模型**，就**根本不需要动 UI**——不点、不开菜单、不看 disabled。
  //   这与 `think-effort.js` 的「幂等快路」是同一形状（那里注释写着：网页现在就已经是
  //   目标档 ⇒ 一眼判定成功，任何控件都不动），也与本仓库「同站重复下发要幂等」的既有纪律一致。
  //
  // **判据仍然是回读**（不是「我们曾经选过」）：只在**读到的当前模型名确认等于目标**时才走快路；
  // 读不到（`null`）就照常走原有路径 ⇒ 对读不到读数的站点**零位移**。
  //
  // ⚠ 判据用 `currentModelIsTarget`（**只允许候选 ≥ 目标**这一个方向），
  //   刻意**不**复用 `pickExactOption` —— 后者的「候选是目标前缀」那条会在
  //   「页面 GLM-5.3 / 目标 GLM-5.3-Flash」时误判为「已是目标」而**跳过本该发生的切换**
  //   （红线 1：绝不静默降级模型）。理由写在 `currentModelIsTarget` 的注释里，并有反向护栏。
  const selForCurrentEarly = selList(picker.selected);
  if (selForCurrentEarly.length && !picker.readbackInMenu && !picker.selectedStateClass) {
    const current = await page.evaluate(READ_CURRENT, selForCurrentEarly).catch(() => null);
    if (currentModelIsTarget(current, wanted)) {
      return { ok: true, reason: 'already-current', requested: wanted, applied: current, confirmed: true, ui: 'noop' };
    }
  }

  // ── F15：分段控件的**续聊轮**（真机 doubao，2026-10-19 Wave2）───────────────
  //
  // ## 缺陷现场
  //
  // 豆包的「对话 / 工作」是**新会话的模式选择器**：既有会话页
  // `https://www.doubao.com/chat/<id>` 上它**根本不渲染**。真机零发送读数
  // （`.tmp/live-2026-10-19/raw/wave2probe-b-2026-10-19T14-15-02.json` 的 doubaoConfirm，
  // 两次 load 一致）：
  //   · `div.bg-dbx-fill-trans-20.rounded-full > button` count=0 visible=0；
  //   · `button.w-160` count=0 visible=0；文本「对话/工作」命中 0；
  //   · 而**新会话页有**（历史真机 dump 与 round1/2 成功）。
  // 驱动**每轮**都调 selectModel（含 resume）⇒ round3 resume 必然读到 0 选项
  // ⇒ `MODEL_UNAVAILABLE …（no-options）`——那是**语义错误**，不是真缺陷：
  // 模式是**会话属性**，续聊不会改变它，也不需要在这个页面上重新选。
  //
  // ## 判据（不是绕过判据）
  //
  //   · resume 轮：先按 `selectedStateClass` 回读当前选中项；读到且已是目标
  //     → `already-current`（幂等快路）；**读不到**（控件不在页）→ 返回
  //     `segmented-control-absent-on-resume`，由驱动侧 `warn` **出声**后保留会话模式
  //     ——不是静默成功（`confirmed:false/applied:null`，调用方据此如实告知用户）；
  //   · fresh 轮（新会话创建）：行为**逐字不变**——控件必须在；读到 0 选项仍报
  //     `no-options`（真缺陷不掩盖）；
  //   · 非分段站点：不进本分支，零位移。
  if (cfg.segmented && resume === true) {
    let current = null;
    if (picker.selectedStateClass) {
      current = await page.evaluate(READ_SELECTED_BY_CLASS, {
        cfg,
        selectedStateClass: picker.selectedStateClass,
        unselectedStateClass: picker.unselectedStateClass || null,
      }).catch(() => null);
    }
    if (currentModelIsTarget(current, wanted)) {
      return { ok: true, reason: 'already-current', requested: wanted, applied: current, confirmed: true, ui: 'noop' };
    }
    if (!current) {
      // 读不到当前选中项 = 控件不在这个页面上（既有会话页）。
      return {
        ok: true, reason: 'segmented-control-absent-on-resume',
        requested: wanted, applied: null, confirmed: false, ui: 'noop',
      };
    }
    // 控件在页、读到了但**不是**目标：照常走原有路径去点（与修复前同语义）。
  }

  const opened = await page.evaluate(OPEN_AND_READ, cfg).catch((e) => ({ ok: false, reason: 'evaluate-failed: ' + (e?.message || e) }));
  if (!opened.ok) {
    // 开了但没读到选项 → 关掉弹层，避免影响后续输入
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: opened.reason, requested: wanted };
  }
  if (!opened.options.length) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: 'no-options', requested: wanted, triggerText: opened.triggerText };
  }

  // 用同一套匹配规则（在 Node 侧算，页面侧只负责点）挑下标
  const idx = pickExactOption(opened.options, wanted);
  if (idx < 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return {
      ok: false, reason: 'option-not-in-list', requested: wanted,
      options: opened.options.map((o) => o.name).slice(0, 20),
    };
  }

  const chosen = opened.options[idx];
  const clicked = await page.evaluate(CLICK_OPTION, { cfg, wantName: chosen.name })
    .catch((e) => ({ ok: false, reason: 'click-failed: ' + (e?.message || e) }));
  if (!clicked.ok) {
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: false, reason: clicked.reason, requested: wanted, options: opened.options.map((o) => o.name).slice(0, 20) };
  }
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape').catch(() => {});

  // 回读确认。两种口径：
  //   ① 站点在页面上常驻显示当前模型名（z.ai 的触发按钮、GLM 的 .think-label）
  //      → 直接读 picker.selected。
  //   ② 站点只在**展开的菜单里**标出选中项（kimi：菜单关闭后页面上看不到模型名，
  //      触发按钮显示的是「思考强度」而非模型）→ readbackInMenu 为真时，
  //      重新打开菜单读「选中项」的名字。
  let applied = null;
  if (picker.readbackInMenu === true) {
    const again = await page.evaluate(OPEN_AND_READ, cfg).catch(() => null);
    if (again?.ok && again.options?.length) {
      const checkedSel = picker.checkedOption;
      applied = await page.evaluate((sel) => {
        const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const text = (el) => (el?.textContent || '').trim().replace(/\s+/g, ' ');
        try {
          for (const el of document.querySelectorAll(sel)) {
            if (!vis(el)) continue;
            const header = el.querySelector('.header') || el;
            const t = text(header);
            if (t) return t;
          }
        } catch { /* 跳过 */ }
        return null;
      }, checkedSel || cfg.option).catch(() => null);
      await page.keyboard.press('Escape').catch(() => {});
    }
  } else if (picker.selectedStateClass) {
    // 分段控件：选中态在 class 上（豆包）
    applied = await page.evaluate(READ_SELECTED_BY_CLASS, {
      cfg,
      selectedStateClass: picker.selectedStateClass,
      unselectedStateClass: picker.unselectedStateClass || null,
    }).catch(() => null);
  } else {
    const selForCurrent = selList(picker.selected);
    if (selForCurrent.length) {
      applied = await page.evaluate(READ_CURRENT, selForCurrent).catch(() => null);
    }
  }
  // 回读确认：判据抽成纯函数 `readbackConfirms`（真机 z.ai 的营销后缀 bug 见它的 JSDoc）
  const confirmed = readbackConfirms(applied, chosen.name, wanted);
  return {
    ok: true, requested: wanted, applied, confirmed,
    clicked: clicked.clicked,
    options: opened.options.map((o) => o.name).slice(0, 20),
  };
}

/**
 * 纯函数护栏：契约是否「可执行」。
 *
 * 两种形态的最低要求不同：
 *   • 弹层式：必须有 trigger（点开）与 option（弹层里的选项）。
 *   • 分段式（segmented）：trigger **故意不需要**——选项常驻页面，点击即切换，
 *     点"触发"反而会先把模式切走。只要求 option。
 *
 * 声明了 modelPicker 但不满足对应形态要求的站点，一律按未校准处理
 * （宁可不点，也不乱点）。
 */
export function pickerUsable(picker) {
  if (!picker || !picker.option) return false;
  if (picker.segmented === true) return true;
  return Boolean(picker.trigger);
}