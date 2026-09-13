# Agent Note：除非部署設定上限，goal 的輪次不受約束

Status: implemented

[English](2026-09-13-unbounded-goal-rounds.md) | 中文

## 问题

goal 的 Round 上限是必填的，默认 256。`GoalSnapshot.maxGoalRounds` 是必填的正整数，严格折叠拒绝缺少它的变更，而 `goal-round-driver` 会在两个资源上限**之前**检查它。因此即使部署配置了 token 与活跃工作预算，它的 goal 仍会停在一个对话中毫无解释的轮次数上，而 `Round: 3/256` 与 `Rounds: 3/256` 把这个数字同时摆在模型和人面前。

这个上限从来不是对工作量的度量。Codex 持久化的 thread goal 完全没有轮次概念：`thread_goals` 只有 `token_budget`、`tokens_used` 与 `time_used_seconds`，`[goals] max_goal_token_budget` 是唯一可配置的边界，`budget_limited` 与 `usage_limited` 是仅有的两个由花费驱动的停止。本仓库里有轮次，是因为驱动器会接纳带编号的续跑消息，而不是因为部署想靠数它们来约束工作。

## 决策

`maxGoalRounds` 的类型是 `number | null`，`null` 表示续行不受轮次约束。未配置轮次默认值的部署创建出的 goal 不带上限，因此资源上限成为唯一的聚合边界；想要一个不需要计量器的防爆栏的部署仍可设置 `defaultMaxGoalRounds`，而 `update_goal` 的 `edit` 可以针对单个 goal 设置、提高或清除它。

### 一条规则，处处读取

[`domain.ts`](../../../../packages/goal/goal/src/domain.ts) 里的 `roundsExhausted(goal, roundsStarted)` 与 `roundWithinCap(goal, round)` 是解释 null 上限的唯一位置。续行驱动器在排队下一轮之前问第一个；回放折叠在验证 `resume` 时问第一个；投影状态 schema 在验证恢复的状态时问第二个；折叠在验证被接纳的轮次消息时问第二个。因此具名上限保留它原有的每一道保护，而 null 上限会一起移除它们，而不是只在某人记得的地方移除。

### 持久载荷接纳缺失的上限

`goal.maxGoalRounds` 从必填字段集移到可选集合，并通过两个预算所用的同一个辅助函数解码，因此字段缺失与显式 `null` 都读作无上限。`create` 始终写入该字段，与两个预算一致。

投影 schema 接受 `null`，而工具输出在 goal 没有上限时完全省略该字段——这与两个预算对无上限的既有形状一致。

### 模型可见与人类可见的文本随之变化

轮次提示词在轮次不受约束时渲染 `Round: 7`，在有上限时渲染 `Round: 7/40`。`/goal` 同样渲染 `Rounds: 7` 与 `Rounds: 7/40`。两个渲染器都保留已接纳的计数，因为阻塞审计要数连续的目标轮次。

## 考虑过的替代方案

**保留 256 默认值，把它当成形式。** 否决：当它被优先检查时它就不是形式。配置了两个预算的部署仍会看到 goal 在 256 轮停止，而模型会在每一轮的提示词里看到这个数字。

**用 `0` 或 `-1` 表示「无上限」。** 否决：两者今天都是非法正整数，任一选择都会把一个被拒绝的值变成有意义的值，并让所有既有校验读起来完全相反。`null` 是两个预算已经在用的拼写，而且字段缺失在那边也已经表示无上限。

**在上限旁边加一个 `unlimitedRounds` 布尔值。** 否决：一个事实两个字段，而且每个读取者都得按正确顺序检查这对值。

**让上限可為 null，但把部署默认值留在 256。** 否决：出厂默认值正是讨论的对象。想要防爆栏的部署自己设置；配置了预算的部署就得到预算。

**用极大的整数表示无上限。** 否决：`Number.MAX_SAFE_INTEGER` 会在提示词与 `/goal` 输出里渲染成 `Round: 7/9007199254740991`，而且它宣称了一个部署并未选择的边界。

## 测试

`packages/goal/goal/tests/domain.spec.ts` 在具名上限的两侧与 null 上限下读取两个谓词。`goal.spec.ts` 向一个无上限的 goal 接纳三轮、重新折叠并恢复它，同时断言未配置部署默认值的 create 报告 null 上限。`projection.spec.ts` 断言状态 schema 仍拒绝超出具名上限的轮次数，并在上限为 null 时接受同一个计数。`goal-round-driver.spec.ts` 保留其有上限的 goal 以 `round-limit` 阻塞。`command-goal.spec.ts` 钉住无上限的状态行，`tool-goal.spec.ts` 同时钉住字段缺失，以及陈旧 `max_goal_rounds` 参数无法覆盖的部署上限。

## 后果

未配置上限而创建的 goal 只受其资源上限约束，或者在部署什么都没配置时不受任何约束。这是由部署做的选择，也与参考实现一致；先前的行为是部署既没要求、也看不见的约束。

对知道该字段可为 null 的读取者而言，这次持久化变更是放宽；对早于它的构建而言则是拒绝：旧解码器要求 `maxGoalRounds` 是正整数，会拒绝携带 `null` 的记录。这与[资源预算](2026-09-13-goal-resource-budgets.zh.md) 确立的单向边界相同，而且方向是安全的那一侧——前代构建会拒绝更新的日志，而不会把一个无上限的 goal 读成有上限。

`dsh-goal` 的出厂默认值现在完全不是边界，因此[配置目录](../../../../docs/config-catalog.zh.md)不再为 `defaultMaxGoalRounds` 列出默认值。Web profile patch 只带两个资源防爆栏。
