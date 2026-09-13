# Agent Note: The deployment owns a goal's continuation round cap

Status: implemented

English | [中文](2026-09-13-deployment-owned-goal-round-cap.zh.md)

## Problem

A goal's stop condition was largely chosen by the model that created it. `create_goal` accepted `max_goal_rounds`, and [`GoalService.create`](../../../../packages/goal/goal/README.md) applies `defaultMaxGoalRounds` only to a create request that omits its own cap. A model that named 14 rounds therefore produced a goal capped at 14 however the deployment was configured, and raising the deployment default changed nothing because the model's own number was already present in the request.

The [resource budgets](2026-09-13-goal-resource-budgets.md) bound work rather than cycles, but they compose with the round cap instead of replacing it: `goal-round-driver` checks the cap before either ceiling, so a model-named cap stops continuation before any budget is consulted. Budgets are also opt-in, and a deployment that configured none observed exactly the earlier behaviour. A deployment could not make its own stop condition authoritative while a model could name a smaller one.

## Decision

`create_goal` takes an `objective` and, optionally, the two resource ceilings. It does not take `max_goal_rounds`, and create forwards no round cap to `GoalService.create`, so every goal created through a tool inherits the deployment's `defaultMaxGoalRounds`.

`update_goal` keeps `max_goal_rounds` for the `edit` action. That is now the only tool path that names a cap, and `edit` already requires a direct human message in a runtime-root agent's current turn ([authority rules](2026-07-19-model-facing-goal-tools.md)), so a cap can be replaced only by an authorized human edit or by deployment configuration.

The create guidance tells the model that the deployment owns how many rounds and how much resource a goal may spend, and that it names a budget only when the human asks for one. Model judgment still decides whether a request is a goal; it no longer decides how long that goal may run.

### The retired argument is dropped, not defaulted

The parameter declaration no longer carries the field, and create reads the fields it declares, so an argument that a stale caller still sends has no effect on the created cap. The published tool schema is generated from the same declaration, so the field leaves the model's view in the same change; the recorded snapshot sidecars that pin the schema are refreshed with it.

## Testing

Unit coverage pins both directions: a create from a direct human turn reports the deployment's configured cap, and a create whose arguments still carry `max_goal_rounds: 9` reports that same configured cap. The keyless recorded-session lane replays through the shipped headless profile, and its expected tool schemas are re-recorded for the narrower parameter object.

## Consequences

A deployment's `defaultMaxGoalRounds` now bounds every goal a model creates, so the configured default is the effective stop condition and the resource ceilings do the metering. The base bundle mounts the goal package with no config, so a deployment that sets nothing keeps that package's shipped default.

The change governs creation. A goal already recorded in a session log keeps the cap it stored, and a human raises it through `update_goal` `edit` or the user-facing command path.

The round cap stays a per-goal field in the domain, and `GoalSnapshot.maxGoalRounds`, `GoalService.create`, the `/goal` command, and the Web control still name it. Only the model-facing create surface narrowed.

## Alternatives considered

**Keep the parameter and rely on guidance telling the model not to name a cap.** Rejected: the deployment default applies only to a request that omits the field, so a model that ignored the guidance would still have decided the stop condition, and nothing would report that it had.

**Keep the parameter and clamp a named cap up to the deployment default.** Rejected: it preserves a model-visible knob whose only possible effect is to shorten the goal, which is the outcome the deployment is trying to prevent, and a clamp makes the reported cap differ from the argument the model sent.

**Raise `defaultMaxGoalRounds` and leave the tool surface alone.** Rejected as the whole fix: the raised default does not apply once a model names its own cap, which is the condition that produced the reported stop.

**Remove `max_goal_rounds` from `update_goal` as well.** Rejected: `edit` is the human-authorized path to the cap, and removing it would leave no way to raise a cap already recorded in a log.
