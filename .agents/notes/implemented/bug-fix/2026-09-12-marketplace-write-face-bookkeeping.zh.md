# Agent Note: 写入面的记帐现在能挺过「移除它所描述之物」的那个操作

Status: implemented

[English](2026-09-12-marketplace-write-face-bookkeeping.md) | 中文

## 问题

四个缺陷，每一个都在修正之前对已交付的程式码量测过。它们形状相同：较早某一步记录下来的东西，不再与较晚某一步能看到的东西相符。

**一行活得比它的插件久。** `composePatchLayer` 从**想要的**列推导拥有关系，因此市集为某个后来被卸载的插件插入的那一行不在其中任何一列里，于是被保留下来。`uninstallPlugin` 移除了记录与内容，而 loader 继续挂载一个插件已经不存在的 `mcp-client`。该函数的档头声称它会丢弃「our own previously-inserted rows」，而本该做这件事的位置上放着一个什么都不做的回圈。

**改名被记在旧名之下。** `resolveEntry` 会跟随市集发布的 `renames` 表并回报 `renamedFrom`，但 `installPlugin` 随后用呼叫者输入的名字写入记录——记录的 `plugin`、它的 `id`、内容目录，以及通知里讲了两次（`"previous was renamed to previous"`）。目录是以 manifest 所列之名标记条目已安装的，所以一次改名后的安装会显示为未安装，而再安装一次就会产生重复。

**某个能力永远对不上。** 安装用来记录能力的 `detectCapabilities` 是在载体文件存在时报告该能力。sync 执行的比对却自己拼了一份清单，并且只在至少有一个 server 可用时才计入 `mcp`，于是一个没有声明任何可挂载项的 `.mcp.json` 会每次 sync 都永远报告「capabilities changed on disk since install (recorded mcp, found none)」。同一类问题先前已经为 `commands/` 修过一次，办法是再手写一条子句。

**`add` 让失败逃逸了。** 其他每一条写入路径都会把失败的子行程报告成诊断并结束于 1；`marketplace add` 在任何 `try` 之外 await 它的抓取，于是打错的 registry 会以未处理的 rejection 抵达 `bin.ts` 的 `process.exit(await …)`，而不是一行讯息。它自己的测试钉住的是那个 rejection，而不是需求本身。

## 决定

- **拥有关系是 id 命名空间，不是想要的集合。** `state.ts` 导出 `isManagedRowId`，而 `composePatchLayer` 会丢弃任何带着它、且当前不被想要的行——包括插件已经消失的那一行——同时一个挂在我们的 id 与 mount 之下的外来行仍然原封不动地存活。档头的拥有关系表现在把 EXISTENCE（状态档）与 ORIGIN（命名空间）分开，因为「记录已随插件消失的行」既不在想要的集合里，也没有状态记录可指。
- **一次安装由市集所列之名来识别。** `installPlugin` 从解析出的条目推导出单一的 `name`，并用它作为记录、row id、内容目录与每一条讯息；`renamedFrom` 只在通知里报告一次。
- **能力比对只读一个探针。** `materializeEntry` 呼叫 `detectCapabilities`——安装当初用来记录的那同一个函数——而不是手工拼出同样三个能力、却对其中一个用了不同的规则。已死的 `isDirectory` 辅助函数与那些手写子句都移除了。
- **每个面向使用者的指令都会报告它的失败。** `add` 把它的抓取与注册包起来，而两个 catch 共用一个 `failureText` 辅助函数，于是「把 `unknown` 的抛出物转成字串」这件事只存在一份。

## 考虑过的替代方案

**把想要的 id 记进状态，好让 sync 能认出过期行。** 否决：被卸载插件的 id 正是 `removeInstalled` 丢掉的东西，所以呼叫端必须把它们穿过 `SyncOptions` 传进来、而且还得记得这么做——而命名空间本来就能只凭那一层回答这个问题。

**在记录里保留旧名，并让目录同时匹配两个名字。** 否决：同一个已安装插件有两个名字，正是这个缺陷制造出来的状态。manifest 的名字才是其他每个面已经用来作键的东西。

**让 `marketplace-command` 的两个 catch 维持原样。** 否决：第二个 catch 让 `String(error)` 那一臂成了未覆盖分支。改读同一个辅助函数，既移除了重复的运算式，也让那一臂由既有的非-Error 测试覆盖。

## 后果

- 卸载插件会移除它的 loader 行，因此部署不再为已经不存在的内容挂载 client。
- 跟随改名的那次安装，在每一个面上都以市集之名可寻址：目录标记、面板、启用与卸载。以已弃用的旧名卸载会报告它未安装——README 把这一点记作限制——而跟随改名时 `install` 会报告这次改名。
- 一个没有声明任何可挂载项的 `.mcp.json` 不再每次 sync 都宣告能力变更。它仍会报告那个不可用的 server，那是另一条准确的警告。
- `marketplace add` 对抓取不到的 registry 会印出 `dsh: <原因>` 并结束于 1。
- 除了 `rowIdFor`，`isManagedRowId` 与 `mcpRowId` 加入本包的 row-id 词汇；`materialize` 与 `gateway` 透过同一个函数构造 MCP row id，而不再自己拼那个前缀。

## 测试

每一个修正都在做之前先复现。`install-paths.spec.ts` 透过真实的 reconcile 安装一个带 MCP 的插件、断言那一行存在、卸载、再断言它消失——那个案例在已交付的程式码上以 `expected true to be false` 失败。改名那个案例在还原后的 install 上以 `expected [ 'previous was renamed to previous' ] to include 'previous was renamed to renamed'` 失败。`materialize.spec.ts` 以那条多余的能力警告失败。`command-surface.spec.ts` 以逃逸的 `MarketplaceFetchError` 失败。本包在 statements、branches、functions 与 lines 上维持逐档 100%。
