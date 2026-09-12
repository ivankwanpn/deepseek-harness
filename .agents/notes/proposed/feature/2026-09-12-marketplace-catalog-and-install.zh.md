# Agent Note: The marketplace panel browses and installs plugins

Status: proposed

[English](2026-09-12-marketplace-catalog-and-install.md) | 中文

## 问题

marketplace 面板管理的是**已经安装**的插件。它无法显示有哪些可用，也无法安装其中任何一个。刚注册完一个 marketplace 的使用者只看得到它的名字：该市场提供的条目只存在于终端里的 `dsh plugin marketplace search` 之后。于是每一个改变安装状态的决定，都从显示它的那个界面之外开始。

[面板写入面](../../implemented/feature/2026-09-11-marketplace-panel-write-controls.zh.md)当初刻意推迟了这件事。一次安装要解析来源、抓取、钉住一个 revision 并回报该 pin，而那条 note 把這记为「单一请求与回应显然承载不了的进度与部分失败叙事」。

读路径本身也带着一个缺陷，面板若沿用只会继承它、不会引入它。`dsh plugin marketplace search` 逐個 await 每个已注册的 marketplace，而第一个失败的抓取会中止整条命令。一个有两个注册、其中一个不可达的部署，连那个能应答的注册也拿不到任何结果。

## 提案

在 marketplace 的 Remote 面新增一个 `catalog` 读与一个 `install` 写，新增一个 CLI 与 gateway 共同调用的 `catalog()` 操作，并在设置分页新增一个延迟载入的「可安装插件」区段。

安装维持单次请求、单次回应。`installPlugin` 本来就是一次 await 走完解析、抓取、钉住、落地与对账；它没有阶段可报，而为进度显示发明阶段，意味着要为了一个进度条去重构这个仓库里唯一被验证过的安装路径。

### catalog 操作

`src/catalog.ts` 拥有一个操作：

```ts
catalog(state: MarketplaceState, options: { fetch?: FetchOptions }): Promise<CatalogResult>
```

`CatalogResult` 是 `{ rows: CatalogRow[]; failed: MarketplaceFailure[] }`。`CatalogRow` 携带一列渲染所需的全部内容，可安装性由 Host 判定：

| 栏位 | 来源 |
|---|---|
| `plugin`、`description`、`category`、`version`、`tags` | 解析后的 `MarketplaceEntry` |
| `marketplace` | 该条目由哪个注册提供 |
| `installable` | `isPinned(entry)` |
| `warnings` | 条目自身的警告，包含缺 pin 那条 |
| `installed` | `findInstalled(state, rowIdFor(plugin))` |

一个读不动的 marketplace 变成一条携带其名称与原因的 `MarketplaceFailure`，而不会中止整个操作，因此一个不可达的注册无法让另一个可达的注册所提供的清单变成空白。

CLI 的 `search` 改写为盖在这个操作之上，而不是保留成第二份实作，CLI 因此获得同样的收容能力。

该操作刻意不吸收 `resolveEntry`。`resolveEntry` 解析一个名称，并在第一个列出它的 marketplace 就停下；`catalog` 必须走完每一个注册才能产出一份完整清单。合并两者会让每次安装都去抓取每一个已注册的 marketplace——那是为了在读路径省下一个循环，而在写路径付出代价。

### Remote 面

两个方法加入 `status`、`setEnabled` 与 `uninstall`：

```ts
@Remote('catalog')  catalog(): Promise<MarketplaceCatalogView>
@Remote('install')  install(request: PluginInstallRequest): Promise<PluginInstallResultView>
```

`catalog` 是读，对只读部署也提供服务；浏览不是变更。它不快取，与本模块既有的宣示一致——每次调用重新读取就不可能过期——面板持有自己的快照，因此一次分页互动只付一次读取。它会做 `status` 不做的网络 I/O，而这个差异正是面板按需载入、而非挂载即载入的原因。

`install` 先调用 `requireMutations()`，再调用 `installPlugin`——即 CLI 使用的同一个入口。它除了回报安装产出了什么，还回报产生的 `MarketplaceStatusView`，因此面板直接渲染安装后的事实，而不必再发一次可能与刚完成的写入赛跑的往返。

三个失败码加入 `RemoteErrorDetailsMap`：

| 代码 | 条件 |
|---|---|
| `marketplace/not-found` | 没有任何已注册的 marketplace 列出该名称 |
| `marketplace/unpinned` | 来源没有 `sha`，且请求未设 `allowUnpinned` |
| `marketplace/install-failed` | 其他抓取或文件系统故障，携带其原因 |

要区分这三者，需要的是结构性事实而不是消息比对，因此 `InstallError` 新增一个可选的 `reason` 栏位，取值为一个封闭集合，在各拒绝点设置。CLI 照旧打印 `error.message`；gateway 把 `reason` 映射成代码。比对消息文本会让一个稳定的 wire 代码取决于英文措辞。

wire 新增项住在 `./types`，它仍是该约定的唯一归属：

| 类型 | 栏位 |
|---|---|
| `MarketplaceCatalogView` | `rows: CatalogRowView[]`、`failed: MarketplaceFailureView[]` |
| `CatalogRowView` | `plugin`、`marketplace`、可选 `description`／`category`／`version`、`tags`、`installable`、`installed`、`warnings` |
| `MarketplaceFailureView` | `marketplace`、`reason` |
| `PluginInstallRequest` | `plugin`、可选 `allowUnpinned` |
| `PluginInstallResultView` | `plugin`、可选 `sha`、`warnings`、`status` |

在没有注册任何 marketplace 的部署上，`catalog` 解析为空 `rows` 与空 `failed`，而不是拒绝。空注册是面板已经能渲染的状态，而 CLI 的 `search` 对自己那种情况保留它原本的拒绝。

### 面板区段

第三个区段位于既有分页内、已安装清单的下方。

**它按需载入。** 该区段开启时只有一颗读取 catalog 的控件；搜索框、结果列与重新整理控件在它应答之后才出现。这正是把这次读取与 `status` 分开的全部理由：今天这个分页只读本机文件，不会因网络故障而空白。挂载即载入 catalog 会让开启设置页等待一次 `git` 抓取，而一个处在拦截式代理后的部署会看到空白面板，而它现在看到的是正确的。catalog 的失败被收容在这个区段内；已注册与已安装两个区段照常渲染。

**过滤发生在浏览器。** 面板持有回传的列并在本地过滤，与 skill 菜单快取 `skills/list` 后过滤已定快照、以及命令目录从其快取作答的做法一致。空查询列出全部，这与 CLI 上空查询的既有行为相同。

**每一列**显示插件名称、已安装标记、描述，以及 category 与 version 标签。不可安装的条目显示一个警告标签与它自己的警告文本。

**未钉 sha 的条目经由明确勾选来安装。** 在这类列上按下安装会开启 `RiskConfirmation` primitive，以该条目的警告作为说明，并有一个使用者必须勾选后确认控件才可用的核取方块。这就是 CLI `--allow-unpinned` 的面板形式，也是让先前那个决定——允许这些条目，但明确标示——变得可见而非隐藏的东西：标示就是那条警告，许可就是那个勾选。同一颗 primitive 已经用于守护卸载。

**只读部署不绘制安装控件**，与开关及卸载控件一致，而 Host 仍然拒绝该调用。

**安装之后面板渲染回传的 status。** 已安装清单多出它那一列，catalog 中该列变为已安装，而这次安装的警告显示在该列上。

## 考虑过的替代方案

**在 Host 端以 `search(query)` 方法做过滤。** 否决：它把一次网络往返放在每一次按键之后。CLI 付得起每次调用重新抓取，因为一次调用就是一条命令；搜索框不是。为弥补而在 Host 端快取 catalog，会引入本模块目前没有的失效问题。

**同时提供 `catalog()` 与 `search()`。** 以 YAGNI 否决。服务器端过滤会重复一个浏览器本就能在已持有的列上求值的判定，两者还可能互相分歧，同时多出一个要维护的介面成员。

**把安装阶段以转发事件串流。** 否决：`installPlugin` 今天没有阶段可报，因此这要先给它阶段回呼，并重构 CLI 唯一被验证过的安装路径。面板需要知道的是安装正在进行、以及它如何结束，而单次请求与回应两者都给了。

**在分页开启时载入 catalog。** 否决：它让一个原本纯本机的面板依赖一次网络抓取，并把慢速或遭拦截的连线变成空白的设置页。

**把 `catalog` 并入 `resolveEntry`。** 否决：两者有相反的遍历规则，合并后的版本会在每次安装时付出 catalog 的完整遍历。

**以比对消息来映射未钉 sha 的拒绝。** 否决：它让一个对 wire 可见的代码取决于没有任何测试会想到去保护的英文措辞。

**面板层级的「允许未钉 sha」开关。** 否决：它把逐次安装的决定变成常设权限，于是一次勾选会默默覆盖之后每一次未钉 sha 的安装。

## 验收标准

- `dsh plugin marketplace search` 保持现有输出，并获得收容能力：一个读不动的注册不再压制其余注册的结果。
- `marketplace.catalog` 为每个已注册 marketplace 的每个条目回传一列，`installable` 恰在来源为未钉 sha 的 git 来源时为 false，`installed` 恰在有已安装记录时为 true。
- 在只读部署上调用 `marketplace.install` 被以 `marketplace/read-only` 拒绝；`marketplace.catalog` 仍然应答。
- 对未列出的名称调用 `marketplace.install` 被以 `marketplace/not-found` 拒绝。
- 对未钉 sha 的条目在不带 `allowUnpinned` 时调用 `marketplace.install` 被以 `marketplace/unpinned` 拒绝；同一调用带 `allowUnpinned: true` 会安装它，并记录该 ref 解析到的 commit。
- 一次成功的安装回传产生的 status，而该 status 将该插件列为已安装。
- 面板的可安装插件区段在被请求之前保持未载入，其读取失败期间不渲染任何列，并让已注册与已安装两个区段照常渲染。
- 未钉 sha 列的安装控件，在其勾选方块被设置之前不会变为可用。

## 风险

- **过滤判定存在于两处。** CLI 在 Host 端过滤、面板在浏览器过滤，因为它们是不同的程序；该套件没有浏览器安全的运行时模块可供共享一个纯函数——按规则 `./types` 只放类型，而 `./gateway` 是 Node 专用。该判定维持为对同样四个栏位的一次子字串测试，双方以同一组案例钉住，因此分歧会是测试失败而不是无声的差异。
- **一个会做网络 I/O 的读。** `catalog` 是这个 Remote 面上第一个可能变慢、或因机器之外的原因而失败的方法。正是为此它才与 `status` 分开并按需载入，但这确实意味着面板的词汇里多了一个与使用者插件无关的失败。
- **catalog 是一份快照。** marketplace 可能在读取与点击之间改变。安装会在安装时从注册重新解析该条目，因此记录的 pin 是当下的、而不是面板显示的；一个在两次读取之间消失的名称会以 `marketplace/not-found` 失败，而不是安装了别的东西。
- **未钉 sha 的安装会记录一个使用者没看过的 commit。** 该选项在安装时解析 ref 并记录那个 commit。这是 CLI 已经在做的事，且严格多于一次无声的 HEAD 安装，但被记录的 revision 是由远端在安装当下选定的。
- **浏览不受 `allowMutations` 管辖。** 只读部署仍会执行 catalog 的网络抓取。这是有意的，因为浏览不是变更，但这意味着只读姿态并不会让面板在网络层面静默。
