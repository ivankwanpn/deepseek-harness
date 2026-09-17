---
description: "从 v3 到 v4 的相邻会话格式迁移：goal 变更载荷携带显式的 maxGoalRounds、maxGoalTokens 与 maxGoalWorkMs 上限，其余一切不变。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v3-to-v4

[English](README.md) | 中文

## 概述

将受支持的已发布 V3 会话恢复为 V4：把 goal 变更本就隐含的目标限制上限显式写出。迁移边复用已发布 V3 物理分帧并重盖为版本 4；只有携带 `data.goal` 快照的 `goal/change` 载荷发生变化，缺失的 `maxGoalRounds`、`maxGoalTokens` 或 `maxGoalWorkMs` 物化为显式 `null` 无界上限，其余一切原样通过。持久化通过静态目录使用本迁移边；本库不读取也不发布文件。

## 目录

- [使用本包](#use-this-package)
- [V3 到 V4 规范](#v3-to-v4-specification)
  - [goal 变更载荷](#goal-change-payloads)
  - [分帧、准入与保留](#framing-admission-and-preservation)
- [理解实现](#understand-the-implementation)
- [深入探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 使用场景

使用[目录](../session-format-catalog/README.zh.md)恢复会话。直接导入用于目录组装和测试；本库没有 Cordis 挂载配置。[公共导出](src/index.ts)提供已发布 V4 编解码器、目标头校验器和目标恢复器。相邻迁移由本包 `dsh.sessionFormatMigration` 清单声明，并只经由生成目录到达调用方。

### 入口

仅头部的操作不转换也不校验事件体：

```text
const targetHeader = sessionFormatV3ToV4.migrateHeader(sourceHeader)
```

完整恢复通过[v4 编解码器](src/codec.ts)解码物理行并编译相邻链；调用方不得把阶段的部分发射视为成功恢复，因为拒绝可能出现在更晚的事件或 finish 处。[格式协议](../session-format/README.zh.md)负责链调度与目录错误处理；[v2 到 v3 迁移边](../session-format-v2-to-v3/README.zh.md)负责本迁移边复用的已发布 V3 规则。

-----

<a id="v3-to-v4-specification"></a>
## V3 到 V4 规范

这条迁移边刻意保持狭窄。V4 恰好接纳当前写入器已经发出的 goal 载荷形状；其他事件、信封或头部规则一概不动。迁移后的记录对当前重放是无损的：宽容解码器本就已把缺失的上限读作无界，迁移边补上的只是该上限的持久声明。

<a id="goal-change-payloads"></a>
### goal 变更载荷

只有携带 `data.goal` 快照的 `event:goal/change` 事件会被转换。对 `maxGoalRounds`、`maxGoalTokens` 和 `maxGoalWorkMs` 三者分别：

- 缺失字段物化为显式 `null`，表示无界；
- 已存在的数值原样保留。

`tokensAtCreate` 与 `workMsAtCreate` 缺失时保持缺失：它们是可选的，缺失表示该记录不声明用量基线。goal 清除墓碑、无关的会话事件以及其他所有事件类型一律原样通过。

<a id="framing-admission-and-preservation"></a>
### 分帧、准入与保留

V4 不添加超出 V3 的信封准入规则。[编解码器](src/codec.ts)就是已发布 V3 物理编解码器，仅在两侧重盖头部版本；[恢复器](src/validation.ts)委托已发布 V3 关系规则；不重新定义任何已发布编解码器。迁移对未知必需事件的分类与拒绝与 V3 准入完全一致，因此本迁移边无法担保的日志会被拒绝，而不是被猜测。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

[编解码器](src/codec.ts)把每个 v4 物理头部以 v3 头部呈现给已发布 V3 编解码器，因此分帧、恢复策略与继承切点的推导保持冻结。[恢复器](src/validation.ts)先重新校验 v4 头部，再对私有 v3 视图运行已发布 V3 关系校验，并返回原始产物。清单中的迁移边条目命名迁移、源与目标编解码器、目标头校验器和目标恢复器；[目录生成器](../../../scripts/gen-session-format-catalog.ts)是唯一消费方，任何不匹配都会被拒绝。本库不拥有可独立观察的注册或状态副本，因此不发布运行时不变量伴随入口。

[编解码器测试](tests/codec.spec.ts)固定头部准入与版本往返。

</details>

-----

<a id="further-exploration"></a>
## 深入探索

- [已发布 V2 到 V3](../session-format-v2-to-v3/README.zh.md) — 冻结的前代迁移边，也是本包复用的已发布 V3 编解码器。
- [新增会话格式版本](../../../docs/cookbook/adding-a-session-format-version.zh.md) — 每条相邻迁移边都遵循的发布流程。
- [v3 到 v4 设计记录](../../../.agents/notes/implemented/architecture/2026-09-16-session-format-v3-to-v4.zh.md) — goal 限制载荷变更及其落地结果。

-----

<a id="model-experience"></a>
## 模型体验

### goal 限制载荷恢复

#### 模型看到什么

恢复后的 `goal/change` 事件保留全部已记录快照字段，三个上限（`maxGoalRounds`、`maxGoalTokens`、`maxGoalWorkMs`）变为显式，因此从迁移记录读出的 goal 变更声明与其宽容解码器此前应用的续跑预算完全相同。迁移边不注册自己的工具、提示词区段或模型可见文本。

#### Token 影响

迁移边不添加模型可见文本，也不改变请求组装；它物化的上限约束 goal 续跑预算，不改变提示词。

#### KV Cache 影响

迁移边保留历史请求含义与模型配置；它不保证提供方缓存命中，也不保证与原生录制字节相同。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- **单向边界** — 早于 v4 的构建会拒绝 v4 记录，持久化只发布当前后继代；已被取代的代绝不重写。[格式发布状态](../../../docs/session-format-status.zh.md)负责当前代次。
- **载荷范围** — 只规范化携带 `data.goal` 的 goal 变更快照；同版本的消息来源与用量基线新增字段保持原样记录。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
