# Agent Note: A skill catalog change reaches the browser without a reload

Status: implemented

[English](2026-09-11-skill-invalidation-reaches-the-browser.md) | 中文

## 问题

`/` 菜单的浏览器半边按会话缓存 `skills/list`。而本应丢弃这些缓存的 skill 注册表失效通知从未离开 Host。`skills/change` 声明并派发于 `packages/skill/skill/src/index.ts`，即该套件的 Host 入口，而该套件没有发布任何 Client 安全类型面——因此 `packages/api/remotes` 根本读不到这条声明。把该名称加入宿主事件转发白名单会触发其 `satisfies readonly TypertForwardableEventEntry[]` 断言失败，因为编译面看不见的事件就不是可转发事件。

用户可见的结果是：在 marketplace 面板里停用一个插件会停放它的 skill 条目，Host 目录立即丢弃它们，而 `/` 菜单在页面刷新之前仍然把每一条都列出来。模型与菜单对「这个部署有哪些 skill」给出了不同答案，而只有一方是对的。

## 决策

注册表那条不带过滤条件的失效通知被转发到浏览器，客户端把它当作一次全缓存丢弃。

**由 owner 套件提供声明。** `packages/skill/skill/src/types.ts` 是新的 Client 安全面，以 `./types` 导出，承载 `skills/change` 的 `Events` 声明。`src/index.ts` 用 `export type *` 转出该面，这才是把这条增强带进该套件产物 `index.d.ts` 的动作。`import type {} from './types.ts'` 这种仅取类型的写法在源程序内读得到，却会在声明产物中被消除，于是所有经项目引用解析该套件的消费方——包括该套件自己的测试在仓库级 Host aggregate 中——都不再看见该事件。这正是 `@deepseek-ai/dsh-commands`、`@deepseek-ai/dsh-settings` 与 `@deepseek-ai/dsh-agent-presets` 已采用的安排，也是白名单自身的约定所要求的：每个条目的声明住在它 owner 套件的 Client 安全 `./types` 导出中，从而 `packages/api/remotes` 的两个编译面读到同一份声明，而不是一份复述。

**转发是对载体能力的如实声明，而非逐个功能的取舍。** 该事件无作用域且返回 `void`，恰是 `emit` 转发所能保持的形态；`{ event: 'skills/change', mode: 'emit' }` 因此加入白名单。

**客户端清除每一个已缓存会话。** 该事件按设计不携带负载——失效通知不带过滤条件，因为提供方注册、释放、marketplace 启用或停用、以及文件系统监听都会触及它。落地后的 skill 条目的归属不是插件名称的函数（重名冲突按状态顺序裁定），因此受影响会话的集合在客户端无法计算。于是 `ui-skill` 在 `skills/change` 上清空全部键，在 `agent-preset/selected` 上仍只丢弃一个键，在 `connection/reset` 上仍清空全部。

## 考虑过的替代方案

**在 `packages/api/remotes` 内、白名单旁边再声明一次 `skills/change`。** 否决：白名单刻意针对 owner 的声明做断言，好让签名变更打断转发方套件的构建。本地副本能在满足断言的同时，让 Host 的真实签名与转发出去的签名悄悄分叉。

**转发一个 marketplace 专属信号，而不是注册表事件。** 否决：面板只是若干生产者之一。marketplace 信号会让文件系统监听与运行时提供方变动仍然需要刷新，而客户端会在注册表已有一条失效路径的情况下需要两条。

**复用已转发的 `commands/change`。** 否决：skill 不是命令。`dsh-tool-skill` 不会向命令注册表注册任何东西，因此 skill 目录可以在命令目录毫无变化时改变——此前「一条覆盖另一条」的假设正是留下这个缺口的原因。

**只清除面板可能影响到的那些会话。** 否决：面板知道的是插件，而不是会话；并且共享的发现根目录意味着一个插件的条目可能按名称与另一个冲突。

## 后果

- `skills/change` 走上 Remote 事件流；生成的 event matrix 把 `packages/skill/skill/src/types.ts` 记为其归属，并把 `remotes` 记为其监听方。
- `@deepseek-ai/dsh-skill` 获得公开的 `./types` 子路径导出；`packages/api/remotes` 与 `packages/client/ui-skill` 获得它作为开发依赖，`tsconfig.base.json` 获得其源码别名。
- `/` 菜单现在即时反映启用状态：一次面板开关或一次监听驱动的变更，代价是下一次打开菜单时每个会话一次 `skills/list`，无需刷新。
- 进行中的目录拉取会被该失效通知中止。该路径此前已为 preset 切换存在；现在它对每一次目录变更都生效。

## 测试

`packages/api/remotes/tests/remote-events.host.spec.ts` 断言客户端流收到的帧，包括不带负载的 `skills/change`，因此白名单条目由实际跨线的内容钉住，而不是只由常量钉住。`packages/client/ui-skill/tests/browser-plugin.client.spec.ts` 断言缓存效果：一次转发的 `skills/change` 让两个已缓存会话各付一次重新拉取，而 `agent-preset/selected` 只让被重组的那个会话付费。客户端断言已确认在移除该监听器后失败。

声明的可达范围只有仓库级 aggregate 才能证明。用那条被消除的仅类型 import 时，逐包 `tsc -b` 依然通过，因为该程序直接读源文件；`tsc -b tsconfig.host.json` 编译的是经声明产物解析该套件的消费方，正是它抓到了这个问题。
