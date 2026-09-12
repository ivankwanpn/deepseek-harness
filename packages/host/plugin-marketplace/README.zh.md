---
description: "解析 marketplace manifest（元数据清单）、按钉住的 commit 抓取单个插件，并把它调和进用户 patch 层与 skill（技能）发现根目录，从而安装并启用 Claude 生态的 marketplace 插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-marketplace

[English](README.md) | 中文

## 概述

本包解析 Claude 兼容的 `marketplace.json`，浏览已注册的 marketplace 提供的内容，按钉住的 commit 安装其中一个插件，并在不让核心认识外部 schema 的前提下把它调和进 DSH：插件携带的每个 skill 都**平铺**落地到发现根目录，每个 `.mcp.json` 服务器成为一条 loader 行。启用是一个动词、两种机制：行上的 `disabled` 标志，以及把 skill 移出发现范围。所有写入都只限于 marketplace 自己拥有的条目，因此用户自己的 patch 与 skill 永远不会被改写。命令行与 Web 设置面板共用同一份实现，而部署可以用 `allowMutations` 关掉面板的写入动词。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当用户要求 DSH 从插件 marketplace 安装东西时调用本包。CLI（命令行界面）面是 `dsh plugin marketplace <add|list|search|install|uninstall|installed|enable|disable>`；程序化面是 `catalog`、`installPlugin`、`sync` 与 `setEnabled`；Remote 面是 `MarketplaceGateway`，它用 `marketplace.status` 与 `marketplace.catalog` 读取、用 `marketplace.install`、`marketplace.setEnabled` 与 `marketplace.uninstall` 写入，支撑 Web 设置面板。

```ts
import { defaultStatePath, installPlugin, loadState } from '@deepseek-ai/dsh-host-plugin-marketplace'

const harnessHome = '/home/user/.dsh'
const patchLayerPath = `${harnessHome}/cordis.patch.yml`
const statePath = defaultStatePath(harnessHome)
const result = await installPlugin('aikido', {
  state: loadState(statePath),
  statePath,
  sync: { patchLayerPath, materialize: { harnessHome } },
})
```

### 一次安装会产出什么

- **skill** 会被复制进 agents skills 根目录，每个都直接位于其下——那是 `skill-filesystem` 唯一读取的层级。发现是动态的，因此无需重启即可生效。
- **MCP 服务器**各成为一行，挂载 `@deepseek-ai/dsh-mcp-client`，并把插件的 `.mcp.json` 规范化为 DSH 的配置形态。
- **一条状态记录**位于 harness home 之下，写明 marketplace、插件、钉住的 commit、内容最终落地的位置，以及该插件拥有哪些发现根目录条目。

用户 patch 层由 Cordis HMR（热模块替换）监视，因此写入的行无需重启即可生效。

<a id="understand-the-implementation"></a>
## 理解实现

### 设计理念

**是翻译层，不是注册表。** 外部格式是其他 harness 也在读的事实标准；让 DSH 核心认识它，等于把一个第三方 schema 焊进自带生命周期的内部模型。因此本包只在边缘解析这个 schema，转而用 DSH 已有的原语表达它的*效果*——一个 skill 目录加一条 loader 行——核心从不需要认识「marketplace」这个词。

### 两种机制，一个动词

skill 与 loader 行的行为差异足够大，把它们合并起来在两个方向上都是错的：

| 内容 | 挂载方式 | 停用方式 |
|---|---|---|
| skill | 每个 skill 一个条目，直接位于发现根目录下 | 把拥有的每个条目移到 `<root>/.disabled/<plugin>/` |
| MCP 服务器 | 一条 loader 行 | 该行的 `disabled` 标志 |

对一条从未写入的行报告「已安装」会是假的，而把 skill 注册两次——一次靠发现、一次靠行——会让它们翻倍。因此 `enable`/`disable` 两者都做，并报告实际移动的是哪一方。

### 谁拥有什么

- **存在性与来源**存于 marketplace 状态文件
- **启用状态**存于 patch 层，用户在那里看得见，也能手工编辑

把同一个事实拆到两个文件，就是「我停用了它，它又回来了」这类现象的成因，因此 `disabled` 只有一个归属。sync 在组合之前会把当前值读回来，手工编辑因此得以留存。

行 id **不是**插件名称的函数：MCP 行的键是净化后的服务器名称，而一个插件可能声明多台服务器。安装会把解析出的 id 记入状态条目，`enable`/`disable` 只针对这些 id——调用方若自行重算 `marketplace:<plugin>`，将匹配不到任何行、什么也不写，却仍报告成功。skill 条目出于同样的理由以同样方式记录：发现根目录是平铺的，一个插件按 skill 逐个贡献条目，只有记录能说明是哪些。

正因为根目录是平铺的，两个插件携带同名 skill 条目就是真实冲突。状态顺序中靠前的条目保留该名称，靠后的那个会被报告而非覆盖，因此任何一方都无法悄悄替换对方的 skill，或在卸载时删掉它。

两个清理函数按「允许删什么」分工。`removeMaterializedSkills` 只删除传给它的那些条目名（存活态或停放态），sync 用它丢弃插件不再提供的名称。`removePluginSkills` 是卸载用的更宽清理：同样那些名称，加上停放目录与更早的布局所写的按插件隔离容器。这个分工是关键：停放目录是**已停用**插件唯一的 skill 副本，把它并进 sync 路径，会在第一次丢弃陈旧名称时就把它们删掉。

### catalog 读取

`src/catalog.ts` 拥有一份两个面都会调用的读取。它按存储顺序走访每个已注册的 marketplace，并为每个条目回传一列：列表要渲染的栏位、提供该条目的 manifest 所声明的名称、本包的 pin 规则是否接受该来源、是否已存在安装记录，以及条目自带的警告。

`installable` 是那条 pin 规则对 manifest 所声明的那个条目的判定，并不保证安装一定成功：安装会先重新解析来源，因此这次读取接受的、相对于 marketplace 的 `local` 条目会变成一个不带 `sha` 的 git 子目录，随后被以未钉住为由拒绝。两个判定恰好只在这类条目上不一致。

读不动的注册变成一条携带其注册名与 fetch 层原因的失败，循环随即继续下一个。CLI 的 `search` 会把每条失败打印到 stderr，并照旧打印可读注册所提供的匹配结果，因此沉默永远不会被读成「这个 marketplace 什么都没列」。空查询列出全部；没有任何注册的部署则解析为空而不是拒绝——`search` 对那种情况保留自己单独的拒绝。

这次读取接受一个可选的 fetch 预算，而 `marketplace.catalog` 不传：每次 manifest 读取都使用 fetch 层自己的预算。它是这个 Remote 面上唯一会触达网络的读取，因此面板按需索取，而不是在分页打开时载入。

该遍历刻意不与 `resolveEntry` 共用——后者解析一个名称，并在第一个列出它的 marketplace 就停下。catalog 必须走完每一个注册，而合并两者会让每次安装都去抓取每一个已注册的 marketplace，只为在读路径省下一个循环。

### Remote 界面

Web 设置面板与 `MarketplaceGateway`（Remote 命名空间 `marketplace`）通信：`marketplace.status` 与 `marketplace.catalog` 读取，`marketplace.install`、`marketplace.setEnabled` 与 `marketplace.uninstall` 写入。有四条规则贯穿其中。

**读取永不写入。** `marketplace.status` 从状态记录与插件自己的 `skills/` 目录解析拥有关系，并从 patch 层解析启用状态。它不做落地，因此打开一个设置标签页不会在用户磁盘上复制或移动任何东西。`marketplace.catalog` 只抓取 manifest。

**写入是否存在由部署决定。** `allowMutations` 组态栏位（预设 `true`）在写入路径本身检查。面板会从状态快照读到同一个旗标，并在其为 false 时不渲染任何控件，但该旗标在每次调用时都被强制执行：隐藏的按钮永远不是强制点。浏览不是变更，因此在只读部署上 `marketplace.catalog` 照常应答，而 `marketplace.install` 以 `marketplace/read-only` 拒绝。

**每个操作只有一份实现。** 命令行与面板在启用上调用 `src/operations.ts` 的 `setPluginEnabled`，在读取上调用 `src/catalog.ts` 的 `catalog`，在安装上调用 `installPlugin`，因此两个面不可能对「该插件拥有哪些行与发现根目录条目」或「marketplace 提供什么」产生分歧；`marketplace.install` 只是在那次调用外面加上 Remote 层的检查。每次写入还会返回它产生的那份状态，因此面板渲染的是写入之后的事实，而不是再发一次可能与刚完成的写入竞争的读取；`marketplace.install` 还会一并返回记录的 `sha` 与该次安装的警告。

**拒绝在 wire 上保持自己的身份。** `InstallError` 携带来自封闭集合 `InstallRefusal` 的结构性 `reason`——`name-unusable`、`no-marketplace`、`not-found` 或 `unpinned`——gateway 把它映射成 `RemoteErrorDetailsMap` 的代码，而不是比对消息文本，因此改写措辞无法改变客户端被告知的内容。不可用的名称是 `gateway/bad-request`，空注册或未列出的名称是 `marketplace/not-found`，请求未接受的、没有 `sha` 的来源是 `marketplace/unpinned`。准入之后的故障根本不是拒绝：它是 `marketplace/install-failed`，携带该故障自己的原因。

状态视图报告每个已安装插件的两项事实，而这两项 patch 层答不出来。`skillIds` 指名该插件拥有的发现根目录条目，`skills` 说明它们在哪：`live` 在发现根目录、`parked` 在 `<root>/.disabled/<plugin>/` 之下，或 `none` 表示该插件不提供任何可被发现的 skill。skill 靠发现挂载而非靠行，因此它的位置在 patch 层里根本没有对应表示。

### 指向 marketplace 内部的来源

manifest 条目可以用相对于 marketplace 仓库的路径指名内容（`./plugins/foo`），这种做法在官方注册表的 294 个条目中实测有 52 个。该路径会对 manifest 被读取的那个仓库解析，而不是进程的工作目录。

这些条目都不声明 `sha`，因此 pin 规则默认仍然拒绝它们。`--allow-unpinned` 把拒绝换成**记录下来的 commit**：解析器向远端询问它的 ref 指向何处，该 commit 就成为这次安装的 pin，`install` 会把它连同 manifest 自带的那个一并打印出来。拒绝本身是准确的，但帮不上忙——解析器已经知道它即将抓取哪个 revision，记录下来不损失什么，还让这次安装可被验证。

### 源码地图

| 文件 | 职责 |
|---|---|
| `src/parse.ts` | manifest 解析；严格，并会报告未钉住版本的来源 |
| `src/fetch.ts` | 经进程级代理策略抓取 manifest |
| `src/git.ts` | 钉住版本的抓取（`execFile`，只传 argv——绝不用 shell）与能力检测 |
| `src/state.ts` | 已安装记录 |
| `src/patch-layer.ts` | 把行组合进用户 patch 层；唯一的写入方 |
| `src/materialize.ts` | 能力 → 落地面的映射：MCP 规范化、skill 平铺落地，以及带拥有关系的清理 |
| `src/operations.ts` | 命令行与 Remote 面共用的写入操作 |
| `src/catalog.ts` | 命令行 `search` 与 `marketplace.catalog` 共用的 catalog 读取 |
| `src/gateway.ts` | Remote 面：两个读取与三个受闸门的写入动词 |
| `src/sync.ts` | 状态 → materialize → patch 层 |
| `src/install.ts` | 解析 → 抓取 → 记录 → sync |
| `src/marketplace-command.ts` | CLI 面 |
| — | 不发布运行时不变式伴生入口；本包不拥有持久事件流，它的三个写入面（状态文件、patch 层与发现根目录）在写入前都由对各自输入的一次重新读取推导而来。 |

<a id="further-exploration"></a>
## 进一步探索

- `packages/host/plugin-inventory`——已组合内容的只读视图，供展示用。
- `packages/mcp/mcp-client`——每条 MCP 行都会挂载的模块。
- `packages/skill/skill-filesystem`——发现 skill 的地方，以及由哪个环境变量选择根目录。
- `packages/boot/app-boot`——patch 层、它的 `!!js` 方言，以及让它即时生效的 watcher。

<a id="model-experience"></a>
## 模型体验

### 已安装的 skill

#### 模型看到什么

插件随包提供的每个 skill 都成为一个目录条目，只携带它的 `name` 与 `description`，由 [`skill-filesystem`](../../skill/skill-filesystem/README.zh.md) 从 agents skills 根目录发现。正文在模型调用 `skill` 工具之前不进入提示词。本包不添加任何自己的文字：manifest 的营销描述永远不会到达模型，插件的来源也一样不会。

#### Token 影响

只要插件保持启用，每个 skill 就占据目录中的一行。已停用的插件不贡献任何内容，因为它的 skill 是被移出发现根目录，而不是被打了标记。

#### KV Cache 影响

常见情况下是仅追加：启用或停用插件会改变目录，因此系统提示词前缀在该边界上变化一次，此后保持稳定。

### 已安装的 MCP 服务器

#### 模型看到什么

插件声明的每台服务器都表现为以 `mcp__<serverName>__<tool>` 命名的工具，经 [`mcp-client`](../../mcp/mcp-client/README.zh.md) 挂载。当插件自身的名称不适用时，服务器名称会被净化为 `[A-Za-z0-9_-]{1,32}`；改名会被报告，因为已保存的审批与会话历史正是以这个公开名称为键。连不上的服务器不贡献任何工具，也不会让该轮次失败。

#### Token 影响

工具 schema 在每次注册后都是静态的，而且不大；结果文本则取决于服务器返回什么。已停用服务器的行会以 `disabled: true` 留在 patch 层，因此 patch 层一重载，它的 schema 就离开提示词。

#### KV Cache 影响

在已启用服务器集合不变时保持稳定。新增或移除服务器会改变工具块，因此复用从该点起失效，而不是整个会话都失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有可由 loader 挂载的运行时插件。** 对照 294 个插件的官方注册表实测：没有任何条目提供 cordis 可挂载的入口点。唯一带 `package.json` 的插件是 MCP 服务器源码（有依赖，但没有 `main`/`exports`），它们经 MCP 路径进来。因此运行时入口会是一个从未演练过的猜测，`InstalledCapability` 也就不宣称它。
- **`commands/` 会被检测到，但这是格式缺口，不是接线缺口。** 该能力会被报告，目录会被记录，但它无法靠接通两个 API 来挂载：Claude 插件的命令是一个 Markdown 文件，其 frontmatter 携带 `description`，正文则是一段面向模型的指令（`## Your Task` …），因此调用它就意味着把那段文字作为提示词发送。DSH 的 `CommandDefinition.handler` 在文档中被描述为「对接收该命令的 agent 执行，*不把命令发送给模型*」（`packages/interaction/commands/src/index.ts`），而 `CommandInvocation` 只暴露 `commandId`、`agent`、`rawInput`、`attachments` 与 `signal`——没有任何通往模型的路径。给 DSH 加上提示词展开式命令属于核心能力决策，因此本包诚实报告该能力，而不是假装能挂载它。
- **条目里的 `lspServers` 会被解析，但不会被挂载。** 它是 manifest 唯一内联声明的能力，294 个条目中有 12 个。
- **没有更新或版本钉住策略。** 重新安装插件会就地替换它；钉在会移动的 ref（有 `ref` 却没有 `sha`）上的插件会被拒绝而不是被解析，这意味着这类条目根本无法安装。
- **未钉住的条目需要显式 opt-in。** 官方 294 个条目中有 52 个以相对于 marketplace 仓库的路径指名内容，且没有一个带 `sha`。该路径会对那个仓库解析，但除非传入 `--allow-unpinned`，pin 规则仍会拒绝安装；该旗标会把来源的 ref 解析成它*现在*指向的 commit 并记录下来。这次安装因此是一个具体的 revision，可以要求它始终保持在该 revision 上，但它是某个 ref 的快照，并不保证下一次安装仍然一致。钉在会移动的 ref 上的条目则无论如何都不受影响。
- **manifest 抓取是 GitHub 形状的。** repository url 会被解析成它的 `raw/main` manifest；其他主机则需要显式的 manifest url。
- **skill 条目必须在插件的 `skills/` 目录顶层就能被发现。** 一个不含 `SKILL.md` 的目录，或一个非 Markdown 的文件，会被报告并跳过而不是复制：`skill-filesystem` 恰好只读一层，把它复制进发现根目录只会产出一个模型永远看不到的文件。
- **catalog 是一份快照。** marketplace 可能在读取与点击之间改变。`marketplace.install` 会在安装时从注册重新解析该条目，因此记录的 pin 是当下的那个、而不是面板显示的；一个在两次读取之间消失的名称会以 `marketplace/not-found` 失败，而不是安装了别的东西。
- **未钉 sha 的安装会记录一个使用者没看过的 commit。** 该选项在安装时解析来源的 ref 并记录那个 commit；被记录的 revision 是由远端在安装当下选定的。
- **浏览不受 `allowMutations` 管辖。** 只读部署仍会执行 catalog 的网络抓取。浏览不是变更，因此只读姿态并不会让面板在网络层面静默。
- **注册 marketplace 仍留在命令行。** Remote 面列出已有的注册并从中安装；新增一个要靠在终端里执行 `dsh plugin marketplace add`。
- **catalog 读取可能变慢，或因机器之外的原因失败。** 因此即使使用者的插件毫无问题，catalog 的失败也会抵达面板，这是向 marketplace 询问它提供什么所要付的代价。
- **搜索判定在两个面上各有一份。** 命令行在 Host 端过滤，面板在浏览器过滤，因为它们是不同的程序，而按规则 `./types` 只放类型。双方用同样的四个栏位钉住同一次子字串测试，因此分歧会是测试失败而不是无声的差异。
- **注释保留是尽力而为。** 写 patch 层会重新序列化该文件，而完整 dump 留不住用户的注释。只有组合出的行确实发生变化时才会写入，且变更检测经过规范化，因此单是键序不同永远不会触发写入。

<a id="dev-note"></a>
### 开发备注

本包针对的失效模式全部来自实测而非假设，而且都是探针发现的，不是评审发现的：

- `insert` 会 **push**，因此把同一个 id 插两次会让该行出现两次；组合时必须先丢弃自己此前的行。
- 只依据目标行重新组合，**抹掉了一个它从未设置过的 `disabled` 标志**——两处真源的 bug，由探针捕获。
- 用 dump 比对来检测变更，会让**单是键序不同也看起来像一次变更**，从而白白重写一个手工注释过的文件。
- 按插件给 MCP 行的 id 加命名空间**掩盖了一个真实冲突**：`mcp-client` 按 scope 保留 `serverName`，遇到重复就抛错，因此 id 改为以服务器名称为键。
- 改以服务器名称为行 id 的键之后，**又弄坏了启用切换**：命令面仍在自行重算 `marketplace:<plugin>`，匹配不到任何行、什么也没写，却报告成功。现在这些 id 会在安装时记录、之后再读回。
- 相对 marketplace 的来源被当作**相对 cwd 的路径**读取，因此每个以这种方式指名内容的条目都失败，报的是找不到本地文件。实测为 294 个中的 52 个。
- 用「在 **manifest** url 后面追加 `.git`」来推导该来源的 clone url，得到的是 `…/raw/main.git`；raw 内容 url 不是仓库，因此这一映射改为显式且限定主机。
- 磁盘上的能力比对**漏掉了 `commands/`**，因此每个带该目录的插件每次 sync 都永远报告「磁盘上的能力已变更」，原因是安装记录了一个比对永远找不到的能力。
- `skills/` 子树被复制进一个**按插件隔离**的目录，比 `skill-filesystem` 读取的位置深了一层。安装、状态与设置面板全都报告成功，模型却一个 skill 都拿不到——发现它的是「向真实 provider 询问它究竟发现了什么」的探针，而任何只针对目标目录本身的断言都做不到。
- 卸载删掉了插件目录，却**从未碰过发现根目录**，因为落地后的 skill 按设计就在它之外。只有被记录的拥有关系才让它们可被删除。

### 测试

`tests/marketplace.spec.ts` 钉住这两条身份规则。每条断言都针对结果来写——patch 层实际持有什么、开关是否返回 true——因此它在重构下保持绿色，而在修正被回退时转红；两个行 id 测试与两个 url 测试都已确认在回退实现后失败。

`tests/skills.spec.ts` 直接向真实的 `dsh-skill-filesystem` provider 询问它发现了什么，而不是把布局规则复述成路径字面量：其中落地测试对曾经发布的按插件隔离复制会失败，且已实测确认。
