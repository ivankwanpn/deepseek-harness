---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-09-16-goal-limit-ceilings

[English](2026-09-16-goal-limit-ceilings.md) | 中文

## 概述

将会话格式升级到 v4：`goal/change` 快照显式声明三项延续上限，并在同一条记录中确认消息来源与 goal 变更上的可选用量字段。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-09-16-goal-limit-ceilings
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-11-initial"
    after: "1a3440e3577382704d42a6263aa463504eb74c566734a55e9503a63efcd02445"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-14-image-offload"
    after: "68d464aa2a05151ea659d382a7d62fa6b893231668ed95f9146fd9f39eda3328"
    decision: version-bump
  - root: "event:goal/change"
    previous: "2026-09-11-initial"
    after: "91b1959f77647fbd930d89a8e01413a241d5f46ce5b4353ee2bb2407b6d1649f"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-14-image-offload"
    after: "813ba0eec41b0d095cf0e7457cc3137c2c98e4d015a0eb2b62543d0da5e9f718"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-14-image-offload"
    after: "9754c81e96a39c602f3dd717e5bcbc01a5153a2f7dd39ebcd0df9d899fdbeaff"
    decision: version-bump
```

<a id="compatibility"></a>
## 兼容性

`event:goal/change` 需要版本提升：`data.goal.maxGoalRounds` 由 `number` 放宽为 `number | null`，而 `data.goal.maxGoalTokens` 与 `data.goal.maxGoalWorkMs` 成为必选属性，每次非清除变更本就都会写入它们。同一条记录承载由相邻迁移边 `@deepseek-ai/dsh-session-format-v3-to-v4` 实现的递增 `SessionHeader.version` 转换。v3 记录可以省略某项上限，字段缺失本就表示预算无界——宽容的 goal 折叠把缺失的上限解码为 `null`——因此缺失与 `null` 表示同一个无界上限，迁移对回放无损。

迁移边只重写携带 `data.goal` 快照的 `goal/change`：每个缺失的上限物化为显式 `null`，已存在的数值原样保留，`tokensAtCreate` 与 `workMsAtCreate` 保持记录原状，goal 清除墓碑与无关事件原样通过，头部重盖为版本 4。其余检测到的新增都是固定规则允许在同一版本内加入的可选属性：`agent/inbox/spliced`、`session/title-llm-request` 和 `user/message` 消息来源上的 `tokensUsed` 与 `workMsUsed`，以及 `goal/change` 上的 `tokensAtCreate` 与 `workMsAtCreate`。旧记录会省略它们，不认识它们的读取器忽略它们也不会改变回放，因此它们无需转换；推断出的决策是 goal 载荷与头部转换所要求的版本提升，它在这一条转换中声明所有发生变化的根。早于 v4 的构建会拒绝 v4 记录，而不是猜测它。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-format-v3-to-v4——3 个测试文件通过，14 项测试通过。`tests/migration.spec.ts` 覆盖缺失上限物化为显式 `null` 而已有数值保持不变；`tests/chain.spec.ts` 覆盖有种子的 v0 goal 变更经过每条相邻迁移边到达 v4、重复恢复结果一致、并发阶段互不影响、拒绝畸形载荷与未知必选事件，以及存在 v4 记录时不回退到前代。`pnpm --silent run verify-persistence-changes --json` 报告 ok，所有检测到的变更均已确认。

<a id="dev-note"></a>
## 开发备注

无。
