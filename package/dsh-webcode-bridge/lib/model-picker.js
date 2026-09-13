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

/** 归一化模型名用于比较：去掉空白、大小写、以及尾部的营销标记。 */
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
    trigger.click();
    // 轮询等待异步渲染的弹层（最多 ~3s）
    for (let i = 0; i < 20 && !options.length; i++) {
      await sleep(150);
      options = readOptions();
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
 * @returns {{
 *   ok: boolean, reason?: string, ui?: string,
 *   requested?: string, applied?: string|null, options?: string[],
 *   confirmed?: boolean
 * }}
 */
export async function selectWebModel(page, model, contractPicker) {
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
  const confirmed = applied ? normalizeModelName(applied).includes(normalizeModelName(chosen.name)) : false;
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