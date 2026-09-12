# Agent Note: 单元通道的每用例预算，以及何种覆写才算正当

Status: implemented

[English](2026-09-12-unit-suite-test-budget.md) | 中文

## 问题

[`vitest.config.ts`](../../../../vitest.config.ts) 没有声明 `testTimeout`、`hookTimeout` 与 `expect.poll.timeout`，而 Vitest 对 `vi.waitFor` 与 `vi.waitUntil` 根本不提供配置——它的 utilities 对象直接暴露未包装的 `waitFor(callback, options = {})`，其中解构出 `timeout = 1e3`。因此任何没有收到超时参数的运行都落在 Vitest 的 5000 ms 用例默认值与它硬编码的 1000 ms 轮询与等待默认值上。[`scripts/coverage-partitions.ts`](../../../../scripts/coverage-partitions.ts) 里的 `coverageTestTimeoutArgs` 由 `DSH_COVERAGE_TEST_TIMEOUT_MS` 推导这些参数，而导出该变量只有三处：[ci.yml](../../../../.github/workflows/ci.yml) 的 Linux 与 Windows coverage 通道，以及 [ci-master.yml](../../../../.github/workflows/ci-master.yml) 的 Windows 完整清单备用通道。同一套件另有四次 CI 调用什么也没拿到，因为它们经由的 job 都不导出预算却各自到达 `coverageGates()`：ci-master.yml 里两个 `pnpm run check:ci` 备用通道与 `check:ci:linux-primary` 备用通道，以及 [sandbox.yml](../../../../.github/workflows/sandbox.yml) 里 darwin 对等支路的 `pnpm run test`。文档记载的本地命令 `pnpm run test` 就是同一种调用。

在同一份修订上实测：以这些默认值跑完整本地套件失败 10 个用例，每个都报告 `Test timed out in 5000ms`；同一份修订在通道预算下没有任何一个失败。本仓库此前已记录过同一宿主效应——Linux coverage 通道之所以提高预算，是因为托管镜像上 `subprocess-local` 与 `bash-sandbox` 的 dispose 用例超过了 5000 ms（[托管镜像假设](2026-09-10-hosted-image-test-assumptions.zh.md)）。

`--expect.poll.timeout` 在任何地方都不生效。Vitest 4.1.8 接受该参数，却从已加载的配置里解析轮询预算（`getWorkerState().config.expect?.poll`），因此无论所在通道导出多大的预算，每个 `expect.poll` 都停在 1000 ms。

通道自身的覆写也不例外。它带着 922 处不声明任何预算的 `vi.waitFor` 调用，被 Vitest 硬编码的一秒界定，而外层的用例却跑在通道的 90 秒上；另有 171 处写在调用点的预算：66 处在 `vi.waitFor` 上，105 处在用例或它们的 `describe` 上，每一处都低于通道预算。

## 决策

`laneTestBudgetMs()` 只解析一次通道预算——通道声明了就取导出的 `DSH_COVERAGE_TEST_TIMEOUT_MS`，否则取 `LANE_TEST_BUDGET_FALLBACK_MS`——而所有授予超时的东西都读它：两个 Vitest project、下面的 setup 文件，以及 coverage gate 的命令行参数。`coverageTestTimeoutArgs` 返回 `--testTimeout` 与 `--hookTimeout`，不再发出 `--expect.poll.timeout`——后者授予不了任何东西，读起来却像是授予了。

两个 project 都由该预算声明 `testTimeout`、`hookTimeout` 与 `expect.poll.timeout`。`vi.waitFor` 与 `vi.waitUntil` 不读任何配置，因此 [`scripts/test-wait-budget.ts`](../../../../scripts/test-wait-budget.ts)——两个 project 的一个 `setupFiles` 条目，在 invariants 宿主之前装入——把同一预算作为它们的默认值；在调用点声明了自己超时的调用（两种形式皆可）保持不变。

[`scripts/test-wait-budget.spec.ts`](../../../../scripts/test-wait-budget.spec.ts) 证明该机制的两半：装上之后，本通道里一个裸等待在 1526 ms 后落定；仅移除那一处调用，同一个用例便在 1014 ms 处因 Vitest 的一秒而失败。`setupFiles` 接线是单独一条用例，因为导入该模块本身就会装上默认值，无论通道是否接线。

[`scripts/ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts) 把预算钉在 workflow 上：兜底值必须等于 ci.yml 声明的每一个 `DSH_COVERAGE_TEST_TIMEOUT_MS`，且两个 project 都必须声明全部三项设置。该守卫带反向对照——把兜底值改成 `30_000` 会让它以 `expected Set{ 90000 } to deeply equal Set{ 30000 }` 失败。

## 预算政策

界定落定等待的预算继承通道的；作为受测主体的预算保留其值并写明理由。

**落定。** 本次改动移除了 176 处预算：66 处 `vi.waitFor` 预算，以及 105 处落在 Vitest 默认值与通道预算之间的用例或 `describe` 预算，外加某个文件常量（`PERSISTENCE_TEST_TIMEOUT_MS`）的五处使用。每一处都是为了在负载宿主机上存活而放宽某个等待或用例，而这正是通道预算已经覆盖的工作。由进程创建决定的套件不自带津贴。

**主体。** 有七处预算保留，且理由就在它们旁边。`uses the configured WebSocket heartbeat interval` 用 1000 ms 界定一个配置为 20 ms 的间隔，而通道的 90 秒会让一个永不到达的 ping 冒充慢宿主。[`process-exit.spec.ts`](../../../../packages/subprocess/subprocess-local/tests/process-exit.spec.ts) 由自己的 `scenarioTimeoutMs` 推导 `testTimeoutMs`，因为用例必须比它所等待的截止时间活得更久，否则先报告的是测试框架而不是产品。另有五处预算刻意高于通道：两次 120_000、一次 180_000、两次 480_000，用于遍历每个包类型图或解析每个浏览器构建图的用例。

## 备选方案

**在缺少该变量的四个 CI 步骤里导出 `DSH_COVERAGE_TEST_TIMEOUT_MS`。** 否决：那只修好 CI，却把 `pnpm run test`、`npx vitest run <file>` 以及未来任何通道留在 5000 ms 上，而失败正是这种调用。它还会把预算散在五处并逐渐分叉，而如今由一个函数解析每一份副本。

**保留命令行作为唯一来源，继续传 `--expect.poll.timeout`。** 因不生效而否决：该参数在 Vitest 4.1.8 里不改变任何轮询截止时间，因此轮询预算必须声明在 `expect.poll` 真正读取的位置。

**让 922 处裸等待继续停在 Vitest 的一秒上，只把规则写进文档。** 否决：那样这条规则对用例与轮询成立、对等待却不成立，而调用点剩下的两个选择是改 922 处，或把它们转成 `expect.poll`——后者的重试条件不同：`waitFor` 重试抛错的回调，`poll` 重试失败的断言。

**把 988 处 `vi.waitFor` 调用改成 `expect.poll`。** 因同样的重试条件而否决，而且通道默认值已经让这种转换变得多余。

**重写每一处局部预算，包括受测主体那些。** 否决：证明某个截止时间的用例不该继承 90 秒的上限，而这正是七处幸存预算所写明的。

**保留「未设置该变量的通道保持全部 Vitest 默认值」这一后果——即 [Windows 通道预算笔记](../../archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md)所记录的。** 否决：正是这一后果把四次 CI 调用与文档记载的本地命令按在 5000 ms 上。

## 后果

这份配置的每一次运行——开发者的或通道的——现在都授予 coverage 通道所导出的预算，因此那些无预算的调用继承 90 秒而不是 Vitest 的默认值。导出其他值的通道仍然说了算，且经由产生其命令行参数的同一个函数。

5000 ms 的上限不再在本地运行中捕获真正的多秒级变慢。那种检测本来就不在判定里：决定构建的 coverage 通道在这次改动之前就跑在 90 秒上，因此更紧的默认值只可能让一个 CI 本会通过的开发者运行失败。

真正无法落定的等待与用例现在更晚报告。永不成功的裸 `vi.waitFor` 会在通道预算处报告，而当它的用例共享同一预算时，先报告的是用例超时，于是那次失败读起来是超时而不是回调最后抛出的错误；被移除的 176 处预算，以及 75 处 `expect.poll` 里采用所声明轮询预算的那 72 处，代价相同。这笔代价落在坏断言的诊断上，不落在任何通过的运行上；而一次卡住的运行现在花费通道预算而不是一秒。

通道预算现在在每一次运行中都同时适用于 hook 与用例，而不只在导出该变量的地方，因此超过 10 秒的 setup 或 teardown 不再让一个所有用例都通过的套件失败。

## 待办

`session-projection-cache` 在完整运行中仍然失败，而且不是预算造成的：四次运行里有三个不同的用例——[fixtures 套件](../../../../packages/session/session-projection-cache/tests/fixtures.spec.ts)里的 `v4-session-doc` 与 `v5-lineageless-doc` fixture 恢复，以及 [cache 套件](../../../../packages/session/session-projection-cache/tests/cache.spec.ts)里的 `writes a durable checkpoint at turn/end (mandatory point)`——每一个都报告了 90000 ms 超时，等待的是一次持久化 checkpoint。它们单独运行全部通过（fixture 用例 110 ms），而 fixture 文件自身的 18 次并发副本 18 次全过，因此复现需要整个池在旁边。该包的 `write()` 在 checkpoint 行落地前先 `await this.ctx.sessions.flush(session)`，插桩正是要在那里区分「存储写入被池饿死」与「flush 永不落定」。同样的运行还报告两个 `Worker forks emitted error` 未处理错误，它们与这些用例的关系尚未确立。

这些死亡对覆盖率闸同样可见，一次插桩运行报告了其中四次。该闸还因另外两个本次改动不拥有的原因失败。`packages/client/ui-settings-marketplace/src/client/MarketplaceSettingsTab.tsx` 即使在只运行其自身套件时也报告 93.67% 行与 89.58% 分支，而该文件与其 spec 都与 master 无异，因此是该包的测试确实没有覆盖那些路径。在分区闸里失败的那五个 `packages/llm/llm-deepseek/src` 文件则是一个**丢失的 spec 文件**，而不是合并故障：盘点是带着 `packages/llm/llm-deepseek/tests/adapter.spec.ts` 的——以闸自身环境重跑协调器所用的 `vitest list --filesOnly`，它在 1209 个文件之中——而 `assignWeightedPartitions` 把它留在了一个 309 个文件的分桶里，然而闸日志列出了它十一个同类 spec 却从未列出它，同时闸自己的统计只交代了那 1209 个文件中的 1208 个。未覆盖的函数正是该 spec 所覆盖的那些（`providerRejectedNormalizedImage`、`providerRejectedFileId`、`detailNamesFileId`），因此运行它的 fork 死掉了，把它的结果与覆盖率一并带走。协调器现在会拒绝那一条分区，而不是在没有它的情况下照常合并：`assertNoDiedWorkers` 读取每条分区的输出尾部里 Vitest 的 worker 死亡标记，失败并点名该分区，于是一个丢失的文件不再能以「某个无辜原始码文件的逐文件阈值失败」的形式重新浮现。fork 死亡本身仍未解释，而 marketplace 那个包缺失的路径仍需要它自己的测试。

另有两个对负载敏感、但与预算无关的用例。快照 harness 套件里的 `waitForInboxMessage times out when the session log or matching insertion is absent`（见[该套件](../../../../packages/test-support/session-snapshot/tests/harness.spec.ts)）要求 harness 的 20 ms 诊断，却没有装它两个紧预算同类用例所装的去竞速 helper，于是一次完整运行记录到 Vitest 的 `Timed out in waitFor!`，而该用例断言的是 harness 自己的消息；它现在装上那个 helper。[`instance.spec.ts`](../../../../packages/lsp/lsp-stdio/tests/instance.spec.ts) 断言在 `killGraceMs: 2_000` 窗口内、服务器遵从取消时实例存活，而在完整池下，被拉起的服务器应答在五次运行中有一次跑赢了那个宽限；该用例不声明任何预算，本次改动没有碰它的文件，且它单独连续三次通过，因此替换它的延迟假设——更宽的宽限会让它失去区分「请求解决取消」与「计时器解决取消」的能力——是它自己的决定。
