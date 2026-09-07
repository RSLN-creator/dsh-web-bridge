---
type: event
date_occurred: 2026-09-07 20:10
capsule_used: ""
---
# 事件：将实测速率/model_type 契约固化为单测纯函数

## 背景
- 上一轮新增 status().lastRate（设置页"估算 vs 实测"数据源）。为避免未来改动破坏该契约字段，按"每个字段都要测试"精神把派生逻辑抽成纯函数并加单元断言。

## 执行过程

[2026-09-07] 抽出 lib/metrics.js 纯函数
- 技术: deriveLastRate({metrics,chars},mode) 纯函数——只依赖入参，产出 chars/responseMs/firstResponseMs/thinkingMs/endToEndMs/charsPerSec/mode；responseMs<=0 时 charsPerSec=null（防除零）。expectedModelType(id)→{flash:default,deepseek:expert,vision:vision}。
- 操作: 新增 lib/metrics.js；browser-driver.js import 并让 status().lastRate=deriveLastRate(lastFinished,selectedModel)（内联逻辑替换为纯函数，行为不变）。
- 功能: 设置页速率契约与驱动时序解耦，可单测。

[2026-09-07] 单元测试 + 真机复核
- 技术: test/metrics.test.mjs 5 项断言（空输入→null；正常样本 charsPerSec=34；除零防护；默认 mode；model_type 契约映射）。
- 操作: node --test metrics+parse+regression → 13 项全过，fail 0；real-probe-12 真机复核 status().lastRate=charsPerSec 38，LOAD_RATE OK。
- 功能: 契约字段有断言护栏，回归由测试保障。

## 结论
- ✅ 实测速率与 model_type 映射成为带单元断言的纯函数契约；真机复核一致，无回归。
- ⏭️ 后续：跨平台 cfg 与多站点需真实对应环境验证；harness 侧 UI/导入/列表恢复不在本仓范围。