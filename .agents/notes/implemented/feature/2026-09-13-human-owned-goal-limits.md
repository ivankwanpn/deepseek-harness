# Agent Note: Humans set a goal's limits through Settings and through the model

Status: implemented

English | [中文](2026-09-13-human-owned-goal-limits.zh.md)

## Problem

Once the deployment owned a goal's round cap, nobody else could change it. The [round-cap ownership decision](2026-09-13-deployment-owned-goal-round-cap.md) removed `max_goal_rounds` from `create_goal`, so the configured default applied to every created goal and nothing else named a cap on creation. The three defaults were resolved once from the composition entry at service construction, so a deployment that wanted different limits edited `cordis.yml` and restarted.

Two human paths were missing rather than broken. `update_goal` `edit` already changes the round cap and either budget under direct-human authority, but the goal prompt section never said that a human asking for a limit is a request to apply one, so the model had no instruction connecting the wording to the tool. And the [model-facing tools note](2026-07-19-model-facing-goal-tools.md) claimed "the domain's explicit `null` and `/goal` remain the clearing paths" when `/goal` has [no limit argument at all](../../../../packages/goal/command-goal/src/index.ts): it parses `<objective>`, `clear`, `edit`, `pause`, and `resume` locally and calls the goal service directly, so text typed after `/goal` never reaches a model.

## Decision

Humans get two seams and no new syntax.

### The defaults are a settings section

The three fields are also the `goal` [settings](../../../../packages/settings/settings/README.md) namespace, registered through `installSection` so the composition entry is both the base layer and the fallback. `GoalService` holds a configuration source rather than a resolved value, and `create` derives its defaults from that source per call, so a committed change governs the next goal instead of the next process. Clearing a field re-inherits the composition entry.

Nothing is memoized, so no watcher re-derives anything: `scope.watch` exists in production only inside `installSection` itself. The section's own schema checks the field types, and a `validate` hook additionally runs the domain's own resolution over the resolved candidate, so a stored value that passes the schema yet no `create` would act on — a round cap beyond `Number.MAX_SAFE_INTEGER`, for instance — is refused at the write rather than at the next create.

A deployment without a settings provider keeps working exactly as composed: the source thunk returns the entry, and the registration never happens.

### The Web Settings panel edits them

`ui-goal` contributes a Goal limits row to the General section, over `ctx.settingsScope.bind`. Each of the three fields writes on every accepted entry and clears its override when left empty. The row needs both the settings transport and the General section, so it is registered inside a child `ctx.inject(['settingsScope'], …)` with `ctx.slots.inject('settings.general.item', …)`: a composition without either keeps GoalBar and drops the row, and a composition that disables the General section does not fail at load.

### The model applies a limit the human names

The goal prompt section now states which tool applies a human's limit request — `create_goal` takes the budgets, `update_goal` action `edit` changes the round cap or either budget on the current goal — and that whatever the human leaves unnamed keeps the deployment default. This covers every surface that reaches a model, including headless and ACP sessions that have no settings panel.

`/goal` continues to carry no limit argument. A human who wants a specific limit asks in chat; a human who wants different defaults edits them in Settings or in `cordis.yml`.

## Alternatives considered

**A flag syntax on `/goal`, such as `/goal <objective> --rounds 40`.** Rejected: the command parses its input locally and calls `ctx.goals.create` without a model turn, so the flag would need its own parser, its own copy, and its own tests, while the model already holds an authorized `edit` path that works from ordinary wording. It would also leave the headless surfaces, which consume no commands at all, exactly where they are.

**A Web-only form with no model guidance.** Rejected as the whole change: a session driven through the ACP automation surface or the one-shot headless profile has no Settings panel, and the deployment's YAML is the only other control.

**Caching the section and refreshing it from a watcher.** Rejected: the only reader is `create`, so caching would add a stale window between a committed change and the next create and buy nothing. The [agent-loop](../../../../packages/core/agent-loop/src/index.ts) read-through getter is the precedent.

**Registering the row in `ui-settings-general`.** Rejected: that package's General section holds no built-in rows by its own contract; the shell declares the slot and each feature owns its row.

**Reading the namespace through `describe()` and writing through `remote.settings.mutate`, as the permission-presets row does.** Rejected: that row needs the namespace schema to render a dynamic option set. Three fixed numeric fields do not, `settingsScope.bind` costs no wire read, and a new direct `describe` caller regresses the Web startup RPC budget.

**Declaring `settingsScope` in the plugin's top-level `inject`.** Rejected: it would gate the whole plugin, including the GoalBar strip, on the settings plugin being mounted. The child injection scopes the dependency to the row.

## Testing

`packages/goal/goal/tests/goal.spec.ts` mounts the domain over an in-memory settings provider and proves that a committed section changes the limits a later `create` resolves, that the composition entry still applies before any write, and that a stored round cap no create could act on is refused at the write.

`packages/client/ui-goal/tests/goal-defaults-row.client.spec.tsx` covers the row: resolved values render, an unbounded budget renders empty, a valid entry writes, a rejected entry reports its copy and writes nothing, and an emptied field runs the clear path.

`packages/client/ui-goal/tests/browser-plugin.client.spec.tsx` proves the registration and its disposal: the row registers at `settings.general.item` with its locale and order, the inject face adopts the section at registration so the first render is never empty, edits route to the scope's `set`/`unset`, and unloading the plugin fiber withdraws both the row and its subscription.

The Web lane's `apps/web/tests/settings-chrome.e2e.ts` golden renders the row inside the assembled Settings dialog with the resolved round cap and empty budget fields, so the section, the scope binding, and the copy are covered end to end.

## Consequences

The deployment's `cordis.yml` remains the default and gains a live user layer above it. A goal already recorded in a session log keeps the limits it stored; the section governs creation.

`ui-goal` now takes a type-only dependency on `ui-settings` and, at most, contributes a row: absent settings, absent General section, or an unwritable document leaves the strip unchanged.

The `/goal` command still cannot set a limit, and the [human goal command](../../archived/feature/2026-07-19-human-goal-command.md) note's "no per-command round-cap argument" limitation stands — a human reaches the limits through Settings or by asking the model.
