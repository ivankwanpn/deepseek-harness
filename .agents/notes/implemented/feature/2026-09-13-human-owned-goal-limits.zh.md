# Agent Note：人类通过设置与模型设定 goal 的上限

Status: implemented

[English](2026-09-13-human-owned-goal-limits.md) | 中文

## 问题

一旦部署拥有了 goal 的轮次上限，其他人就再也改不动它。[轮次上限归属决策](2026-09-13-deployment-owned-goal-round-cap.zh.md) 把 `max_goal_rounds` 从 `create_goal` 移除，因此配置的默认值适用于每一个新建 goal，而创建时不再有别的路径指定上限。这三个默认值在服务构造时从组合条目一次性解析，所以想要不同上限的部署只能改 `cordis.yml` 并重启。

缺的不是坏掉的功能，而是两条人类路径。`update_goal` 的 `edit` 本来就能在直接人类权限下修改轮次上限与两个预算，但 goal 的提示词区段从未说明「人类要求某个上限」就是一次应用请求，因此模型没有任何指引把措辞与工具连起来。而[面向模型的工具说明](2026-07-19-model-facing-goal-tools.zh.md) 声称「领域层的显式 `null` 与 `/goal` 仍是清除路径」，可 `/goal` [根本没有上限参数](../../../../packages/goal/command-goal/src/index.ts)：它在本机解析 `<objective>`、`clear`、`edit`、`pause`、`resume` 并直接调用 goal 服务，因此 `/goal` 后面输入的文字永远不会到达模型。

## 决策

人类得到两条既有管线，不需要新语法。

### 默认值就是一个 settings section

这三个字段同时就是 `goal` [settings](../../../../packages/settings/settings/README.zh.md) namespace，通过 `installSection` 注册，使组合条目既是 base 层也是回退值。`GoalService` 持有的是配置来源而非已解析的值，`create` 每次调用都从该来源推导默认值，因此已提交的变更约束的是下一个 goal，而不是下一个进程。清空字段会重新继承组合条目。

没有任何东西被记忆化，因此也没有 watcher 需要重新推导：生产中 `scope.watch` 只出现在 `installSection` 内部。该 section 自身的 schema 检查字段类型，另外还有一个 `validate` 钩子对解析结果运行领域自身的解析，因此那些能通过 schema、却没有任何 `create` 能执行的值——例如超出 `Number.MAX_SAFE_INTEGER` 的轮次上限——会在写入时被拒绝，而不是留到下一次 create。

没有设置提供方的部署完全按组合继续工作：来源 thunk 返回组合条目，注册根本不会发生。

### Web 设置面板编辑它们

`ui-goal` 通过 `ctx.settingsScope.bind` 向「通用设置」区段贡献一行「目标上限」。三个字段在每次输入被接受时写入；留空则清除该覆盖值。这一行同时需要设置传输与「通用设置」区段，因此在 `ctx.inject(['settingsScope'], …)` 子注入里用 `ctx.slots.inject('settings.general.item', …)` 注册：缺少任一项的组合保留 GoalBar 并丢掉这一行，而停用「通用设置」区段的组合不会在加载时失败。

### 模型落实人类指定的上限

goal 提示词区段现在说明哪个工具负责落实人类的上限请求——`create_goal` 接受预算，`update_goal` 的 `edit` action 修改当前 goal 的轮次上限或任一预算——并说明人类未指定的部分沿用部署默认值。这覆盖了所有能到达模型的界面，包括没有设置面板的 headless 与 ACP 会话。

`/goal` 依旧不带上限参数。想给某个 goal 指定上限的人类在对话里说明；想改默认值的人类在设置或 `cordis.yml` 里改。

## 考虑过的替代方案

**在 `/goal` 上加旗标语法，例如 `/goal <objective> --rounds 40`。** 否决：该命令在本机解析输入并调用 `ctx.goals.create`，不产生模型轮次，因此旗标需要自己的 parser、自己的文案与自己的测试；而模型已经拥有一条按普通措辞工作的、经授权的 `edit` 路径。它也完全帮不到 headless 界面——那些界面根本不消费 commands。

**只做 Web 表单，不加模型指引。** 否决作为完整方案：通过 ACP 自动化界面或一次性 headless profile 驱动的会话没有设置面板，而部署的 YAML 是唯一的其他控制手段。

**缓存该 section 并由 watcher 刷新。** 否决：唯一的读取者是 `create`，缓存只会在已提交变更与下一次 create 之间引入陈旧窗口，毫无收益。[agent-loop](../../../../packages/core/agent-loop/src/index.ts) 的直读 getter 是既有范例。

**把这一行注册进 `ui-settings-general`。** 否决：按该包自身的约定，「通用设置」区段不内置任何行；外壳声明 slot，每个 feature 拥有自己的行。

**像 permission-presets 那样通过 `describe()` 读取、通过 `remote.settings.mutate` 写入。** 否决：那一行需要 namespace schema 才能渲染动态选项集。三个固定的数字字段不需要，`settingsScope.bind` 不产生任何线上读取，而新增一个直接的 `describe` 调用者会拖累 Web 启动的 RPC 预算。

**把 `settingsScope` 声明在插件的顶层 `inject`。** 否决：那会让整个插件（包括 GoalBar 条带）都取决于设置插件是否挂载。子注入把这个依赖限定在这一行上。

## 测试

`packages/goal/goal/tests/goal.spec.ts` 用内存设置提供方挂载领域，证明已提交的 section 会改变之后 `create` 解析出的上限、写入之前组合条目仍然生效，以及没有 `create` 能执行的已存轮次上限会在写入时被拒绝。

`packages/client/ui-goal/tests/goal-defaults-row.client.spec.tsx` 覆盖该行：解析值渲染、无上限预算渲染为空、合法输入写入、被拒输入显示其文案且不写入、清空的字段走清除路径。

`packages/client/ui-goal/tests/browser-plugin.client.spec.tsx` 证明注册及其释放：该行以所属 locale 与 order 注册到 `settings.general.item`，inject face 在注册时即采纳该 section 以保证首次渲染不为空，编辑路由到 scope 的 `set`／`unset`，卸载插件 fiber 会同时撤回该行与其订阅。

Web lane 的 `apps/web/tests/settings-chrome.e2e.ts` 金标在组装后的设置对话框里渲染出这一行，含解析出的轮次上限与空预算字段，因此 section、scope 绑定与文案都有端到端覆盖。

## 后果

部署的 `cordis.yml` 仍然是默认值，并在其上多了一个实时的用户层。已记录在会话日志中的 goal 保留它存下的上限；该 section 约束的是创建。

`ui-goal` 现在对 `ui-settings` 有一个仅类型的依赖，并且最多只贡献一行：没有设置、没有「通用设置」区段，或文档不可写，条带都保持原样。

`/goal` 命令仍不能设定上限，[人类 goal 命令](../../archived/feature/2026-07-19-human-goal-command.md) 笔记中「没有逐命令 Round 上限参数」的限制依然成立——人类通过设置或要求模型来接触这些上限。
