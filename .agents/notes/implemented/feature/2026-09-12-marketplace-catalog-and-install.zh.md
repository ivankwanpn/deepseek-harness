# Agent Note: 插件市场面板可浏览并安装插件

Status: implemented

[English](2026-09-12-marketplace-catalog-and-install.md) | 中文

## 问题

插件市场面板管理的是**已经安装**的插件。它无法显示有哪些可用，也无法安装其中任何一个。刚注册完一个插件市场的使用者只看得到它的名字：该市场提供的条目只存在于终端里的 `dsh plugin marketplace search` 之后。于是每一个改变安装状态的决定，都从显示它的那个面板之外开始。

[面板写入面](2026-09-11-marketplace-panel-write-controls.zh.md)当初刻意推迟了这件事。一次安装要解析来源、抓取、钉住一个 revision 并回报该 pin，而那条 note 把这记为「单一请求与回应显然承载不了的进度与部分失败叙事」。

读路径本身也带着一个缺陷，面板若沿用它只会继承，不会引入。`dsh plugin marketplace search` 逐个 await 每个已注册的 marketplace，而第一个失败的抓取会中止整条命令。一个有两个注册、其中一个不可达的部署，连那个能应答的注册也拿不到任何结果。

## 决策

`marketplace.catalog` 与 `marketplace.install` 加入插件市场的 Remote 面，一个 `catalog()` 操作同时服务命令行的 `search` 与 gateway，设置分页新增一个按需读取、并从中安装的「可安装插件」区段。

安装维持单次请求、单次回应。`installPlugin` 就是一次 await 走完解析、抓取、钉住、落地与对账；它没有阶段可报，而为进度显示发明阶段，意味着要为了一个进度条去重构这个仓库里唯一被验证过的安装路径。

### catalog 操作

`src/catalog.ts` 拥有一个操作：

```text
catalog(state: MarketplaceState, options?: { fetch?: FetchOptions }): Promise<CatalogResult>
```

`CatalogResult` 是 `{ rows: CatalogRow[]; failed: MarketplaceFailure[] }`。`CatalogRow` 携带一列渲染所需的全部内容，可安装性由 Host 判定：

| 栏位 | 来源 |
|---|---|
| `plugin`、`description`、`category`、`version`、`tags` | 解析后的 `MarketplaceEntry` |
| `marketplace` | 提供该条目的 manifest 所声明的名称 |
| `installable` | `isPinned({ ...entry, source: installSource(entry, registration.url) })` |
| `warnings` | 条目自身的警告，包含缺 pin 那条 |
| `installed` | `findInstalled(state, rowIdFor(plugin))` |

`installable` 并不保证安装一定成功，因为 marketplace 可能在这次读取与点击之间改变。它把 pin 规则应用在安装会读取的那个来源上——`installSource`，也就是 `installPlugin` 同样执行的那次解析——因此这次读取拒绝的一列，恰好就是只有带上 `allowUnpinned` 才能安装的那一列。相对于 marketplace 的 `local` 条目正是让这项一致性变得吃重的情形：安装会把这样的路径读成 marketplace 仓库的一个 git 子目录，而它不带 `sha`。

一个读不动的 marketplace 变成一条携带其注册名与 fetch 层原因的 `MarketplaceFailure`，循环随即继续。它不会中止整个操作，因此一个不可达的注册无法让另一个可达的注册所提供的清单变成空白。

CLI 的 `search` 调用这个操作，而不是保留第二份实作，CLI 因此获得同样的收容能力。它的输出不变——每个匹配项一行裸插件名、描述缩进在其下方、有安装记录的名称旁标 `[installed]`，没有匹配时输出 `no plugin matched "<query>"`——而每条读不动的注册会在匹配结果之前打印到 stderr，因此沉默永远不会被读成「这个 marketplace 什么都没列」。

`marketplace.catalog` 用存储的注册调用同一个操作，且不传 fetch 覆写，因此每次 manifest 读取都使用 fetch 层自己的预算；Remote 调用也不传递任何取消信号。它是这个面上唯一会触达网络的读取，因此面板按需索取，而不是在分页打开时载入。

该操作刻意不吸收 `resolveEntry`。`resolveEntry` 解析一个名称，并在第一个列出它的 marketplace 就停下；`catalog` 必须走完每一个注册才能产出一份完整清单。合并两者会让每次安装都去抓取每一个已注册的 marketplace——那是为了在读路径省下一个循环，而在写路径付出代价。

### Remote 面

`marketplace.catalog` 是读，对只读部署也提供服务；浏览不是变更。它不快取，与本模块「每次调用重新读取就不可能过期」的宣示一致——面板持有自己的快照，因此一次分页互动只付一次读取。

`marketplace.install` 先调用 `requireMutations()`，再校验插件名，然后调用 `installPlugin`——即 CLI 使用的同一个入口——并且只在请求设置时传 `allowUnpinned`。它回报插件、记录的 commit、这次安装的警告，以及这次安装产生的那份状态，因此面板直接渲染安装后的事实，而不必再发一次可能与刚完成的写入赛跑的往返。

三个失败码加入 `RemoteErrorDetailsMap`：

| 代码 | 条件 |
|---|---|
| `marketplace/not-found` | 没有任何已注册的 marketplace 列出该名称，或根本没有注册 |
| `marketplace/unpinned` | 来源没有 `sha`，且请求未设 `allowUnpinned` |
| `marketplace/install-failed` | 其他抓取或文件系统故障，携带其原因 |

要区分这三者，需要的是结构性事实而不是消息比对，因此 `InstallError` 携带来自封闭集合 `InstallRefusal` 的必备 `reason`——`name-unusable`、`no-marketplace`、`not-found`、`unpinned`——在各拒绝点设置。gateway 经 `INSTALL_REFUSAL_CODE` 映射它：不可用的名称是 `gateway/bad-request`，因为请求本身格式错误，而 `no-marketplace` 与 `not-found` 共用 `marketplace/not-found`。`install-failed` 根本不是拒绝，而是准入之后其他一切抛出的兜底。CLI 照旧打印 `error.message`，因此稳定的 wire 代码永远不取决于英文措辞。

wire 新增项住在 `./types`，它仍是该约定的唯一归属；`gateway.ts` 只 import 它们、不再导出，因为它的模组图是 Node 专属的，再导出会把它拖进浏览器编译面。[`api-remotes`](../../../../packages/api/remotes/README.zh.md) 在它的浏览器面上转发同一批类型，面板正是从那里 import：

| 类型 | 栏位 |
|---|---|
| `MarketplaceCatalogView` | `rows: CatalogRowView[]`、`failed: MarketplaceFailureView[]` |
| `CatalogRowView` | `plugin`、`marketplace`、可选 `description`／`category`／`version`、`tags`、`installable`、`installed`、`warnings` |
| `MarketplaceFailureView` | `marketplace`、`reason` |
| `PluginInstallRequest` | `plugin`、可选 `allowUnpinned` |
| `PluginInstallResultView` | `plugin`、可选 `sha`、`warnings`、`status` |

在没有注册任何 marketplace 的部署上，`catalog` 解析为空 `rows` 与空 `failed`，而不是拒绝。空注册是面板已经能渲染的状态，而 CLI 的 `search` 对自己那种情况保留它原本的拒绝。

### 面板区段

第三个区段位于既有分页内、已安装清单的下方，它按需载入：该区段以一颗读取 catalog 的控件开启，搜索框、结果列与重新整理控件在它应答之后才出现。这正是把这次读取与 `status` 分开的全部理由——这个分页的其他读取都是本机的，挂载即载入 catalog 会让开启设置页等待一次 git 抓取。catalog 的失败被收容在这个区段内；已注册与已安装两个区段照常渲染，失败的重整保留已经渲染出来的列，而主机端读不动的每条注册都会连同原因被指名。

过滤发生在浏览器里，针对 Host 回传的列，因此一次按键不花任何代价。判定就是 CLI 的那一个：对插件名、描述、category 与 tags 做一次不区分大小写的子字串测试，过滤词两端空白被去除，空过滤词匹配全部。它之所以存在两份，是因为命令行与浏览器是不同的程序，而本包没有浏览器安全的运行时模组可供共享一个纯函数——按规则 `./types` 只放类型，`./gateway` 是 Node 专用——因此双方钉住同一组案例。

每一列显示插件名、已安装标记、描述、该条目自带的警告，以及在来源不可安装时的警告标签。未钉住的条目只能经由明确的勾选来安装：在这类列上按下安装会开启 `RiskConfirmation` primitive，其说明写明插件市场没有为该插件宣告 commit，而其确认控件要等勾选方块被设置后才可用。这就是 CLI `--allow-unpinned` 的面板形式；这次勾选是逐次安装的，而不是常设权限。

只读部署不绘制安装控件，与开关及卸载控件一致，而 Host 仍然拒绝该调用。安装之后面板渲染回传的 status 并重新读取 catalog，因此已安装清单多出它那一列，catalog 中该列显示的是 Host 自己的看法而不是面板的猜测。安装自身的警告会随 wire 回传，而面板一条都不渲染；该列显示的是那次重新读取带回的、条目自己的警告。被拒绝的安装显示在它被拒绝的那一列上。

## 考虑过的替代方案

**在 Host 端以 `search(query)` 方法做过滤。** 否决：它把一次网络往返放在每一次按键之后。CLI 付得起每次调用重新抓取，因为一次调用就是一条命令；搜索框不是。为弥补而在 Host 端快取 catalog，会引入本模块目前没有的失效问题。

**同时提供 `catalog()` 与 `search()`。** 以 YAGNI 否决。服务器端过滤会重复一个浏览器本就能在已持有的列上求值的判定，两者还可能互相分歧，同时多出一个要维护的介面成员。

**把安装阶段以转发事件串流。** 否决：`installPlugin` 没有阶段可报，因此这要先给它阶段回呼，并重构 CLI 唯一被验证过的安装路径。面板需要知道的是安装正在进行、以及它如何结束，而单次请求与回应两者都给了。

**在分页开启时载入 catalog。** 否决：它让一个原本纯本机的面板依赖一次网络抓取，并把慢速或遭拦截的连线变成空白的设置页。

**把 `catalog` 并入 `resolveEntry`。** 否决：两者有相反的遍历规则，合并后的版本会在每次安装时付出 catalog 的完整遍历。

**以比对消息来映射未钉住的拒绝。** 否决：它让一个对 wire 可见的代码取决于没有任何测试会想到去保护的英文措辞。

**面板层级的「允许未钉住」开关。** 否决：它把逐次安装的决定变成常设权限，于是一次勾选会默默覆盖之后每一次未钉住的安装。

## 后果

- 浏览与安装发生在显示这次安装的那个面板里：它列出已注册的插件市场提供的内容并从中安装，而命令行保留这两条命令。
- `dsh plugin marketplace search` 保持现有输出并获得收容能力：读不动的注册会报告到 stderr，可读的那些所提供的匹配结果照旧打印。
- `marketplace.catalog` 为每个已注册 marketplace 的每个条目回传一列，`installable` 恰在安装会读取的来源不带 `sha` 时为 false，`installed` 恰在有安装记录时为 true。
- 在只读部署上调用 `marketplace.install` 被以 `marketplace/read-only` 拒绝，而 `marketplace.catalog` 仍然应答；未列出的名称是 `marketplace/not-found`，未钉住且不带 `allowUnpinned` 的条目是 `marketplace/unpinned`。
- 带 `allowUnpinned: true` 时，同一调用会安装该条目，并记录该 ref 在那一刻指名的 commit，因此这次安装是一个具体的 revision，而不是一个会移动的 ref。
- 一次成功的安装回传它产生的 status，而该 status 将该插件列为已安装。
- 未钉住列的安装控件与其他列一样被绘制且可用，按下它开启勾选确认框而不是直接安装；核取方块把关的是那个确认框的确认。
- `InstallError.reason` 是封闭联合的必备栏位，因此新的拒绝必须自报身份并被映射成 wire 代码，而不是落到消息比对。
- 过滤判定存在于两处。CLI 在 Host 端过滤、面板在浏览器过滤，因为它们是不同的程序，而本包没有浏览器安全的运行时模组可供共享一个纯函数。双方以同一组案例钉住，因此分歧会是测试失败而不是无声的差异。
- `catalog` 是这个 Remote 面上第一个可能变慢、或因机器之外的原因而失败的读取，正是为此它才与 `status` 分开并按需读取。因此即使使用者的插件毫无问题，catalog 的失败也会抵达面板。
- catalog 是一份快照，因此 marketplace 可能在读取与点击之间改变。安装会在安装时从注册重新解析该条目，这让记录的 pin 是当下的、而不是面板显示的；一个在两次读取之间消失的名称会以 `marketplace/not-found` 失败，而不是安装了别的东西。
- 未钉住的安装会记录一个使用者没看过的 commit。该选项在安装时解析 ref 并记录那个 commit，这是 CLI 已经在做的事，但被记录的 revision 是由远端在安装当下选定的。
- 浏览不受 `allowMutations` 管辖：只读部署仍会执行 catalog 的网络抓取。浏览不是变更，因此只读姿态并不会让面板在网络层面静默。
- 本包满足了 [packages/AGENTS.md](../../../../packages/AGENTS.md) 对产品可见插件所要求的 REAL-composition 测试，而在此次工作之前它一直未满足该要求。

## 测试

`tests/catalog.spec.ts` 覆盖这次读取：每个条目一列、可安装性与已安装标记由 Host 判定、读不动的注册被收容（排序让不可达的那个先被走访）、跨 marketplace 的注册顺序，以及空注册。`tests/search-command.spec.ts` 直接驱动该 CLI 命令，并钉住收容的两半——可读注册的匹配结果在 stdout、失败注册的原因在 stderr——连同输出格式、`[installed]` 标记与无匹配行。`tests/gateway.spec.ts` 钉住公布的五个方法、安装失败码、只读拒绝、只读部署上 catalog 仍然应答、成功安装同时回传它记录的内容与那份状态，以及 pin opt-in 的两臂：同一个未钉住的请求不带 `allowUnpinned` 时被拒绝，带上时安装解析器指名的那一个 commit。`tests/install-reasons.spec.ts` 断言四种拒绝的 `reason` 栏位而不是它们的消息，因此改写消息无法改变 wire 代码。`tests/install-unpinned.spec.ts` 在安装层驱动「先解析、再钉住」这条路径：只对 `resolveRefSha` 与 `fetchPlugin` 打桩，并断言条目声明的 ref 正是被解析的那一个、回传的 commit 正是安装写进 state 的那一个，而预设那一臂在询问任何远端之前就拒绝。仍未覆盖的是 `resolveRefSha` 自身的 `git ls-remote` 调用与 HEAD→`main`→`master` 回退，它们需要真实远端。

`tests/loader-composition.spec.ts` 就是 [packages/AGENTS.md](../../../../packages/AGENTS.md) 对产品可见插件所要求的 REAL-composition 测试。它写出一份只用于测试的 `cordis.yml`，其中带有 marketplace 行，经 vendored Loader 启动它，并针对 Loader 实际组合出的服务断言：`marketplace` 命名空间、五个方法、该行组态的 state path 就是读取实际使用的那个路径，以及 `allowMutations: false` 的行会拒绝 `install` 而 `catalog` 仍然应答。manifest 抓取是唯一被打桩的外部服务；Loader 经自己的模组接缝解析该行，因此组态是经 Loader 抵达服务的，而不是经由一个手搭的 context。

`tests/components.client.spec.tsx` 以夹具驱动面板：区段在被请求之前保持未载入、过滤的四个栏位及其空白案例、钉住的条目一次调用即完成安装、未钉住的条目只在勾选被设置之后才抵达 Host、拒绝落在它自己那一列上，以及只读部署不绘制安装控件。`tests/browser-plugin.client.spec.tsx` 覆盖注册入口的五个 Remote 包装器以及它们透传的拒绝。
