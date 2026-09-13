# Agent Note：目标预算计量的是 token 与活跃工作，而不仅是轮次

Status: implemented

[English](2026-09-13-goal-resource-budgets.md) | 中文

## 问题

目标唯一的聚合上限是 `maxGoalRounds`，它统计的是续跑周期数。轮次不是工作量的单位：读一个文件就停下的轮次算一轮，跑完整套测试矩阵十分钟的轮次也算一轮。因此该上限无法表达“给这个目标足够多的投入，但在它变得昂贵之前停下”，而为了允许长时间工作去提高上限，同时也提高了廉价空转轮次的上限。领域 README 直接记录了这个缺口：`maxGoalRounds` 不计量 token、货币、墙钟时间或提供方配额。

Codex 的 `ThreadGoal` 用两个资源预算取代轮次计数——一个 token 上限和一个耗时上限——并对照它们报告 `tokensUsed` 与 `timeUsedSeconds`。一个 Codex thread 承载一个目标；而一个 DSH 会话承载一串目标，因为已完成的目标可以被同一会话中的下一个目标替换。因此 per-thread 预算的忠实对应是 per goal，而不是 per session。会话级预算会因为同一会话中更早的目标花掉了额度而阻止一个新建目标，这是一种与被拒绝的工作毫无关系、也无法解释的停止。

有两个会话投影已经拥有了预算所需的数量，因此目标领域应当读取它们，而不是自己折叠出计数器：`tokenUsage`（[`@deepseek-ai/dsh-token-meter`](../../../../packages/llm/token-meter/README.zh.md)）在整个日志上累加四个互不相交的提供方用量桶，`sessionStats`（[`@deepseek-ai/dsh-session-stats`](../../../../packages/session/session-stats/README.zh.md)）累加模型与工具的墙钟时间。两者都是整份日志的累计总量，因此在会话中途创建的目标需要一个已记录的基线，这两个数字才能归属到它。

## 决策

`GoalSnapshot` 在 `maxGoalRounds` 之外承载两个上限：`maxGoalTokens` 与 `maxGoalWorkMs`，各自是正的安全整数，或在无上限时为 `null`。`null` 是“无上限”的持久化拼写，因此既不指定该字段、部署默认值也不存在的创建请求保持无上限，而不会获得一个零预算。

### 基线让累计总量可归属于单个目标

每一条非 clear 的 `goal/change` 都记录 `tokensAtCreate` 与 `workMsAtCreate`：创建变更时该会话的累计总量，从 `tokenUsage` 与 `sessionStats` 读取。严格折叠在后续每一次变更中都保留它们，就像保留 `roundsStarted` 一样，并拒绝任何移动其中之一的变更。随后 `GoalView` 把 `tokensUsed` 与 `workMsUsed` 推导为实时总量减去已记录的基线，并在零处截断。

已经记录了基线的目标保留它。通过 `edit` 获得第一个预算的目标——即在预算存在之前创建的目标——在该变更时记录当前总量，因此预算计量的是从那时起被接纳的工作，而不会追溯性地计入更早接纳的工作。

### 用量以活跃工作计量，而非墙钟时间

`workMsUsed` 是 `sessionStats.llmMs` 与 `sessionStats.toolMs` 之和，因此它只在模型流式输出或工具调用尚未结束时增长。Codex 报告的是经过的墙钟时间；DSH 的目标可以暂停一天再恢复，而墙钟时间会在什么都没跑的时候花掉预算。

### 两个预算都在排队下一轮之前停止续跑

`goal-round-driver` 在既有的轮次上限检查之后、预留轮次之前检查 `GoalView.exhaustedBudget`。预算耗尽会以稳定代码 `budget-limit` 阻塞目标，消息中指明上限、已花费量与需要提高的字段。`maxGoalRounds` 保持其位置与 `round-limit` 消息，因此未设置任何预算的部署观察到与之前完全相同的行为。`GoalService.resume` 拒绝预算已耗尽的目标，沿用既有的 `GOAL_INVALID_TRANSITION` 代码，因此被恢复的目标不会在下一轮又被阻塞。

`exhaustedBudget` 按 `tokens` 然后 `work` 的顺序报告第一个耗尽的上限。部署当前无法计量的预算报告为未耗尽：`create` 与 `edit` 本来就拒绝部署完全无法计量的预算，而事后被卸载的计量器不应让一个活跃目标搁浅。

### 花费被记录，因为提示会展示它

轮次提示会说明剩余额度（`Budget used: <已花费>/<上限> tokens`），使模型能够收敛，而不是在目标停止时才发现上限。[目标轮次不变式](../../../../packages/goal/goal-round-driver/src/invariant.ts)仅凭日志重新渲染该提示并与已接纳的消息比较，因此它渲染的花费本身必须是持久的。于是 `GoalMessageSource` 在接纳时承载该花费，严格折叠把它校验为可选的非负整数。不计量任何东西的部署在该数字处渲染 `unknown`。

### 指定预算的部署必须能够计量它

当请求指定了一个其投影未注册的上限时，`create` 与 `edit` 抛出 `GOAL_BUDGET_UNMETERED`，而不是接受一个无人执行的预算。`defaultMaxGoalTokens` 与 `defaultMaxGoalWorkMs` 是经过校验的部署默认值，在服务构造时与 `defaultMaxGoalRounds` 一样解析一次。

### 这些载荷新增不提升会话格式版本

两个上限在 `goal/change` 载荷中是可选的，`GoalChangeMeta.version` 保持 `1`。[版本规则](../architecture/2026-08-10-session-log-version-mechanism.zh.md)把普通的载荷新增视为对物理编解码器中立，因此 `SESSION_FORMAT_VERSION` 不变，也不新增相邻迁移边。有两个后果是有意为之：

- **已发布的日志仍可还原。** 在预算存在之前写入的记录既没有上限也没有基线，解码器将其读为无上限且不宣称用量数字。`GoalProjection.tokensAtCreate` 保持缺失而不会默认为零，因此这样的目标报告 `tokensUsed: null`，而不会宣称整个会话的花费。
- **较旧的读取方会拒绝较新的日志。** 解码器校验每条记录的字段集合，因此早于这些字段的构建会拒绝包含它们的日志，而不是把一个有预算的目标读成无上限。这是安全的方向，也符合“前代既不含回退、也不含降级支持”的规则。

## 后果

有预算的目标现在会因实际花费的工作而停止，因此 `maxGoalRounds` 可以提高到一个不再假装约束工作量的值。两个上限与轮次上限协同：先到的那个停止续跑，而阻塞代码说明是哪一个。

`goal` 投影的宿主状态新增两个可选字段，其 `stateVersion` 从 6 移到 7，因此该键已持久化的投影缓存行会被重新折叠而不是复用。

`dsh-goal` 现在读取两个它并不提供的投影。这些导入是纯类型的，且两者都未挂载时无预算的目标行为完全相同。已发布的 bundle 对两个预算的计量能力不同：base bundle 挂载 `token-meter`，只有 web-app bundle 挂载 `session-stats`，因此无头部署可以为 token 设预算，但在挂载统计插件之前会被拒绝设置工作预算。[`dsh-session-stats`](../../../../packages/session/session-stats/src/index.ts)还额外从包根重新导出其投影单元，这是它的 `SessionProjectionStateMap` 增强在仅导入包根的程序中加载所必需的——与 `dsh-token-meter` 已声明的模块边相同。

目标的花费是实时读数，不是持久状态。`tokensUsed` 与 `workMsUsed` 在每次读取时由当前投影重新计算，因此投影缓存重新折叠或会话恢复后报告的数字与日志所支持的一致。

## 考虑过的替代方案

**仅由配置解析的会话级预算。** 否决：它会因为同一会话中更早的目标花掉了额度而阻止一个新目标，也无法表达 per-objective 的上限。它同时也是改动更小的方案，这正是为什么需要正面回答用户可见的反对意见，而不是默认接受。

**自 `createdAt` 起的墙钟时间，与 Codex 的 `timeUsedSeconds` 一致。** 否决：暂停的目标会在什么都没跑的时候花掉预算。`GoalView.createdAt` 本来就是持久的，所以这是同一需求下更省事的读法。

**由轮次驱动器写入每轮的 `tokensUsed`。** 否决：它会在已经推进 `roundsStarted` 的、目标来源的 `user/message` 之外，为每一轮增加第二次 `goal/change` 变更，并且重复一个折叠随后必须与消息流对账的计数器。

**由目标自己折叠 `assistant/message.usage`。** 否决：`tokenUsage` 已经拥有该折叠，包括关闭被替换尝试槽位的重试替换规则。第二份实现必须精确复现它，并且会漂移。

**把轮次提示中的花费声明为非持久。** 否决：驱动器不变式会仅凭日志重新渲染该提示，从而让每个有预算的轮次都失败；而仓库规则是任何模型可见的内容都必须可从日志重建。

**用 `-1` 或 `0` 表示缺失的上限。** 否决：完全省略这些字段的已发布记录必须读为无上限，而显式 `null` 是唯一不会与零预算混淆的拼写。

**在计量器缺失时拒绝启动有预算的目标，或静默忽略预算。** 否决：一个悄悄什么都不执行的安全上限比一次拒绝更糟，而该误配置在指定它的那次变更处就是自足的。
