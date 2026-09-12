# Agent Note: The unit suite's per-test budget is declared in the Vitest config

Status: implemented

English | [中文](2026-09-12-unit-suite-test-budget.zh.md)

## Problem

[`vitest.config.ts`](../../../../vitest.config.ts) declared no `testTimeout`, `hookTimeout`, or `expect.poll.timeout`, so a run that received no timeout arguments ran on Vitest's 5000 ms case default and its hardcoded 1000 ms `expect.poll` default. `coverageTestTimeoutArgs` in [`scripts/coverage-partitions.ts`](../../../../scripts/coverage-partitions.ts) derives those arguments from `DSH_COVERAGE_TEST_TIMEOUT_MS`, and three steps export it: the Linux and Windows coverage lanes in [ci.yml](../../../../.github/workflows/ci.yml) and the Windows complete-inventory standby in [ci-master.yml](../../../../.github/workflows/ci-master.yml). Four other CI invocations of the same suite received nothing, because each reaches `coverageGates()` through a job that exports no budget: both `pnpm run check:ci` standbys and the `check:ci:linux-primary` standby in ci-master.yml, plus the darwin parity leg's `pnpm run test` in [sandbox.yml](../../../../.github/workflows/sandbox.yml). The documented local command `pnpm run test` is the same invocation.

Measured on one revision: a full local run at those defaults failed 10 cases, each reporting `Test timed out in 5000ms`, and the same revision at the lane budget failed none of them. The repository had already recorded that host effect — the Linux coverage lane raises its budget because disposal cases in `subprocess-local` and `bash-sandbox` exceeded 5000 ms on the hosted image ([hosted-image assumptions](2026-09-10-hosted-image-test-assumptions.md)).

`--expect.poll.timeout` never applied anywhere. Vitest 4.1.8 accepts the argument but resolves the poll budget from the loaded config (`getWorkerState().config.expect?.poll`), so every `expect.poll` stayed at 1000 ms however large a budget its lane exported.

## Decision

Both Vitest projects declare `testTimeout`, `hookTimeout`, and `expect.poll.timeout` from one value: `coverageTestTimeoutMs(process.env[DSH_COVERAGE_TEST_TIMEOUT_MS]) ?? 90_000`.

`coverageTestTimeoutMs(raw)` is the validated number, extracted from `coverageTestTimeoutArgs` so the CLI arguments and the config cannot disagree about it; it still rejects a non-integer, zero, or negative value with the same message. `coverageTestTimeoutArgs` returns `--testTimeout` and `--hookTimeout`, and no longer emits `--expect.poll.timeout`, which granted nothing while reading as though it did.

[`scripts/ci-workflow.spec.ts`](../../../../scripts/ci-workflow.spec.ts) pins the wiring: the config's fallback must equal every `DSH_COVERAGE_TEST_TIMEOUT_MS` ci.yml declares, and both projects must declare all three settings. The guard has a negative control — setting the fallback to `30_000` fails it with `expected Set{ 90000 } to deeply equal Set{ 30000 }`.

The declared budget is a lane ceiling, not a floor on local values. A `describe` or case value still overrides it, which is the form the [Lefthook suite](../../../../scripts/install-lefthook.spec.ts) uses and the form the [budget rules](../../../skills/dsh-ci-test-reliability/SKILL.md#budget-timeouts-against-the-lane) require a reason for.

`vi.waitFor` and `vi.waitUntil` keep Vitest's hardcoded 1000 ms because they read no config. A wait that can cross a process or filesystem boundary therefore states its own budget; the wait in [session-projection-cache fixtures](../../../../packages/session/session-projection-cache/tests/fixtures.spec.ts) for the document the product rewrites now uses `expect.poll`, which reads the config, in place of an unreasoned 5-second `vi.waitFor`.

## Alternatives considered

**Export `DSH_COVERAGE_TEST_TIMEOUT_MS` from the four CI steps that lack it.** Rejected: that repairs CI and leaves `pnpm run test`, `npx vitest run <file>`, and any future lane at 5000 ms, which is the invocation that failed. It also puts the budget in five places that drift, where the config now holds the only copy the runner itself reads.

**Keep the CLI as the single source and keep passing `--expect.poll.timeout`.** Rejected as inert: the argument changes no poll deadline in Vitest 4.1.8, so the poll budget has to be declared where `expect.poll` reads it.

**Convert the suite's 989 `vi.waitFor` call sites to `expect.poll`.** Rejected: the two differ in what they retry on — `waitFor` retries a throwing callback, `poll` retries a failing assertion — so every site needs its own reading to stay correct, and no observation reached that ceiling.

**Rewrite every local budget that sits below the lane's.** Rejected: a stated local budget is the sanctioned form when it carries its reason, and several cases exist to assert a deadline the lane budget must stay above. The measured cause was the lane default, not the stated allowances.

**Keep "lanes that leave the variable unset keep every Vitest default", the consequence the [Windows lane budget note](../../archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md) recorded.** Rejected: that consequence is what held four CI invocations and the documented local command at 5000 ms.

## Consequences

Every run of this config, a developer's or a lane's, now grants the budget the coverage lanes export, so the budgetless invocations inherit 90 seconds instead of Vitest's defaults. A lane that exports a different value still governs, through the same function that produces its CLI arguments.

The 5000 ms ceiling no longer catches a genuine multi-second slowdown in a local run. That detection was already absent from the verdict: the coverage lanes that decide the build ran at 90 seconds before this change, so the tighter default could only fail a developer's run that CI would have passed.

`testTimeout` remains an outer bound rather than a latency assertion, and all 989 `vi.waitFor` call sites keep Vitest's 1000 ms default. A wait that needs longer states its own budget; no config value can supply one.

The lane budget now applies to hooks as well as cases on every run, not only where the variable is exported, so a setup or teardown that exceeds 10 seconds no longer fails a suite whose cases all passed.

The declared poll budget reaches 72 of the suite's 75 `expect.poll` call sites; three state their own. A poll that genuinely cannot pass now reports at the lane budget instead of after one second, and where a poll shares its case's budget the case timeout can report first, so that failure reads as a timeout rather than as the assertion diff it used to print.

## Deferred

One case still fails in a full local run, and not because of a budget. Its file failed in three consecutive full runs — at the 5000 ms defaults, under the gate's 90-second CLI arguments, and under this config's declared budget, where `archived version recovery > opens v4-session-doc.json without serving its unbound fold, then rewrites it current` reported a 90000 ms timeout. It is not the wait's ceiling: the same case passes in 110 ms alone, and 18 of 18 concurrent copies of its own file passed, so the reproduction needs the full pool beside it. The same runs also report two `Worker forks emitted error` unhandled errors, whose relation to this case is unestablished. Instrumenting the cache's write path in a full run is what would separate a product write that never lands from a fork starved of the host.
