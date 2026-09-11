---
description: "解析 marketplace manifest（元数据清单）、按钉住的 commit 抓取单个插件，并把它调和进用户 patch 层与 skill（技能）发现根目录，从而安装并启用 Claude 生态的 marketplace 插件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-marketplace

[English](README.md) | 中文

## 概述

本包解析 Claude 兼容的 `marketplace.json`，按钉住的 commit 抓取一个插件，并在不让核心认识外部 schema 的前提下把它调和进 DSH：skill 落地到发现根目录，每个 `.mcp.json` 服务器成为一条 loader 行。启用是一个动词、两种机制——行上的 `disabled` 标志，以及把 skill 移出发现树。所有写入都只限于 marketplace 自己拥有的 id，因此用户自己的 patch 永远不会被改写。

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

当用户要求 DSH 从插件 marketplace 安装东西时调用本包。CLI（命令行界面）面是 `dsh plugin marketplace <add|list|search|install|uninstall|installed|enable|disable>`；程序化面是 `installPlugin`、`sync` 与 `setEnabled`。

```ts
import { defaultStatePath, installPlugin, loadState } from '@deepseek-ai/dsh-host-plugin-marketplace'

const statePath = defaultStatePath(harnessHome)
const result = await installPlugin('aikido', {
  state: loadState(statePath),
  statePath,
  sync: { patchLayerPath, materialize: { harnessHome } },
})
```

### 一次安装会产出什么

- **skill** 会被复制进 agents skills 根目录，`skill-filesystem` 在那里发现它们。发现是动态的，因此无需重启即可生效。
- **MCP 服务器**各成为一行，挂载 `@deepseek-ai/dsh-mcp-client`，并把插件的 `.mcp.json` 规范化为 DSH 的配置形态。
- **一条状态记录**位于 harness home 之下，写明 marketplace、插件、钉住的 commit，以及内容最终落地的位置。

用户 patch 层由 Cordis HMR（热模块替换）监视，因此写入的行无需重启即可生效。

<a id="understand-the-implementation"></a>
## 理解实现

### 设计理念

**是翻译层，不是注册表。** 外部格式是其他 harness 也在读的事实标准；让 DSH 核心认识它，等于把一个第三方 schema 焊进自带生命周期的内部模型。因此本包只在边缘解析这个 schema，转而用 DSH 已有的原语表达它的*效果*——一个 skill 目录加一条 loader 行——核心从不需要认识「marketplace」这个词。

### 两种机制，一个动词

skill 与 loader 行的行为差异足够大，把它们合并起来在两个方向上都是错的：

| 内容 | 挂载方式 | 停用方式 |
|---|---|---|
| skill | 发现根目录下的目录 | 移到 `skills/.disabled/<plugin>` |
| MCP 服务器 | 一条 loader 行 | 该行的 `disabled` 标志 |

对一条从未写入的行报告「已安装」会是假的，而把 skill 注册两次——一次靠发现、一次靠行——会让它们翻倍。因此 `enable`/`disable` 两者都做，并报告实际移动的是哪一方。

### 谁拥有什么

- **存在性与来源**存于 marketplace 状态文件
- **启用状态**存于 patch 层，用户在那里看得见，也能手工编辑

把同一个事实拆到两个文件，就是「我停用了它，它又回来了」这类现象的成因，因此 `disabled` 只有一个归属。sync 在组合之前会把当前值读回来，手工编辑因此得以留存。

行 id **不是**插件名称的函数：MCP 行的键是净化后的服务器名称，而一个插件可能声明多台服务器。安装会把解析出的 id 记入状态条目，`enable`/`disable` 只针对这些 id——调用方若自行重算 `marketplace:<plugin>`，将匹配不到任何行、什么也不写，却仍报告成功。

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
| `src/materialize.ts` | 能力 → 落地面的映射，含 MCP 规范化 |
| `src/sync.ts` | 状态 → materialize → patch 层 |
| `src/install.ts` | 解析 → 抓取 → 记录 → sync |
| `src/marketplace-command.ts` | CLI 面 |
| — | 不发布运行时不变式伴生入口；本包不拥有持久事件流，它的两个写入面（状态文件与 patch 层）各自以写入前的一次重新解析把关。 |

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

### 测试

`tests/marketplace.spec.ts` 钉住这两条身份规则。每条断言都针对结果来写——patch 层实际持有什么、开关是否返回 true——因此它在重构下保持绿色，而在修正被回退时转红；两个行 id 测试与两个 url 测试都已确认在回退实现后失败。
