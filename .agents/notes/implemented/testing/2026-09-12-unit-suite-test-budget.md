# Agent Note: The unit lane's per-test budgets and where an override is justified

Status: implemented

English | [中文](2026-09-12-unit-suite-test-budget.zh.md)

## Problem

[`vitest.config.ts`](../../../../vitest.config.ts) declared no `testTimeout`, `hookTimeout`, or `expect.poll.timeout`, and Vitest exposes no configuration at all for `vi.waitFor` and `vi.waitUntil` — its utilities object exposes the bare `waitFor(callback, options = {})`, which destructures `timeout = 1e3`. A run that received no timeout arguments therefore ran on Vitest's 5000 ms case default and its hardcoded 1000 ms poll and wait default. `coverageTestTimeoutArgs` in [`scripts/coverage-partitions.ts`](../../../../scripts/coverage-partitions.ts) derives those arguments from `DSH_COVERAGE_TEST_TIMEOUT_MS`, and three steps export it: the Linux and Windows coverage lanes in [ci.yml](../../../../.github/workflows/ci.yml) and the Windows complete-inventory standby in [ci-master.yml](../../../../.github/workflows/ci-master.yml). Four other CI invocations of the same suite received nothing, because each reaches `coverageGates()` through a job that exports no budget: both `pnpm run check:ci` standbys and the `check:ci:linux-primary` standby in ci-master.yml, plus the darwin parity leg's `pnpm run test` in [sandbox.yml](../../../../.github/workflows/sandbox.yml). The documented local command `pnpm run test` is the same invocation.

Measured on one revision: a full local run at those defaults failed 10 cases, each reporting `Test timed out in 5000ms`, and the same revision at the lane budget failed none of them. The repository had already recorded that host effect — the Linux coverage lane raises its budget because disposal cases in `subprocess-local` and `bash-sandbox` exceeded 5000 ms on the hosted image ([hosted-image assumptions](2026-09-10-hosted-image-test-assumptions.md)).

`--expect.poll.timeout` never applied anywhere. Vitest 4.1.8 accepts the argument but resolves the poll budget from the loaded config (`getWorkerState().config.expect?.poll`), so every `expect.poll` stayed at 1000 ms however large a budget its lane exported.

The lane's own overrides did not follow either. It carried 922 `vi.waitFor` calls that state no budget, bounded by Vitest's hardcoded second while the case around them ran on the lane's 90, and 171 further budgets stated at the call site: 66 on `vi.waitFor`, and 105 on cases or their `describe`, every one of them below the lane's.

## Decision

`laneTestBudgetMs()` resolves the lane's budget once — the exported `DSH_COVERAGE_TEST_TIMEOUT_MS` when a lane declares one, else `LANE_TEST_BUDGET_FALLBACK_MS` — and everything that grants a timeout reads it: both Vitest projects, the setup file below, and the coverage gates' CLI arguments. `coverageTestTimeoutArgs` returns `--testTimeout` and `--hookTimeout`, and no longer emits `--expect.poll.timeout`, which granted nothing while reading as though it did.

Both projects declare `testTimeout`, `hookTimeout`, and `expect.poll.timeout` from that budget. `vi.waitFor` and `vi.waitUntil` read no configuration, so [`scripts/test-wait-budget.ts`](../../../../scripts/test-wait-budget.ts) — a `setupFiles` entry of both projects, installed before the invariant host — supplies the same budget as their default; a call that states its own timeout, in either accepted form, keeps it.

[`scripts/test-wait-budget.spec.ts`](../../../../scripts/test-wait-budget.spec.ts) proves both halves of the mechanism: with the installation in place a bare wait in this lane settled after 1526 ms, and with that one call removed the same case failed after 1014 ms on Vitest's second. The `setupFiles` wiring is a separate case, because importing the module installs the default whether or not the lane wired it.

[`scripts/ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts) pins the budget to the workflows: the fallback must equal every `DSH_COVERAGE_TEST_TIMEOUT_MS` ci.yml declares, and both projects must declare all three settings. The guard has a negative control — setting the fallback to `30_000` fails it with `expected Set{ 90000 } to deeply equal Set{ 30000 }`.

## Budget policy

A budget that bounds a settling wait inherits the lane's; a budget that is the subject under test keeps its value and states why.

**Settling.** 176 budgets were removed in this change: the 66 `vi.waitFor` budgets and 105 case or `describe` budgets that sat between Vitest's defaults and the lane's, plus five uses of one file constant (`PERSISTENCE_TEST_TIMEOUT_MS`). Each widened a wait or a case to survive a loaded host, which is the work the lane budget already covers. A suite bound by process creation carries no allowance of its own.

**Subject.** Seven budgets survive, each with its reason beside it. `uses the configured WebSocket heartbeat interval` bounds a 20 ms configured interval with 1000 ms, and the lane's 90 s would let a ping that never arrives pass as a slow host. [`process-exit.spec.ts`](../../../../packages/subprocess/subprocess-local/tests/process-exit.spec.ts) derives `testTimeoutMs` from its own `scenarioTimeoutMs`, because a case must outlive the deadline it waits on or the harness reports before the product does. Five budgets sit above the lane deliberately: 120_000 twice, 180_000, and 480_000 twice, for cases that walk every package's type graph or resolve every browser build graph.

## Alternatives considered

**Export `DSH_COVERAGE_TEST_TIMEOUT_MS` from the four CI steps that lack it.** Rejected: that repairs CI and leaves `pnpm run test`, `npx vitest run <file>`, and any future lane at 5000 ms, which is the invocation that failed. It also puts the budget in five places that drift, where one function now resolves every copy.

**Keep the CLI as the single source and keep passing `--expect.poll.timeout`.** Rejected as inert: the argument changes no poll deadline in Vitest 4.1.8, so the poll budget has to be declared where `expect.poll` reads it.

**Leave the 922 bare waits on Vitest's second and document the rule.** Rejected: the rule would then hold for cases and polls and not for waits, and the two options left at the call site are editing 922 sites or converting them to `expect.poll`, whose retry condition differs — `waitFor` retries a throwing callback, `poll` retries a failing assertion.

**Convert the 988 `vi.waitFor` call sites to `expect.poll`.** Rejected for the same retry condition, and because the lane default makes the conversion unnecessary.

**Rewrite every local budget, including the subject ones.** Rejected: a case that proves a deadline must not inherit a 90-second ceiling, which is what the seven surviving budgets state.

**Keep "lanes that leave the variable unset keep every Vitest default", the consequence the [Windows lane budget note](../../archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md) recorded.** Rejected: that consequence is what held four CI invocations and the documented local command at 5000 ms.

## Consequences

Every run of this config, a developer's or a lane's, now grants the budget the coverage lanes export, so the budgetless invocations inherit 90 seconds instead of Vitest's defaults. A lane that exports a different value still governs, through the same function that produces its CLI arguments.

The 5000 ms ceiling no longer catches a genuine multi-second slowdown in a local run. That detection was already absent from the verdict: the coverage lanes that decide the build ran at 90 seconds before this change, so the tighter default could only fail a developer's run that CI would have passed.

Waits and cases that genuinely cannot settle now report later. A bare `vi.waitFor` that never succeeds reports at the lane budget, and where its case shares that budget the case timeout reports first, so the failure reads as a timeout rather than as the callback's last throw; the 176 removed budgets and the 72 of 75 `expect.poll` sites that take the declared poll budget carry the same trade. The cost falls on a broken assertion's diagnosis, not on any passing run, and a run that hangs now costs the lane budget instead of one second.

The lane budget applies to hooks as well as cases on every run, not only where the variable is exported, so a setup or teardown that exceeds 10 seconds no longer fails a suite whose cases all passed.

## Deferred

`session-projection-cache` still fails in a full run, and not because of a budget: three distinct cases across four runs — the `v4-session-doc` and `v5-lineageless-doc` fixture recoveries in [the fixtures suite](../../../../packages/session/session-projection-cache/tests/fixtures.spec.ts), and `writes a durable checkpoint at turn/end (mandatory point)` in [the cache suite](../../../../packages/session/session-projection-cache/tests/cache.spec.ts) — each reported a 90000 ms timeout while waiting for a durable checkpoint. Every one passes alone, the fixture case in 110 ms, and 18 of 18 concurrent copies of the fixture file passed, so the reproduction needs the full pool beside it. The package's `write()` gates its checkpoint row on `await this.ctx.sessions.flush(session)`, which is where instrumentation would separate a storage write starved of the pool from a flush that never settles. The same runs also report two `Worker forks emitted error` unhandled errors, whose relation to these cases is unestablished.

Those deaths are also visible to the coverage gate, which reports four of them in an instrumented run. One of that gate's two further reasons is closed: `packages/client/ui-settings-marketplace/src/client/MarketplaceSettingsTab.tsx` reported 93.67% lines and 89.58% branches on a file and spec pair identical to master, and now measures 100% — its cases cover the empty catalog, a refused read with a retry, the uninstall cancel, and a refusal that is not an Error, with a `/* v8 ignore next -- reason */` on the one unreachable defensive arm. The other is a lost spec file rather than a merge fault: the inventory carries `packages/llm/llm-deepseek/tests/adapter.spec.ts` — re-running the coordinator's own `vitest list --filesOnly` under the gate's environment returns it among 1209 files — and `assignWeightedPartitions` keeps it in a bucket of 309, yet that gate log shows its eleven sibling specs and never it, while the gate's own summary accounts for 1208 of those 1209 files. The uncovered functions are exactly the ones that spec covers (`providerRejectedNormalizedImage`, `providerRejectedFileId`, `detailNamesFileId`), so the fork running it died and took its results and coverage with it. The coordinator now refuses that partition instead of merging without it: `assertNoDiedWorkers` reads each partition's output tail for Vitest's worker-death markers and fails naming the partition, so a lost file can no longer resurface as a per-file threshold failure on an unrelated source file. The fork death itself is intermittent rather than deterministic — four gate-shaped runs lost the same file twice and completed cleanly twice, and neither four concurrent partitions of one bucket nor a single instrumented partition reproduced it. Running the gate through its own entry point (`pnpm run test:coverage:partitioned`) completed with no death, no lost file, and no threshold failure; a bare `tsx scripts/run-coverage-partitions.ts` cannot stand in, because the coordinator resolves pnpm through `npm_execpath` and collects an empty inventory without it.

Two further load-sensitive cases are not budget-caused. `waitForInboxMessage times out when the session log or matching insertion is absent` in [the snapshot harness suite](../../../../packages/test-support/session-snapshot/tests/harness.spec.ts) asked for the harness's 20 ms diagnostic without the de-racing helper its two tight-budget siblings install, so a full run recorded Vitest's `Timed out in waitFor!` where the case asserted the harness's own message; it installs that helper now. [`instance.spec.ts`](../../../../packages/lsp/lsp-stdio/tests/instance.spec.ts) asserts that an instance survives a cancel the server honors inside a `killGraceMs: 2_000` window, and under the full pool the spawned server's answer outran that grace once in five runs; the case states no budget, this change does not touch its file, and it passes in three consecutive runs alone, so replacing its latency assumption — a wider grace would cost the case its ability to tell a request-resolved cancel from a timer-resolved one — is its own decision.
