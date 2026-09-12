# Agent Note: The marketplace panel enables, disables and uninstalls installed plugins

Status: implemented

English | [中文](2026-09-11-marketplace-panel-write-controls.zh.md)

## Problem

The Web marketplace panel read state and could change none of it. Every action a user wanted after seeing a plugin listed — turning it off, removing it — meant leaving the browser for `dsh plugin marketplace`, even though the same user, on the same machine, had already authenticated the same browser session that rendered the panel. The first version withheld the write surface deliberately, because a browser-driven filesystem mutation needs a permission story, a confirmation story, and a partial-failure story that a status read does not.

## Decision

The panel manages plugins that are already installed: enable, disable, uninstall. Browsing and installing live in the same tab and the same Remote face, owned by [the catalog and install note](2026-09-12-marketplace-catalog-and-install.md); registering a marketplace stays on the CLI.

**Reads never write.** `marketplace.status` resolves ownership from the state record and the plugin's own `skills/` directory, and enablement from the patch layer. It never materializes, so opening a settings tab cannot copy or move anything on disk. This is the property the earlier read-only surface was built to protect, and it is kept rather than traded away.

**A deployment decides whether writes exist.** The gateway's `allowMutations` config field (default `true`) is checked in the write path itself, and the refusal is a `marketplace/read-only` failure the panel renders. The panel reads the same flag from the status snapshot and draws no controls when it is false, but that is display input: a hidden button is not an enforcement point, and a deployment that shares a harness home can rely on the check rather than on the UI.

**One implementation per operation.** `setPluginEnabled` in `src/operations.ts` is what both faces call, and the CLI's `enable`/`disable` now goes through it. Each write also returns the status it produced, so the panel renders post-write truth rather than issuing a second read that could race the write it just made.

Enforcement follows the two mechanisms enablement already had: loader rows by their `disabled` flag, skill entries by moving them between the discovery root and `<root>/.disabled/<plugin>/`. The status view reports what the patch layer cannot — `skillIds`, and `skills` as `live`, `parked` or `none` — because skills mount by discovery and have no row to describe them.

Uninstall is gated behind an explicit acknowledgement (`RiskConfirmation`, whose confirm button stays unavailable until its checkbox is set); the toggle is not. The distinction is what each one costs to undo: disabling moves content aside and enabling moves it back without a re-fetch, while uninstalling deletes the content directory, the materialized skills, the rows and the record.

The panel cannot draw a control whose only possible outcome is a refusal. A plugin that mounts nothing has no toggle, because there is nothing to move; a read-only deployment has no toggle and no uninstall button. The confirm button is likewise unavailable while a write is in flight for that plugin.

Wiring the write path exposed a cleanup bug in the same area as [the flat skill materialization](../bug-fix/2026-09-11-marketplace-skills-land-flat.md). One function both dropped stale entry names and removed the parking directory, so the first stale name a sync dropped took a DISABLED plugin's only copy of its skills with it. The two jobs are now separate: `removeMaterializedSkills` removes exactly the names it is given, and `removePluginSkills` is uninstall's wider cleanup — those names plus the parking directory and the plugin-scoped container an earlier layout wrote.

## Alternatives considered

**Exposing install and search from the panel too.** Deferred here rather than rejected, and taken up by [the catalog and install note](2026-09-12-marketplace-catalog-and-install.md), which serves browsing through one catalog read and an install through one request. Uninstall and enablement needed none of that work, which is why they came first.

**Gating writes in the panel alone.** Rejected: the panel is one client among several that can reach the same Remote namespace, and the CLI can change a plugin between a read and a click. A rule enforced only where it is displayed is not enforced.

**Defaulting `allowMutations` to false.** Rejected: the operator of this panel is the user who owns the harness home, the browser session is already authenticated, and every one of these operations is one CLI command away. A default-off panel is a feature nobody finds, and the field exists precisely so a deployment that wants the read-only posture can say so.

**Confirming the toggle as well.** Rejected: enablement is reversible and needs no network, so a confirmation would train the user to dismiss the one that matters. The risk is in the delete.

**Letting the gateway own its own copy of the enablement logic.** Rejected: this package's history is a list of failures caused by one caller recomputing what another had already resolved, and "which rows and entries does this plugin own" is exactly that kind of derived fact. Two faces can be open at once, so the second copy would not stay equal for long.

## Consequences

- The Remote namespace carries writes as well as reads: `marketplace.setEnabled` and `marketplace.uninstall` join `marketplace.status`, and the generated client face carries every method the service publishes.
- The panel can delete files. That is the cost of the feature, and the reason for the acknowledgement gate, the per-card refusal message, and the config flag.
- `marketplace.status` gained three fields it must keep honest: `skillIds`, `skills`, and `allowMutations`.
- `RemoteErrorDetailsMap` gains `marketplace/read-only` and `marketplace/not-installed`, so a refusal reaches the panel as a stable code rather than an untyped failure.
- A deployment wanting the previous posture sets `allowMutations: false`; the panel then explains itself instead of showing controls that would fail.
- Uninstall now removes the parking directory and the earlier plugin-scoped container as well, because a record that is gone can never address those paths again.

## Testing

`tests/gateway.spec.ts` covers the write face: the parking and restoring of skill entries with the status each call returns, a plugin that mounts nothing, uninstall removing content and skills together, the read-only refusal, and the malformed and unknown-plugin refusals. `tests/skills.spec.ts` pins the cleanup split, including that dropping a stale name leaves a disabled plugin's parked copy intact. `tests/components.client.spec.tsx` renders the panel against a driven fixture: that a toggle appears only where something can move, that the panel renders the status the Host returned rather than the click, that uninstall is unavailable until acknowledged, that a refusal lands on its own card, and that a read-only deployment offers no controls at all.
