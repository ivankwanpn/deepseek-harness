# Agent Note: Session format v4 承载 goal 限制的载荷变更

Status: implemented

[English](2026-09-16-session-format-v3-to-v4.md) | 中文

## 问题

goal 限制工作改动了 goal change 载荷的持久化形状，而 checkout 写出的仍是 Session format 3，已发布格式也停在 3。因此 `pnpm run verify-persistence-changes` 拒绝承认这项改动，`doc-sync` 停在 40/41：

- `event:goal/change.data.goal.maxGoalRounds` —— 声明类型由 `number` 放宽为 `number | null`（无上限续跑）。
- `event:goal/change.data.goal.maxGoalTokens` 与 `maxGoalWorkMs` —— 新增为必需属性；它们取代了两个仅作默认值的字段，并约束每一次 create 与 edit。

另有八项改动属于同版本新增、无需边：`agent/inbox/spliced`、`session/title-llm-request`、`user/message` 的消息来源上的 `tokensUsed` 与 `workMsUsed`，以及 `goal/change` 上的 `tokensAtCreate` 与 `workMsAtCreate`。writer 的版本提升另使 `SessionHeader.version` 成为一项被检测到的改动。

运行时本就宽松地读取新形状——goal fold 把三个 ceiling 视为可选，且 `decodeCeiling(undefined)` 返回 `null`，所以预算出现之前写下的记录会以无上限重放。缺的是持久化声明本身：没有相邻边时，早于该改动的 build 会拒绝 `maxGoalRounds` 为 `null` 的 format 3 记录，persistence 闸门也没有可供承认的版本迁移。

## 决策

Session format v4 就是当前 writer 写出的 goal 限制载荷；v3 保持其已发布含义。相邻的边 **v3 → v4** 物化三项 ceiling，writer、catalog 以及每一个含义为「当前」的消费者都落在 v4。

### 转换规则

只有携带 `data.goal` 快照的 `event:goal/change` 事件会被转换。对 `maxGoalRounds`、`maxGoalTokens`、`maxGoalWorkMs` 三者：

- 字段缺失时物化为显式 `null`（无上限，正是宽松解码本来就返回的值）；
- 已存在的数值原样保留。

`tokensAtCreate` 与 `workMsAtCreate` 缺失时保持缺失：它们是可选的，缺失表示该记录不主张用量基线。goal clear 墓碑、无关的 Session 事件以及其他所有事件类型原样通过。

该边对回放无损：迁移到 v4 的 v3 记录，其含义与宽松解码器读到的完全相同。区别在于 v4 记录显式声明自己的 ceiling，而不是依赖缺失。

### 套件与接线

- 该边落在 `packages/session/session-format-v3-to-v4`，遵循 `session-format-v2-to-v3` 的布局：v4 codec、有状态的 Stage 迁移（`transformEvent`、`transformRun`、`finish`）、target-header 校验器，以及 target restorer。
- 该边声明 `dsh.sessionFormatMigration`，数值 `from: 3`、`to: 4`，并**复用** `session-format-v2-to-v3` 导出的 v3 codec；不重新定义已发布的 codec。
- `SESSION_FORMAT_VERSION` 在 core Session 类型中由 3 移到 4，与声明同批；随后 `pnpm run gen-session-format-catalog` 重生成 catalog。生成文件不得手改。
- writer 变更之前，archive 指令已把 v3 的完整持久化 schema 冻结为双语的 `docs/persistence-changes/historical-formats/v3.*`，使每个低于 writer 的整数都保有自己的文档。

### 当前版本消费者

每一个含义为「当前」的消费者都读取 `SESSION_FORMAT_VERSION`：Session 创建与恢复、JSONL 文件名选择与发布、catalog 的当前 encoder 与 restorer、replay 与 snapshot 的正规化，以及两个 SDK 冒烟镜像。字面历史版本留在已发布 codec 与历史 fixture 中，persistence 测试通过常量固定当前世代而不是字面量。projection cache 继续把自身的折叠绑定到 Session header 自己的版本。读取路径保持既有行为：仅读 header 的列举不读正文，历史读取可以返回已迁移的内存产物而不发布，写入只发布最终当前后继。

### Snapshot 后继与 SDK 投影

每个历史 snapshot 保留原文件，并以目标版本的规范文件名生成 v4 后继；前驱保持字节相同，父/子角色保持连续。两个 SDK 投影都为新世代重新录制。产出这些证据的 Linux lane 同时把 snapshot 语料策略更新到当前世代，并保留 direct-edge、multi-hop、packed-row、retry/failure 与 shipped-profile 覆盖。

## 考虑过的替代方案

**恒等转换（只重盖版本号，正文不动）。** cookbook 把恒等正文转换视为初始接线脚手架，而非迁移。它还会让 v4 记录可以省略其自身类型声明为必需的 ceiling——这正是本次 bump 要终结的漂移。

**把三个 ceiling 在 `GoalSnapshot` 中声明为可选以避开 bump。** 闸门把「新增必需属性」判为版本升级工作，因为该类型镜像 writer 实际写出的内容，而 writer 确实在每次非 clear mutation 上写出全部三个字段。声明为可选等于为了绕过闸门而低报持久化载荷。

**保持 `maxGoalRounds: number`，用哨兵值编码无上限。** 诸如 `0` 的哨兵会重新引入可空类型已经消除的歧义，而且对两个必需新增字段毫无帮助——它们自身就会触发 bump。

**把那八项可选新增一并纳入 v4。** 它们在当前版本即可接纳，而把它们纳入 v4 会暗示该边会正规化消息来源形状，而没有任何需求要求如此。它们改以同版本变更被承认。

## 验证

- `pnpm run verify-persistence-changes` 记录 v3 → v4 迁移，并在所有被检测到的改动——包括 `SessionHeader.version` 的转换——全部获承认后通过。
- 聚焦测试覆盖：直接的 v3 → v4 边；从 v0、v1、v2 经 v4 的 seeded multi-hop 恢复；malformed 与 unknown-required-event 拒绝；重复恢复的决定性；并发的 stage 状态互不共享；seeded multi-hop 的继承切割；前驱不变；不回退到前驱。
- `pnpm run verify-session-format-catalog` 与 cookbook 的聚焦 Vitest 基线通过，并把新边的测试路径加入该次运行；`pnpm run test:docs`、`pnpm run doc-sync` 与 `pnpm run lint` 通过。
- `docs/persistence-changes/historical-formats/v3.md` 与 `.zh.md` 存在，且格式覆盖检查对每个低于 writer 的整数通过。
- 所属笔记 [Released Session formats migrate through stateful streaming stages](2026-08-31-released-session-format-migrations.zh.md) 得到更新而非重复；双语配对已重新记录。
- Linux lane `pnpm run test:snapshot`（含语料）与 `pnpm run test:expected` 产出后继与 SDK 录制证据；Windows checkout 跑不了这两条 lane，因此它们是该边剩余的发布证据。

## 影响

本次 bump 终结了「声明的持久化载荷」与「实际写出的载荷」之间的漂移：v4 记录显式声明自己的 ceiling，旧 build 会拒绝它而不是把缺失误读成它从未主张过的上限，persistence 闸门也承认这次转换。

- **单向边界。** 早于 v4 的 build 会拒绝 v4 记录；而 fork 在 bump 之前的 writer 已经产出过携带 `null` 的 v3 header 记录。开发期间写出的临时文件带有目标 writer 版本、不会再次迁移，所以集成测试必须从不变的历史输入在一次性 home 中重跑。
- **后继世代不是重命名。** 把前驱改名为目标文件名，或用 packer 式重写当升级器，都会破坏世代链；cookbook 的 snapshot 规则是承重结构。
- **Windows checkout 产不出 snapshot 证据。** 第 5、6 阶段依赖 Linux 环境；在 Windows 上该 lane 按策略失败，因此这项工作只有在 Linux lane 真正跑过之后才算完成。
- **迁移正规化过度。** 物化 ceiling 不得触碰其他载荷成员；过宽的 stage 会改写无关的 goal change，使该边的准入规则无法测试。
