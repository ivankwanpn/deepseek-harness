# Agent Note: A goal is unbounded in rounds unless a deployment caps it

Status: implemented

English | [中文](2026-09-13-unbounded-goal-rounds.zh.md)

## Problem

A goal's round cap was mandatory and defaulted to 256. `GoalSnapshot.maxGoalRounds` was a required positive integer, the strict fold refused a change without it, and `goal-round-driver` checked it *before* either resource ceiling. A deployment that configured token and active-work budgets therefore still stopped its goals on a round count that nothing in the conversation explained, and `Round: 3/256` and `Rounds: 3/256` put that number in front of both the model and the human.

The ceiling was never a measurement of work. Codex's persisted thread goal has no round concept at all: `thread_goals` carries `token_budget`, `tokens_used`, and `time_used_seconds`, its `[goals] max_goal_token_budget` is the only configured bound, and `budget_limited` and `usage_limited` are the only spend-driven stops. Rounds exist in this repository because the driver admits numbered continuation messages, not because a deployment wants to bound work by counting them.

## Decision

`maxGoalRounds` is `number | null`, and `null` means continuation is unbounded by rounds. A deployment that configures no round default creates goals with no cap, so the resource ceilings are the only aggregate bound; a deployment that wants a meter-free guard still sets `defaultMaxGoalRounds`, and `update_goal` `edit` can set, raise, or clear it on one goal.

### One rule, read everywhere

`roundsExhausted(goal, roundsStarted)` and `roundWithinCap(goal, round)` in [`domain.ts`](../../../../packages/goal/goal/src/domain.ts) are the only places the null cap is interpreted. The continuation driver asks the first before queuing a round; the replay fold asks the first when validating a `resume`, the projection-state schema asks the second when validating a restored state, and the fold asks the second when validating an admitted round message. A named cap therefore keeps every guard it had, and a null cap removes all of them together rather than in the places someone remembered.

### The durable payload admits an absent ceiling

`goal.maxGoalRounds` moved from the required field set to the optional set and decodes through the same helper the two budgets use, so an absent field and an explicit `null` both read as unbounded. `create` always writes the field, as it does for the budgets.

The projection schema accepts `null`, and the tool output drops the field entirely when a goal has no cap, which is the same shape the budgets already use for an unbounded ceiling.

### Model-visible and human-visible text follows

The round prompt renders `Round: 7` while rounds are unbounded and `Round: 7/40` under a cap. `/goal` renders `Rounds: 7` and `Rounds: 7/40` the same way. Both renderers keep the admitted count, because the blocked audit counts consecutive goal rounds.

## Alternatives considered

**Keep the 256 default and treat it as a formality.** Rejected: it is not a formality when it is checked first. A deployment that set both budgets still saw goals stop at 256 rounds, and the model saw the number in every round prompt.

**Spell "unbounded" as `0` or `-1`.** Rejected: both are invalid positive integers today, so either would turn a rejected value into a meaningful one and make every existing validation read backwards. `null` is the spelling the two budgets already use, and an absent field already means unbounded there.

**Add an `unlimitedRounds` boolean beside the cap.** Rejected: two fields for one fact, and every reader would have to check the pair in the right order.

**Make the cap nullable but keep the deployment default at 256.** Rejected: the shipped default is the behaviour under discussion. A deployment that wants the guard sets it; one that configures budgets gets budgets.

**Represent the cap as a very large integer.** Rejected: `Number.MAX_SAFE_INTEGER` renders as `Round: 7/9007199254740991` in the prompt and `/goal` output, and it claims a bound the deployment did not choose.

## Testing

`packages/goal/goal/tests/domain.spec.ts` reads both predicates on both sides of a named cap and against a null cap. `goal.spec.ts` admits three rounds to an uncapped goal, refolds them, and resumes it, and asserts that a create without a deployment default reports a null cap. `projection.spec.ts` asserts the state schema still rejects a round count past a named cap and accepts the same count while the cap is null. `goal-round-driver.spec.ts` keeps its capped goal blocking with `round-limit`. `command-goal.spec.ts` pins the uncapped status line, and `tool-goal.spec.ts` pins both the absent field and a deployment cap that a stale `max_goal_rounds` argument cannot override.

## Consequences

A goal created without a configured cap is bounded only by its resource ceilings, or by nothing at all when the deployment configures none. That is the deployment's choice to make, and it matches the reference implementation; the previous behaviour was a bound the deployment had not asked for and could not see.

The durable change is a relaxation for readers that know the field is nullable and a refusal for builds that predate it: an older decoder requires `maxGoalRounds` to be a positive integer and rejects a record carrying `null`. That is the same one-way boundary the [resource budgets](2026-09-13-goal-resource-budgets.md) established, and it is the safe direction — a predecessor refuses a newer log rather than reading an uncapped goal as capped.

`dsh-goal`'s shipped default is now no bound at all, so the [configuration catalogue](../../../../docs/config-catalog.md) lists no default for `defaultMaxGoalRounds`. The web profile patch ships only the two resource guards.
