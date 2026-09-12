# Agent Note: 单元套件的每用例预算声明在 Vitest 配置里

Status: implemented

[English](2026-09-12-unit-suite-test-budget.md) | 中文

## 问题

[`vitest.config.ts`](../../../../vitest.config.ts) 没有声明 `testTimeout`、`hookTimeout` 与 `expect.poll.timeout`，因此任何没有收到超时参数的运行都落在 Vitest 的 5000 ms 用例默认值与它硬编码的 1000 ms `expect.poll` 默认值上。[`scripts/coverage-partitions.ts`](../../../../scripts/coverage-partitions.ts) 里的 `coverageTestTimeoutArgs` 由 `DSH_COVERAGE_TEST_TIMEOUT_MS` 推导这些参数，而导出该变量只有三处：[ci.yml](../../../../.github/workflows/ci.yml) 的 Linux 与 Windows coverage 通道，以及 [ci-master.yml](../../../../.github/workflows/ci-master.yml) 的 Windows 完整清单备用通道。同一套件另有四次 CI 调用什么也没拿到，因为它们经由的 job 都不导出预算却各自到达 `coverageGates()`：ci-master.yml 里两个 `pnpm run check:ci` 备用通道与 `check:ci:linux-primary` 备用通道，以及 [sandbox.yml](../../../../.github/workflows/sandbox.yml) 里 darwin 对等支路的 `pnpm run test`。文档记载的本地命令 `pnpm run test` 就是同一种调用。

在同一份修订上实测：以这些默认值跑完整本地套件失败 10 个用例，每个都报告 `Test timed out in 5000ms`；同一份修订在通道预算下没有任何一个失败。本仓库此前已记录过同一宿主效应——Linux coverage 通道之所以提高预算，是因为托管镜像上 `subprocess-local` 与 `bash-sandbox` 的 dispose 用例超过了 5000 ms（[托管镜像假设](2026-09-10-hosted-image-test-assumptions.zh.md)）。

`--expect.poll.timeout` 在任何地方都不生效。Vitest 4.1.8 接受该参数，却从已加载的配置里解析轮询预算（`getWorkerState().config.expect?.poll`），因此无论所在通道导出多大的预算，每个 `expect.poll` 都停在 1000 ms。

## 决策

两个 Vitest project 都由同一个值声明 `testTimeout`、`hookTimeout` 与 `expect.poll.timeout`：`coverageTestTimeoutMs(process.env[DSH_COVERAGE_TEST_TIMEOUT_MS]) ?? 90_000`。

`coverageTestTimeoutMs(raw)` 是那个经过校验的数字，从 `coverageTestTimeoutArgs` 中抽出，使命令行参数与配置不可能对它产生分歧；它仍以同一条消息拒绝非整数、零与负值。`coverageTestTimeoutArgs` 返回 `--testTimeout` 与 `--hookTimeout`，不再发出 `--expect.poll.timeout`——后者授予不了任何东西，读起来却像是授予了。

[`scripts/ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts) 钉住这条接线：配置的兜底值必须等于 ci.yml 声明的每一个 `DSH_COVERAGE_TEST_TIMEOUT_MS`，且两个 project 都必须声明全部三项设置。该守卫带反向对照——把兜底值改成 `30_000` 会让它以 `expected Set{ 90000 } to deeply equal Set{ 30000 }` 失败。

所声明的预算是通道上限，而不是对局部取值的下限。`describe` 或用例上的取值仍会覆盖它，这正是 [Lefthook 套件](../../../../scripts/install-lefthook.spec.ts)采用的形式，也是[预算规则](../../../skills/dsh-ci-test-reliability/SKILL.md#budget-timeouts-against-the-lane)要求给出更紧理由的形式。

`vi.waitFor` 与 `vi.waitUntil` 保持 Vitest 硬编码的 1000 ms，因为它们不读取配置。因此，可能跨越进程或文件系统边界的等待要自报预算；[session-projection-cache fixtures](../../../../packages/session/session-projection-cache/tests/fixtures.spec.ts) 中那个等待产品重写文档的等待，已由没有理由的 5 秒 `vi.waitFor` 改为读取配置的 `expect.poll`。

## 备选方案

**在缺少该变量的四个 CI 步骤里导出 `DSH_COVERAGE_TEST_TIMEOUT_MS`。** 否决：那只修好 CI，却把 `pnpm run test`、`npx vitest run <file>` 以及未来任何通道留在 5000 ms 上，而失败正是这种调用。它还会把预算散在五处并逐渐分叉，而如今配置持有运行器自己读取的唯一副本。

**保留命令行作为唯一来源，继续传 `--expect.poll.timeout`。** 因不生效而否决：该参数在 Vitest 4.1.8 里不改变任何轮询截止时间，因此轮询预算必须声明在 `expect.poll` 真正读取的位置。

**把套件里 989 处 `vi.waitFor` 调用改成 `expect.poll`。** 否决：两者重试的对象不同——`waitFor` 重试抛错的回调，`poll` 重试失败的断言——每一处都需要单独判读才能保持正确，而且没有任何观测触及过那个上限。

**重写每一处低于通道预算的局部预算。** 否决：带理由的局部预算正是被认可的形式，而且有些用例的存在就是为了断言一个通道预算必须高于它的截止时间。实测到的成因是通道默认值，不是这些写明的宽限值。

**保留「未设置该变量的通道保持全部 Vitest 默认值」这一后果——即 [Windows 通道预算笔记](../../archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md)所记录的。** 否决：正是这一后果把四次 CI 调用与文档记载的本地命令按在 5000 ms 上。

## 后果

这份配置的每一次运行——开发者的或通道的——现在都授予 coverage 通道所导出的预算，因此那些无预算的调用继承 90 秒而不是 Vitest 的默认值。导出其他值的通道仍然说了算，且经由产生其命令行参数的同一个函数。

5000 ms 的上限不再在本地运行中捕获真正的多秒级变慢。那种检测本来就不在判定里：决定构建的 coverage 通道在这次改动之前就跑在 90 秒上，因此更紧的默认值只可能让一个 CI 本会通过的开发者运行失败。

`testTimeout` 仍是外层界限而非延迟断言，全部 989 处 `vi.waitFor` 调用保持 Vitest 的 1000 ms 默认值。需要更久的等待要自报预算；任何配置值都提供不了。

通道预算现在在每一次运行中都同时适用于 hook 与用例，而不只在导出该变量的地方，因此超过 10 秒的 setup 或 teardown 不再让一个所有用例都通过的套件失败。

所声明的轮询预算到达套件里 75 处 `expect.poll` 调用中的 72 处；三处自报超时。真正无法通过的轮询现在会在通道预算处报告，而不是一秒之后；当轮询与它的用例共享同一预算时，用例超时可能先报告，于是那次失败读起来是超时，而不是它先前打印的断言差异。

## 待办

仍有一个用例在完整本地运行中失败，而且不是预算造成的。它所在的文件连续三次完整运行都失败——分别在 5000 ms 默认值下、在 gate 的 90 秒命令行参数下，以及在本配置声明的预算下，其中 `archived version recovery > opens v4-session-doc.json without serving its unbound fold, then rewrites it current` 报告了 90000 ms 超时。原因不是那个等待的上限：同一个用例单独运行 110 ms 通过，其所在文件自身的 18 次并发副本 18 次全过，因此复现需要整个池在旁边。同样的运行还报告两个 `Worker forks emitted error` 未处理错误，它们与该用例的关系尚未确立。要在一次完整运行中给缓存的写入路径加插桩，才能区分「产品的写入从未落地」与「某个 fork 被宿主饿死」。
