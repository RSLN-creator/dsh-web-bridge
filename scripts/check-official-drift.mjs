#!/usr/bin/env node
// check-official-drift.mjs — 官方一侧改了没有？**每次提交前**告诉你「照抄的那几段要不要同步」。
//
// ## 为什么必须有这个闸门（用户 2026-10-06 明令）
//
// 用户原话：「能接近，但官方一改版就会不同步**你不可以加上校验这一个代码每次提交前让我
// 知道是否需要同步了**？」
//
// 本插件里有两类东西是**照抄官方**的：一类是「照抄行为」（相位算法、会话体 occurrence 的
// 官方接法），一类是「照抄形状」（列头那一行、视图切换那两块要按官方位置渲染）。
// 照抄的东西一旦官方改版就会**静默失同步**——最坏的情况不是报错，而是「看起来还在工作、
// 其实和官方不是一回事」。上面那句话要的就是：让失同步**在提交前被点名**，而不是等用户在
// 界面上发现「怎么和官方不一样」。
//
// ## 判据（事实来源 vs 仓库快照）
//
// 1. 从**当前安装的** DSH 里读官方客户端代码（`app.asar`，路径可用 `--asar` 覆盖）；
// 2. 对我们依赖的每一「段」取指纹：**关键行**（按正则筛出的那几行，逐字）的 sha256；
// 3. 与仓库里的快照 `doc/official-fingerprints.json` 比对（`--update` 才写）；
// 4. 任何一段的指纹变了 ⇒ 退出 1 并逐段打印「哪一段变了 + 该去看哪个文件」。
//
// ## 刻意不做的事
//
//   · **不自动改我们的代码**：照抄段落要不要跟、怎么跟，是人的判断（官方也可能是在改别的
//     东西而这几行恰好挪位）。本脚本只负责「告诉你」。
//   · **不比对整个 bundle 的 hash**：官方每次发版所有 bundle 都变，那种「全红」等于没有
//     信息量——用户要的是「我照抄的那几段有没有变」。所以按**段**取指纹。
//
// 用法：
//   node scripts/check-official-drift.mjs              # 人读输出（提交前跑）
//   node scripts/check-official-drift.mjs --json       # 机读
//   node scripts/check-official-drift.mjs --update     # 人工确认「已同步」后刷新快照
//   node scripts/check-official-drift.mjs --asar <path>
//
// 退出码：0 = 全部与快照一致（或快照刚被 --update 刷新）；1 = 有段落漂移；2 = 脚本自身出错。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const SNAPSHOT = path.join(repoRoot, 'doc', 'official-fingerprints.json');
const DEFAULT_ASAR = 'D:/2_Download_Main/4_DeepSeek Harness_code/resources/app.asar';

/**
 * 我们**照抄/依赖**的官方段落清单。每段 = 一个包内文件 + 一组必须逐字存在的正则；
 * 指纹 = 命中的那些行（去掉首尾空白、按顺序拼接）的 sha256。
 *
 * ⚠ 新增照抄段落时必须在这里登记一段，否则这个闸门对它失明——登记本身就是「我抄了哪里」的台账。
 */
const SEGMENTS = [
  {
    id: 'conversation-view-switcher',
    file: 'dsh-client-ui-conversation/lib/client.js',
    why: '视图切换（对话⇄轨迹）的渲染位置；我们不再自绘页签，视图交给会话自己记住的那一个',
    patterns: [/renderSlot\("conversation\.view"/, /viewId !== void 0/],
  },
  {
    id: 'conversation-header-slot',
    file: 'dsh-client-ui-conversation/lib/client.js',
    why: '顶部那一行（标题/子智能体/团队/标准模式/后台任务）= conversation.header 槽；列头要在同一位置照抄',
    patterns: [/renderSlot\("conversation\.header"/, /name: "conversation\.header"/, /conversation\.header\.leading/],
  },
  {
    id: 'conversation-content-factory',
    file: 'dsh-client-ui-conversation/lib/client.js',
    why: '列里渲染的就是这个 factory（embedded 形态）；相位/局部槽的接法一旦变，列会跟着变',
    patterns: [/name: "conversation\.content"/, /scope: "session-maybe"/, /renderSlot\("conversation\.session"/],
  },
  {
    id: 'session-view-ids',
    file: 'dsh-client-ui-chat/lib/client.js',
    why: '「对话」视图的注册（id 与位置）——会话自己记住的视图 id 来源',
    patterns: [/inject\("conversation\.view"/, /name: "conversation\.view"/],
  },
  {
    id: 'trajectory-view-ids',
    file: 'dsh-client-ui-trajectory/lib/client.js',
    why: '「轨迹」视图的注册（id 与位置）',
    patterns: [/inject\("conversation\.view"/, /name: "conversation\.view"/],
  },
  {
    id: 'rightbar-gate',
    file: 'dsh-client-ui-sidebar-right/lib/client.js',
    why: '右栏的显示闸门（activePanelId === null 才显示）——决定了「面板开着时右侧 tab 为什么没了」，也是照抄右栏时的依据',
    patterns: [/activePanelId === null/],
  },
  {
    id: 'rightbar-session-seat',
    file: 'dsh-client-ui-sidebar-right/lib/client.js',
    why: '右栏 per-session 座位（rightbar.session）——照抄右栏内容时的落点',
    patterns: [/rightbar\.session/],
  },
  {
    id: 'slot-ownership-rule',
    file: 'dsh-client-ui-renderer/lib/client.js',
    why: '槽归属校验（renderSlot 只允许声明者渲染 / renderFactorySlot 不校验）——「能不能把官方 header 搬进列」的判据',
    patterns: [/is not declared by this entry's children/, /is not declared by this Factory/],
  },
  {
    id: 'agent-preset-labels',
    file: 'dsh-client-ui-agent-preset/lib/client.js',
    why: '列头「模式」chip 复刻的官方文案与投影键（标准模式 / PTC 模式 / projectionValues.agentPreset）——官方改名或改键就必须同步我们的 PRESET_LABELS 与取值路径',
    patterns: [/presetStandardName: "标准模式"/, /presetPtcName: "PTC 模式"/, /projectionValues\?\.agentPreset/],
  },
  {
    id: 'jobs-count-label',
    file: 'dsh-client-ui-jobs/lib/client.js',
    why: '列头「后台任务」chip 复刻的官方计数口径与文案（liveRows.length + count.live.one）',
    patterns: [/count\.live\.one/, /liveRows\.length/],
  },
  {
    id: 'client-hmr-reload',
    file: 'dsh-client-hmr/lib/index.js',
    why: '客户端热换链（mtime/ctime/size → rebuilt 帧）——桌面端「不重启就生效」的全部依据',
    patterns: [/artifactRevision|mtimeMs/, /clientModules\.rebuilt/, /pollIntervalMs/],
  },
  {
    id: 'session-mention-encoding',
    file: 'dsh-session-reference/lib/index.js',
    why: '会话引用的官方编码（@[label](dsh-session:<base64url(JSON(id))>)）——跨列引用「⇥ 引用」按钮已按用户 10-08 口径删除，但**宿主原生语法仍在**（用户可手打），官方改形状则手打的引用也会失效，故保留监控',
    patterns: [/function encodeSessionReferenceUri/, /function formatSessionReferenceMention/, /function escapeLabel/],
  },
  {
    id: 'session-header-children',
    file: 'dsh-client-ui-conversation/lib/client.js',
    why: '列顶栏复刻的官方 header 子槽结构（registerSessionHeader 声明 lineage/actions/utilities/corner）——0.19.68（10-08 轮）ColumnHeader 按这棵树逐字复刻 DOM，官方增删子槽则复刻失同步',
    patterns: [/name: "conversation\.session\.header"/, /"conversation\.session\.header\.actions"/, /"conversation\.session\.header\.utilities"/, /"conversation\.session\.header\.corner"/],
  },
  {
    id: 'preset-readonly-label',
    file: 'dsh-client-ui-agent-preset/lib/client.js',
    why: '列顶栏「模式」chip 的只读形态（AgentPresetLabel 渲染 span 而非按钮 + Read-only by construction）——复刻成只读标签的依据，官方改成可点则复刻失同步',
    patterns: [/function AgentPresetLabel/, /Read-only by construction/],
  },
  {
    id: 'subagent-count-i18n',
    file: 'dsh-client-ui-subagent/lib/client.js',
    why: '列顶栏「子智能体」chip 复刻的官方文案（count.total.one「{count} 个子智能体」）——官方改字则 HEADER_TEXT.subagents 失同步',
    patterns: [/"count\.total\.one": "\{count\} 个子智能体"/],
  },
  {
    id: 'team-action-i18n',
    file: 'dsh-experimental-client-ui-agent-team/lib/client.js',
    why: '列顶栏「团队」chip 复刻的官方文案（trigger「智能体团队」）与投影键（projectionsBySession[lead].values.agentTeam）——官方改字/改键则复刻失同步',
    patterns: [/trigger: "智能体团队"/, /projectionsBySession\[leadSessionId\]/],
  },
  {
    id: 'open-in-app-routes',
    file: 'dsh-client-ui-open-in-app/lib/client.js',
    why: '列顶栏「用 X 打开 / 更多打开方式」走的官方公开路由（apps/open/icon）——官方改路由则复刻的按钮 404',
    patterns: [/OPEN_IN_APP_APPS_ROUTE = "\/open-in-app\/apps"/, /OPEN_IN_APP_OPEN_ROUTE = "\/open-in-app\/open"/, /OPEN_IN_APP_ICON_PREFIX_ROUTE = "\/open-in-app\/icon"/],
  },
  {
    id: 'session-export-route',
    file: 'dsh-session-log-export/lib/client.js',
    why: '列顶栏「更多操作 → 下载 Session 日志」走的官方路由（api/session.export）与 zip 文件名口径——官方改路由/文件名则复刻的下载失效',
    patterns: [/SESSION_LOG_EXPORT_ROUTE = "\/api\/session\.export"/, /function sessionLogZipFilename/],
  },
  {
    id: 'jobs-live-status',
    file: 'dsh-client-ui-jobs/lib/client.js',
    why: '列顶栏「后台任务」chip 的「运行中」判据（status running/stopping，与官方 isLive 同义）——官方改状态字面量则计数失同步',
    patterns: [/status === "running"/, /status === "stopping"/],
  },
];

/** 极简 asar 读取：头 16 字节 + JSON 目录 + 相对偏移。 */
function readAsarEntry(asarPath, entryPath) {
  const buf = fs.readFileSync(asarPath);
  const headerSize = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
  const base = 16 + headerSize;
  let node = header;
  for (const part of entryPath.split('/')) {
    node = node.files?.[part];
    if (!node) return null;
  }
  if (node.files) return null;
  const off = Number(node.offset);
  return buf.subarray(base + off, base + off + Number(node.size)).toString('utf8');
}

/** 取一段的指纹：命中的行（逐字、去首尾空白）按顺序拼接后 sha256。 */
function fingerprint(segments, source) {
  const lines = String(source).split(/\r?\n/);
  const hit = [];
  const perPattern = [];
  for (const re of segments.patterns) {
    const matched = lines.filter((l) => re.test(l));
    perPattern.push({ pattern: String(re), hits: matched.length });
    for (const l of matched) hit.push(l.trim());
  }
  return {
    sha256: crypto.createHash('sha256').update(hit.join('\n')).digest('hex').slice(0, 16),
    lines: hit.length,
    perPattern,
  };
}

function main(argv) {
  const asarIdx = argv.indexOf('--asar');
  const asarPath = asarIdx >= 0 ? argv[asarIdx + 1] : DEFAULT_ASAR;
  const update = argv.includes('--update');
  const asJson = argv.includes('--json');

  if (!fs.existsSync(asarPath)) {
    console.error('[drift] 找不到官方 asar：' + asarPath + '（用 --asar <path> 指定）');
    process.exitCode = 2;
    return;
  }
  const snapshot = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : { at: null, asar: null, segments: {} };
  const now = { at: new Date().toISOString(), asar: asarPath, segments: {} };
  const drift = [];
  const missing = [];

  for (const seg of SEGMENTS) {
    const src = readAsarEntry(asarPath, 'dsh/node_modules/@deepseek-ai/' + seg.file);
    if (src === null) { missing.push({ id: seg.id, file: seg.file }); continue; }
    const fp = fingerprint(seg, src);
    now.segments[seg.id] = { file: seg.file, why: seg.why, ...fp };
    const old = snapshot.segments?.[seg.id];
    if (!old) drift.push({ id: seg.id, file: seg.file, why: seg.why, kind: 'new' });
    else if (old.sha256 !== fp.sha256) drift.push({ id: seg.id, file: seg.file, why: seg.why, kind: 'changed', was: old.sha256, now: fp.sha256, counts: fp.perPattern });
  }

  if (update) {
    fs.writeFileSync(SNAPSHOT, JSON.stringify(now, null, 2) + '\n');
    console.log('[drift] 快照已刷新：' + SNAPSHOT + '（' + SEGMENTS.length + ' 段）');
    process.exitCode = 0;
    return;
  }

  const report = { ok: drift.length === 0 && missing.length === 0, asar: asarPath, snapshotAt: snapshot.at, drift, missing };
  if (asJson) console.log(JSON.stringify(report, null, 2));
  else {
    console.log('[drift] 官方 asar：' + asarPath);
    console.log('[drift] 快照时间：' + (snapshot.at || '(无，首次请跑 --update)'));
    for (const [id, s] of Object.entries(now.segments)) {
      const changed = drift.some((d) => d.id === id);
      console.log('  ' + (changed ? '✖ DRIFT ' : '✔ 一致  ') + id.padEnd(28) + ' 行数=' + s.lines + ' sha=' + s.sha256);
    }
    for (const m of missing) console.log('  ? 缺失  ' + m.id + '（文件不在 asar 里：' + m.file + '）');
    if (drift.length) {
      console.log('');
      console.log('[drift] ✖ 有 ' + drift.length + ' 段与快照不一致——**照抄的部分需要人工同步**：');
      for (const d of drift) console.log('  · ' + d.id + '（' + d.file + '）：' + d.why);
      console.log('  处理：读一遍官方那一段 → 同步我们的实现 → 跑 `node scripts/check-official-drift.mjs --update` 刷新快照。');
    } else if (!missing.length) {
      console.log('[drift] ✔ 照抄段落与官方一致（' + SEGMENTS.length + ' 段）');
    }
  }
  process.exitCode = report.ok ? 0 : 1;
}

main(process.argv.slice(2));
