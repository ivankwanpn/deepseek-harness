# Agent Note: A goal's budget meters tokens and active work, not only rounds

Status: implemented

English | [中文](2026-09-13-goal-resource-budgets.zh.md)

## Problem

A goal's only aggregate bound was `maxGoalRounds`, which counts continuation cycles. A round is not a unit of work: a round that reads a file and stops costs one, exactly like a round that runs a full test matrix for ten minutes. The cap therefore cannot express "give this goal substantial effort but stop before it becomes expensive", and raising it to permit long work also raises the ceiling on cheap no-op rounds. The domain README stated the gap directly: `maxGoalRounds` did not meter tokens, currency, wall time, or provider quotas.

Codex's `ThreadGoal` replaces round counting with two resource budgets — a token ceiling and elapsed time — and reports `tokensUsed` and `timeUsedSeconds` against them. A Codex thread carries one objective; a DSH session carries a sequence of goals, because a completed goal can be replaced by the next one in the same session. The faithful mapping of a per-thread budget is therefore per goal, not per session. A session-wide budget would stop a newly created goal because an earlier goal in the same session spent the allowance, which is an unexplained stop with no relationship to the work being refused.

Two session projections already own the quantities a budget needs, so the goal domain must read them rather than fold its own counters: `tokenUsage` ([`@deepseek-ai/dsh-token-meter`](../../../../packages/llm/token-meter/README.md)) accumulates the four disjoint provider usage buckets across the complete log, and `sessionStats` ([`@deepseek-ai/dsh-session-stats`](../../../../packages/session/session-stats/README.md)) accumulates model and tool wall time. Both are whole-log cumulative totals, so a goal created mid-session needs a recorded baseline before either figure can be attributed to it.

## Decision

`GoalSnapshot` carries two ceilings beside `maxGoalRounds`: `maxGoalTokens` and `maxGoalWorkMs`, each a positive safe integer or `null` while unbounded. `null` is the durable spelling of "no ceiling", so a create request that names neither the field nor a deployment default stays unbounded rather than acquiring a zero budget.

### Baselines make a cumulative total attributable to one goal

Every non-clear `goal/change` records `tokensAtCreate` and `workMsAtCreate`: the session's cumulative totals at the create mutation, read from `tokenUsage` and `sessionStats`. The strict fold retains them across every later mutation, exactly as it retains `roundsStarted`, and rejects a change that moves either one. `GoalView` then derives `tokensUsed` and `workMsUsed` as the live total minus the recorded baseline, clamped at zero.

A goal that already recorded a baseline keeps it. A goal gaining its first budget through `edit` — one created before budgets existed — records the current total at that mutation, so the budget meters work admitted from then on rather than retroactively charging work admitted earlier.

### Usage is measured as active work, not wall time

`workMsUsed` sums `sessionStats.llmMs` and `sessionStats.toolMs`, so it advances only while the model streams or a tool call is outstanding. Codex reports elapsed wall time; a DSH goal can be paused for a day and resumed, and wall time would spend the budget while nothing ran.

### Both budgets stop continuation before another round is queued

`goal-round-driver` checks `GoalView.exhaustedBudget` after the existing round-cap check and before reserving a round. An exhausted budget blocks the goal with the stable code `budget-limit` and a message naming the ceiling, the spend, and the field to raise. `maxGoalRounds` keeps its position and its `round-limit` message, so a deployment that sets no budget observes exactly its previous behaviour. `GoalService.resume` refuses a goal whose budget is spent, under the existing `GOAL_INVALID_TRANSITION` code, so a resumed goal cannot be re-blocked on the next pass.

`exhaustedBudget` reports the first spent ceiling in `tokens` then `work` order. A budget the deployment cannot currently meter reports no exhaustion: `create` and `edit` already refuse a budget the deployment cannot meter at all, and a meter unloaded after the fact must not strand an active goal.

### The spend is logged because the prompt shows it

The round prompt states the headroom (`Budget used: <spent>/<ceiling> tokens`), so the model can converge instead of discovering the ceiling only when the goal stops. The [goal-round invariant](../../../../packages/goal/goal-round-driver/src/invariant.ts) re-renders that prompt from the log alone and compares it with the admitted message, so the spend it renders must itself be durable. `GoalMessageSource` therefore carries the spend at admission, and the strict fold validates it as an optional non-negative integer. A deployment that meters nothing renders `unknown` in place of the figure.

### A deployment that names a budget must meter it

`create` and `edit` throw `GOAL_BUDGET_UNMETERED` when a request names a ceiling whose projection is not registered, rather than accepting a budget that nothing enforces. `defaultMaxGoalTokens` and `defaultMaxGoalWorkMs` are validated deployment defaults, resolved once at service construction like `defaultMaxGoalRounds`.

### The payload additions do not bump the Session format

The two ceilings are optional in the `goal/change` payload and `GoalChangeMeta.version` stays `1`. The [versioning rule](../architecture/2026-08-10-session-log-version-mechanism.md) treats an ordinary payload addition as neutral for the physical codec, so `SESSION_FORMAT_VERSION` does not move and no adjacent migration edge is added. Two consequences are deliberate:

- **Released logs keep restoring.** A record written before budgets existed carries neither ceiling nor baseline, and the decoder reads it as unbounded with no claimed usage figure. `GoalProjection.tokensAtCreate` stays absent rather than defaulting to zero, so such a goal reports `tokensUsed: null` instead of claiming the whole session's spend.
- **An older reader refuses a newer log.** The decoder validates each record's field set, so a build that predates these fields rejects a log containing them instead of reading a budgeted goal as unbounded. That is the safe direction and matches the rule that a predecessor implies neither fallback nor downgrade support.

## Consequences

A budgeted goal now stops on work actually spent, so `maxGoalRounds` can be raised to a value that no longer pretends to bound effort. The two ceilings compose with the round cap: whichever is reached first stops continuation, and the blocker code says which.

The `goal` projection's host state gains two optional fields and its `stateVersion` moves from 6 to 7, so persisted projection-cache rows for this key are refolded rather than reused.

`dsh-goal` now reads two projections it does not provide. The imports are type-only, and an unbudgeted goal behaves identically when neither is mounted. The shipped bundles meter the two budgets differently: the base bundle mounts `token-meter`, and only the web-app bundle mounts `session-stats`, so a headless deployment can budget tokens and is refused a work budget until it mounts the statistics plugin. [`dsh-session-stats`](../../../../packages/session/session-stats/src/index.ts) additionally re-exports its projection unit from the package root, which its `SessionProjectionStateMap` augmentation needs in order to load in a program that imports only the root — the same module edge `dsh-token-meter` already declares.

A goal's spend is a live reading, not durable state. `tokensUsed` and `workMsUsed` are recomputed from the current projections on every read, so a projection-cache refold or a resumed session reports the same figures the log supports.

## Alternatives considered

**A session-scoped budget resolved from configuration only.** Rejected: it stops a new goal because an earlier goal in the same session spent the allowance, and it cannot express a per-objective ceiling. It was also the smaller change, which is why it needed the user-visible objection answered rather than assumed.

**Wall-clock time since `createdAt`, matching Codex's `timeUsedSeconds`.** Rejected: a paused goal would spend its budget while nothing runs. `GoalView.createdAt` is already durable, so this was the cheaper reading of the same requirement.

**A per-round `tokensUsed` written by the round driver.** Rejected: it adds a second `goal/change` mutation per round beside the goal-sourced `user/message` that already advances `roundsStarted`, and it duplicates a counter the fold would then have to reconcile with the message stream.

**A goal-owned fold of `assistant/message.usage`.** Rejected: `tokenUsage` already owns that fold, including the retry-replacement rule that closes a replaced attempt's slot. A second implementation would have to reproduce it exactly and would drift.

**Declaring the round-prompt spend as non-durable.** Rejected: the driver invariant re-renders the prompt from the log and would fail every budgeted round, and the repository rule is that anything model-visible is reconstructable from the log.

**Storing `null` as `-1` or `0` for an absent ceiling.** Rejected: a released record that omits the fields entirely must read as unbounded, and an explicit `null` is the one spelling that cannot be confused with a zero budget.

**Refusing to start a budgeted goal when the meter is absent, silently ignoring the budget instead.** Rejected: a safety ceiling that quietly enforces nothing is worse than a refusal, and the misconfiguration is self-contained at the mutation that names it.
