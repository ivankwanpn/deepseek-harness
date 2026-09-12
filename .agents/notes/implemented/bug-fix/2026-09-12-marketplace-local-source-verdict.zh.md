# Agent Note: 目录的安装性判定与安装器的拒绝读取同一个来源

Status: implemented

[English](2026-09-12-marketplace-local-source-verdict.md) | 中文

## 问题

marketplace 条目可以把它的内容声明为相对于 marketplace 仓库的路径：`"source": "./plugins/code-review"`。官方 registry 的 294 个条目中有 52 个用这种写法。

`parseSource` 把相对路径读成 `local` 来源，而 `isPinned` 接受 `local` 来源，前提是内容已经在磁盘上、没有什么需要解析。安装并不这么看：该路径指的是 marketplace 仓库内部的内容，因此 `installPlugin` 会把它重新表达成该仓库的一个 git 子目录，而这样的来源不带 `sha`。

目录依据条目自身的 `local` 形态判定 `installable`，因此把每个相对条目都判为可安装。面板对可安装的一行只发一次调用，且 `allowUnpinned: false`，于是确认框根本不出现，Host 随后以 `unpinned` 拒绝该请求。确认框是面板唯一会送出 `allowUnpinned: true` 的路径，而它只在目录拒绝该行时打开——因此这些条目无论怎么点都无法从面板安装。CLI 不受影响：`--allow-unpinned` 是使用者直接传入的旗标，不需要先看判定。

## 决定

两个面都从 `src/fetch.ts` 的 `installSource(entry, marketplaceUrl)` 取来源。对任何不是相对路径的条目，它回传条目自身的来源；否则回传 `resolveLocalSource` 依据 `marketplaceRepoRoot(marketplaceUrl)` 推导出的 git 子目录。`installPlugin` 与 `catalog` 都调用它，因此 pin 规则作用于一个来源，而不是同一个来源的两种写法。

`installPlugin` 仍然自己计算 `marketplaceRepoRoot`，因为安装记录会存下那个根。把声明的路径变成来源的规则只住在 `installSource`。

## 考虑过的替代方案

**直接拒绝相对来源。** 否决：这是 registry 对「随 marketplace 仓库一起发布的插件」所用的写法，而 fetch 层本来就能正确读取它。为了回避判定不一致而拒绝，等于删掉一项可用的能力。

**在 `isPinned` 里把 `local` 来源当作已钉。** 否决：路径是否能解析取决于 marketplace 网址，而 `isPinned` 拿不到它，规则会需要一个它无法提供的参数。而且「`local` 来源已经在磁盘上」这个前提对这种写法本来就不成立。

**只在目录里把该行标成未钉，不动安装路径。** 否决：解析发生在安装里，拒绝也在安装里决定。再写一份目录本地的规则副本，正是要被移除的那个缺陷，而不是它的修复。

## 后果

- 相对条目会带未钉标记渲染，并经由确认框安装——那正是面板早已实作、却无法触达的 `--allow-unpinned` 的面板形态。
- `installable` 现在意味着「无需确认即可安装」，而不是「pin 规则接受 manifest 自己对来源的写法」。它仍是快照：marketplace 可能在读取与点击之间改变。
- `src/fetch.ts` 导出 `installSource`。解析只有一处归属，因此日后改动任一面都无法重新引入这项不一致。
- [marketplace 目录与安装那份笔记](../feature/2026-09-12-marketplace-catalog-and-install.zh.md)曾把这项不一致写成已交付的行为；它的 `installable` 栏、正文与验证清单现在陈述的是一致。
- 解析不出仓库的 local 来源在 pin 规则下仍可安装，而它依然抓不下来；[现在安装会复制它](2026-09-12-local-source-install-never-copied.zh.md)。

## 测试

`tests/catalog.spec.ts` 从一个 github 形态的网址提供 manifest，并断言 `./plugins/relative` 不可安装，而 `../outside`——解析不出仓库根、仍然是 local——可安装。还原成 `isPinned(entry)` 时，它会以 `[['relative', true]]` 失败，而判定必须是 false。`tests/install-unpinned.spec.ts` 为相对条目跑完整安装：没有选择加入时以 `unpinned` 拒绝；加入后对 marketplace 仓库解析 `HEAD`，并记录子目录、仓库根与 commit。当 `installSource` 原样回传声明的来源时，它会以「本该拒绝却安装成功」失败——那正是让该条目看起来已钉的静默安装。
