# Agent Note: A deployment's budget value is also the most a goal may be granted

Status: implemented

English | [中文](2026-09-13-goal-budget-ceiling.zh.md)

## Problem

`dsh-goal`'s two budget fields were defaults and nothing more. `defaultMaxGoalTokens` and `defaultMaxGoalWorkMs` supplied a ceiling for a create request that named none, and a request that named its own overrode them without limit. A deployment could therefore state a spend guard and still see a goal granted any budget at all, because the only caller that could exceed the guard was the one the guard existed to bound.

Codex closes this by construction: `[goals] max_goal_token_budget` is documented as the "maximum token budget allowed for a goal and default budget for new goals", and `validate_goal_budget` refuses a create or update whose requested budget exceeds it. One configured value, both jobs.

The field names also stopped being true. A value that is both the default and the maximum is not a default, and the `default*` prefix invited exactly the reading that caused the gap.

## Decision

The two configuration fields are `maxGoalTokens` and `maxGoalWorkMs`, and each one is both the default a create request inherits and the most any create or edit may name.

`resolveBudget(value, limit, field)` resolves every budget request against that limit: an omitted field inherits it, a named value must be a positive safe integer no larger than it, and an explicit `null` is accepted only while the deployment bounds nothing. A request that exceeds the limit, or that asks for an unbounded budget while the deployment bounds it, is refused with the new stable code `GOAL_BUDGET_EXCEEDS_LIMIT`. The rule is applied in the operation that makes the decision — the create resolution and the edit resolution both pass the deployment's limit — so no caller reaches a budget the deployment did not allow.

Deployment configuration is validated separately by `validateDeploymentCeiling`, which requires a positive safe integer and rejects an unusable value with `GOAL_INVALID_BUDGET` at service construction rather than at the first create.

Clearing a limit stays a deployment decision and remains available: unsetting `maxGoalTokens` in the composition entry, or emptying the field in the Settings row, removes both the default and the maximum, and goals then carry no token budget unless a request names one.

## Alternatives considered

**Keep the two fields apart: `defaultMaxGoalTokens` for the default and a new ceiling field for the maximum.** Rejected as the larger surface for no gain: two knobs where the reference has one, two fields to explain, and a deployment that sets only the default still has no guard. A deployment that wants a low default and a high maximum is asking for a bound it does not want enforced.

**Keep the names and change only the enforcement.** Rejected: `defaultMaxGoalTokens` that also caps is a name that contradicts its behaviour, and the mismatch is what the next reader would act on.

**Let an edit raise a budget past the limit while create cannot.** Rejected: the edit is exactly how a goal's budget would be widened, so the ceiling would be decorative.

**Refuse an explicit `null` always.** Rejected: `null` is the domain's unbounded spelling and stays meaningful whenever the deployment bounds nothing. It is refused only when accepting it would contradict a configured limit.

**Apply the ceiling to the round cap as well.** Rejected: rounds are not a resource this deployment meters, `create_goal` cannot name a cap at all, and an `edit` that changes it already requires a direct human message in the runtime-root turn.

## Testing

`packages/goal/goal/tests/goal.spec.ts` covers the ceiling on both paths: a create inherits the configured value, a create naming less is accepted, a create or edit naming more is refused with `GOAL_BUDGET_EXCEEDS_LIMIT`, an edit naming `null` under a configured limit is refused, an edit naming less is accepted, and an unusable configured ceiling fails at construction. The first version of that test caught a real defect — the edit path resolved its budgets with a null limit, so the ceiling held on create and not on edit.

`packages/client/ui-goal/tests/goal-defaults-row.client.spec.tsx` and `browser-plugin.client.spec.tsx` follow the renamed fields through the Settings row, and its copy now states that a budget is also the most any goal may be granted.

## Consequences

A model can tighten a goal's budget but never widen it past what the deployment allows, which is the property the budget exists for. A human still changes the limit itself, and since [the defaults are a settings section](2026-09-13-human-owned-goal-limits.md) that change needs no restart.

Every goal a deployment admits now starts with that deployment's budget rather than with none. A deployment that wants unbounded goals leaves both fields unset, exactly as before; what changed is that setting one no longer leaves the other direction open.

The configuration catalog and the Web Settings row carry the new names. `defaultMaxGoalTokens` and `defaultMaxGoalWorkMs` are gone rather than aliased: they shipped in the same day's work and no released deployment configuration names them.
