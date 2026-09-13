# Agent Note：部署設定的預算值同時是 goal 可獲得的最高值

Status: implemented

[English](2026-09-13-goal-budget-ceiling.md) | 中文

## 问题

`dsh-goal` 的两个预算字段只是默认值，仅此而已。`defaultMaxGoalTokens` 与 `defaultMaxGoalWorkMs` 为未指定上限的 create 请求提供上限，而自行指定上限的请求可以无限制地覆盖它们。因此部署可以声明一个花费防爆栏，却仍然看到 goal 被授予任意预算——因为唯一能越过该防爆栏的调用者，正是这个防爆栏本要约束的对象。

Codex 用结构本身解决了这一点：`[goals] max_goal_token_budget` 被记录为「允许一个 goal 的最大 token 预算，同时是新 goal 的默认预算」，而 `validate_goal_budget` 会拒绝请求预算超过它的 create 或 update。一个配置值，两项职责。

字段名也不再诚实。一个既是默认值又是最大值的值并不是默认值，而 `default*` 前缀恰好招致了造成这个缺口的读法。

## 决策

两个配置字段是 `maxGoalTokens` 与 `maxGoalWorkMs`，各自既是 create 请求继承的默认值，也是任何 create 或 edit 可指定的最大值。

`resolveBudget(value, limit, field)` 会对照该上限解析每一个预算请求：字段省略时继承它，具名值必须是正的安全整数且不大于它，而显式 `null` 仅在部署不作约束时才被接受。超过上限的请求，或在部署有约束时要求无上限预算的请求，会以新的稳定代码 `GOAL_BUDGET_EXCEEDS_LIMIT` 被拒绝。规则施加在做决定的那个操作里——create 的解析与 edit 的解析都传入部署的上限——因此没有任何调用者能触达部署未允许的预算。

部署配置由 `validateDeploymentCeiling` 单独校验：它要求正的安全整数，并在服务构造时以 `GOAL_INVALID_BUDGET` 拒绝不可用的值，而不是拖到第一次 create。

清除上限仍然是部署的决定，且依然可用：在组合条目里取消 `maxGoalTokens`，或在设置行里清空该字段，会同时移除默认值与最大值，此后 goal 不再带 token 预算，除非请求自行指定。

## 考虑过的替代方案

**把两个字段分开：`defaultMaxGoalTokens` 作默认值，另加一个 ceiling 字段作最大值。** 否决：在没有收益的前提下扩大接口——参考实现只有一个旋钮而这里会有两个，要解释两个字段，而且只设默认值的部署仍然没有防爆栏。想要「低默认值 + 高最大值」的部署，其实是在要一个它并不想真正执行的约束。

**保留字段名，只改执行。** 否决：一个同时限制上限的 `defaultMaxGoalTokens` 是与其行为矛盾的命名，而正是这种矛盾会被下一个读者照做。

**允许 edit 把预算提高到超过上限，只限制 create。** 否决：edit 恰恰是放宽 goal 预算的途径，这样一来上限就只是装饰。

**一律拒绝显式 `null`。** 否决：`null` 是领域层「无上限」的拼写，在部署不作约束时仍然有意义。只有在接受它会与已配置上限矛盾时才拒绝。

**把上限同样施加到 Round 上限上。** 否决：轮次不是本部署计量的资源，`create_goal` 根本无法指定上限，而修改它的 `edit` 本来就要求运行时根轮次中存在直接人类消息。

## 测试

`packages/goal/goal/tests/goal.spec.ts` 覆盖两条路径上的上限：create 继承配置值、create 指定更小的值被接受、create 或 edit 指定更大的值以 `GOAL_BUDGET_EXCEEDS_LIMIT` 被拒绝、在已配置上限下 edit 指定 `null` 被拒绝、edit 指定更小的值被接受，以及不可用的配置上限在构造时失败。这个测试的第一版抓到了一个真实缺陷——edit 路径用 null 上限解析预算，于是上限在 create 上成立、在 edit 上不成立。

`packages/client/ui-goal/tests/goal-defaults-row.client.spec.tsx` 与 `browser-plugin.client.spec.tsx` 跟随重命名后的字段穿过设置行，而其文案现在说明预算同时是任何 goal 可获得的最高值。

## 后果

模型可以收紧某个 goal 的预算，但永远不能把它放宽到部署允许的范围之外——这正是预算存在的意义。人类仍然可以修改上限本身，而由于[默认值就是一个 settings section](2026-09-13-human-owned-goal-limits.zh.md)，这项修改不需要重启。

部署接纳的每一个 goal 现在都从该部署的预算开始，而不是从无预算开始。想要无上限 goal 的部署仍然把两个字段都留空，与之前完全一致；变化在于，设置其中一个不再让另一个方向敞开。

配置目录与 Web 设置行都带上了新名称。`defaultMaxGoalTokens` 与 `defaultMaxGoalWorkMs` 是被移除而不是保留别名：它们与本次改动在同一天发布，且没有任何已发布的部署配置使用过它们。
