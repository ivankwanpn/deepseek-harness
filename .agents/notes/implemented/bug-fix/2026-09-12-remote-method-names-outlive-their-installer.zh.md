# Agent Note: A namespace service's own names no longer reserve Remote method names

Status: implemented

[English](2026-09-12-remote-method-names-outlive-their-installer.md) | 中文

## 问题

Client Remote 服务把每个已挂载的方法发布成 namespace service 对象上的一个 accessor，而同一个对象又承载了安装这些方法的机制——包含一个 private 的 `install()`。于是发布一个名为 `install` 的方法会撞上冲突守卫：`'install' in this` 为真，因为该服务自己就有 `install`，因此这次挂载被拒绝，该 namespace 从未出现。

由于 `@deepseek-ai/dsh-api-remotes` 把每一个被选中的贡献作为**一个整体装配**挂载，这一处拒绝就让整个浏览器启动失败。面板渲染出 `Failed to load plugins`，没有任何设置页能载入；失败的条目是那个装配，而不是 marketplace 这个 namespace。

被保留的名称集合是**看不见的**。它由安装类恰巧由什么构成决定——`install`、`installDirect`、`installScoped`、`remove`、`has`、`empty`——所以一个方法名可能因为作者在任何类型里都看不到的理由被拒绝，而那条拒绝信息指出的冲突，调用方除了改名之外无从规避。

## 决策

方法记录搬进一个由 namespace service 持有的 `RemoteMethodTable`。该服务对外发布的表面现在只有 `methods`、`invokeRemote`、`installDirect`、`installScoped`；它保留的名称就是这四个，加上 `REMOTE_NAMESPACE_FIELDS` 与它自己的类原型。

`install`、`remove`、`has`——安装机制自己的旧名——变为可发布。一个 namespace 现在可以挂载以其中任何一个命名的方法，而当它的最后一个变体被释放时，该 accessor 会再次被撤销。

该 table 持有记录与 accessor，并**延迟读取**服务，因为服务在自身构造完成之前就把 table 交了出去。`RemoteNamespaceService.assertMethodAvailable` 保持静态形式，并且仍是保留集合被陈述的唯一位置。

## 考虑过的替代方案

**把 marketplace 的方法改名成守卫能接受的名字。** 否决：这个 wire 名称是面板与 CLI 已经在讲的一份约定，而下一个要发布 `remove` 或 `has` 的套件会撞上同一面墙。缺陷在于保留集合是任意的；只改一个调用方，它依然任意。

**把安装机制的名字显式列入拒绝清单。** 否决：那是对着一个类的 private 成员维护的拒绝清单，某个辅助方法一改名或一新增它就过期——而且它会继续拒绝那些本来就只经由 table 到达的名字。

**把 accessor 定义在一个单独发布的物件上，而不是服务上。** 否决：accessor 要经由服务自己的 `ctx` 读取调用方 Context，而插件代码是向 Cordis 索取该 namespace service 来取得它们。挪走 accessor 会改变每一个消费方取得 Remote 方法的方式。

## 后果

- 一个 Remote 方法名不再取决于安装机制叫什么，两个方向都不再：机制的名字不保留已发布的名字，而已发布的名字也无法遮蔽机制。
- `RemoteNamespaceService` 对进程内读取方的表面变了：`has`、`remove`、`empty` 消失，改为 `methods.isMounted`、`methods.withdraw`、`methods.isEmpty`。所有消费方都在 `api/gateway` 之内。
- `methods`、`invokeRemote`、`installDirect`、`installScoped` 仍被保留，且现在由测试钉住，因此日后往该服务新增辅助方法是一次刻意的保留，而不是意外。
- 浏览器启动路径有了它此前没有的覆盖。单元套件看不到这个缺陷：`gateway.client.spec.ts` 用它自己挑的名字测冲突，所以它从未挑中已交付装配所用的那一个；而 marketplace 套件自己的测试根本不挂载 client 装配。

## 测试

`packages/api/remotes/tests/assembly.client.spec.ts` 经由真的 gateway 挂载真正被选中的贡献集合，并断言 `marketplace.install` 可调用——那正是浏览器启动时走的路径。`packages/api/gateway/tests/gateway.client.spec.ts` 把它的冲突案例保留在服务仍保留的名字上（`installDirect`、`methods`），并新增一个循环：挂载、调用、释放一个名为 `install`、`remove`、`has` 的 namespace 方法，断言挂载期间 accessor 存在、释放之后消失。`DSH_SNAPSHOT=replay pnpm run test:web:built` 在重放场景上跑组装后的浏览器。
