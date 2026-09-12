# Agent Note: local 来源会被复制进它的安装，而不是就地引用

Status: implemented

[English](2026-09-12-local-source-install-never-copied.md) | 中文

## 问题

`fetchPlugin` 把 `local` 来源记成「used in place rather than copied」，并原样回传 manifest 所指名的路径，完全不碰 `destination`。而 `installPlugin` 是先抓进一个同级的暂存目录、再把它 rename 到安装路径上，所以那次 rename 什么也找不到：安装任何来源是一个目录的条目——绝对路径，或是一个其 marketplace 网址解析不出仓库根的相对路径——都会以原始 `ENOENT` 死掉，而且错误里点名的是内部暂存路径。`installPlugin` 在重新检测能力处自己的注释（「capabilities are read from disk, and a local source would otherwise record the pre-move path」）说明这次暂存搬移本来就预期会承载 local 来源；没写完的是抓取那一支。

「就地读取目录」在设计上也不安全。`uninstallPlugin` 会递归删除 `installPath`，所以把使用者自己的目录记在那里，等于会把它删掉——而那正是 manifest 仅仅「指向」的目录。

[判定那份笔记](2026-09-12-marketplace-local-source-verdict.zh.md)让目录与安装器对 marketplace 相对来源达成一致。这里是它留下的残余：解析不出仓库的 local 来源在 pin 规则下仍可安装，而它在下一步就崩了。

## 决定

`fetchPlugin` 现在像处理 git 来源一样，把 local 来源复制进 `destination`，两个分支共用同一个 `placeContent(from, destination)`。这次复制会跳过 `.git`，因此落到 plugins 根目录下的是插件内容，而不是一个带着远端网址与对象库的嵌套仓库。

下游一切不变。安装路径仍位于 plugins 根目录之内，记录仍以 manifest 所指名的路径作为 `sourceUrl`、不带 `sha`，卸载也只删除这次安装自己放进去的东西。

## 考虑过的替代方案

**把来源路径直接记为安装路径，跳过搬移。** 否决：`uninstallPlugin` 会删除 `installPath`，这么做等于删掉使用者自己的目录。没有任何措辞能让它变安全。

**改为拒绝 local 来源。** 否决：manifest 格式本身就表达这种来源，fetch 层也已经校验它，而面板会摆出一行永远装不了的条目——正是判定那次修正为相对条目移除掉的死路。

**连 `.git` 一起复制。** 否决：git 分支上的注释早已宣称「已安装的插件是数据，不是嵌套仓库」，而对整仓库来源来说那是假的。现在两个分支共用同一条排除规则，这句话才成立。

## 后果

- 来源是一个目录的条目现在能安装、能出现在面板里、也能卸载，与其他每一条一样。
- 对该目录的后续改动不会到达已安装的副本；重新安装才会把它们带进来。包的 README 已把这一点记在限制里。
- 整仓库的 git 来源不再把它的 `.git` 目录装进去。先前的注释这么宣称，而程式码没有做。

## 测试

`tests/install-paths.spec.ts` 透过真实 fetcher（该 spec 里唯一没被 stub 的一步）安装一个真实目录，并断言内容位于 plugins 根目录之下、来源目录仍然存在、卸载删掉副本而留下来源。`tests/git.spec.ts` 直接钉住这次复制与 `.git` 排除。三者在先前的就地回传上都失败，其中安装那个案例报的正是原始的 `ENOENT`。
