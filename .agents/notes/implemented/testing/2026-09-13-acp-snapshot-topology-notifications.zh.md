# Agent Note: 尽力发送拓扑通知下的确定性 ACP 快照

Status: implemented

[English](2026-09-13-acp-snapshot-topology-notifications.md) | 中文

## 问题

ACP 在有序输出链之外解析模型选项。发现若在关闭开始前完成，就可以将 `config_option_update` 通知入队；若稍后完成，则丢弃通知。因此，即使每个 prompt 结果与持久化 Session 事件一致，精确 stdout 快照仍取决于调度。[标准 ACP 控制](../feature/2026-08-22-standard-acp-automation-controls.zh.md)的支持独立于这项快照策略。

## 决策

[ACP suite](../../../../packages/test-support/session-snapshot/src/suite.ts)对实际与已提交 stdout 应用相同投影：仅当帧是没有 `id` 的 JSON-RPC 2.0 通知、方法为 `session/update`、且 `params.update.sessionUpdate` 等于 `config_option_update` 时移除该帧。[goal 生命周期验证](../../../../apps/cli/tests/profiles/acp/tests/goal.expected.e2e.ts) 在 suite 之外拥有 goal 专属规范化，并对它的两个 stdout fixture 应用同一投影。解析检查协议字段，绝不匹配用户或工具文本中的子串。其他帧保留既有 stdout 规范化后的字节；配置响应、带关联标识的请求、转录更新与持久化 Session 比较保留各自断言。无效 JSON 仍会失败。

对于稳定帧序列 S，无论在其中插入多少此类通知，投影都返回 S。通知数量、位置、发现延迟及其与关闭竞态的结果都无法影响投影后的比较。这证明了针对该变化来源的确定性，并不声称 lane 不可能发生无关失败。Record 和 refresh 写入投影后的 stdout；replay 在内存中投影已提交 fixture，不重写它们。

## 考虑过的替代方案

**关闭时等待发现。** 提供方可能永远不完成模型发现。等待会违反 prompt 完成与 close 保持响应的既有保证。

**关闭开始后发布发现结果。** 移除关闭检查允许 teardown 后出现迟到通知，且其是否出现仍取决于进程关闭时序。

**要求每个 fixture 都包含通知。** 产品不承诺在关闭前交付。记录任一调度结果都会把可选通知变成没有依据的断言。

**在产品中抑制冗余拓扑通知。** 跟踪 revision 会改变可观察行为，且无法处理会话中的真实拓扑变化。快照比较只需遵守既有交付保证。

## 后果

这些快照刻意不检测匹配拓扑通知内部缺失或格式错误的选项载荷。[ACP bridge 测试](../../../../packages/acp/acp/tests/bridge.spec.ts)负责目录内容、拓扑变化后的发布，以及发现挂起时 prompt／close 的行为。[Suite 测试](../../../../packages/test-support/session-snapshot/tests/suite.spec.ts)证明通知缺席、重复及改变位置时投影保持不变，其他协议帧与嵌入文本得以保留，且无效 JSON 被拒绝。产品生命周期行为保持不变。
