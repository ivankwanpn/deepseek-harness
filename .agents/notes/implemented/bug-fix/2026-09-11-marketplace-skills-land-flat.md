# Agent Note: Marketplace skills land flat in the discovery root

Status: implemented

English | [中文](2026-09-11-marketplace-skills-land-flat.zh.md)

## Problem

The marketplace copied a plugin's `skills/` subtree into a plugin-scoped directory, `<root>/<plugin>/`. `skill-filesystem` reads exactly one level — `<root>/<name>/SKILL.md` or `<root>/<name>.md` — so the materialized files sat one directory deeper than anything discovers. A skills-only plugin therefore installed "successfully": `install` printed the pinned commit, the state recorded the `skills` capability, and the settings panel listed the plugin as installed, while the model was offered none of its skills. Nothing failed, and nothing reported a problem.

Uninstall had the mirror gap. Materialized skills live in the shared root by design, not under `installPath`, and `uninstallPlugin` deleted only the plugin directory and the record — so a removed plugin kept being offered to the model with no record left to explain where those files came from.

## Decision

A plugin's `skills/` children are materialized FLAT: each child becomes one entry directly under the discovery root, and only in a form discovery reads.

- **Discoverability decides what is copied.** A child directory must hold `SKILL.md` at its top level; a child file must be Markdown. Anything else is reported and skipped rather than copied into a root where it would be invisible.
- **Ownership is recorded, not recomputed.** The state entry carries `skillIds`, the discovery-root entry names the plugin owns, mirroring `rowIds`. One plugin contributes several entries, and which ones is not a function of the plugin name.
- **One verb, both layouts.** `disable` parks each owned entry under `<root>/.disabled/<plugin>/`; `enable` moves them back; uninstall removes them live and parked, together with the plugin-scoped container an earlier build wrote.
- **The flat root makes duplicate names a real conflict.** The first entry in state order keeps the name; a later plugin claiming it is reported and materializes nothing under it, so neither plugin can replace the other's skill or delete it on uninstall.
- **A record written before `skillIds` existed still works.** Enable, disable and uninstall recover the names from the plugin directory while it is still there, and the next sync persists them.

## Alternatives considered

**Teach `skill-filesystem` to read one level deeper.** Rejected: that provider also serves project and user roots that have nothing to do with the marketplace, and a second level would read every subdirectory of a skill as a skill candidate — `brainstorming/scripts` and `brainstorming/assets` in the plugin that exposed this bug. Widening a shared scanner to fix one writer's layout moves the defect rather than removing it.

**Synthesize one Markdown file per skill under a plugin-scoped directory (`<root>/<plugin>/<skill>.md`).** Rejected: it is the flat shape expressed through a rewrite of the plugin's content. A skill directory holds sibling resources its body refers to by relative path, so flattening it into a single file loses exactly the material that makes the skill usable.

**Recompute the owned names from the plugin directory at enable and uninstall time instead of recording them.** Rejected: it contradicts the ownership rule this package already established for `rowIds`, and it fails in the two cases that matter — content that changed on disk since the last sync, and uninstall, where the names must be read before the directory they come from is deleted.

**Report a duplicate skill name but let the later plugin overwrite it.** Rejected: the overwrite is silent, and whichever plugin is uninstalled first then deletes content the other still claims.

## Consequences

Skills now reach the model, and enable, disable and uninstall address exactly what was materialized. The two silent failures become reported ones: a `skills/` child discovery cannot read is named at sync time, and a duplicate entry name names both plugins.

The cost is that the discovery root is no longer one directory per plugin. Uninstall is N removals addressed by the record rather than a single `rm`, and it now deletes outside `installPath`, so a filesystem failure there is no longer masked by a successful-looking command. The state file gains an optional `skillIds` field, which older records omit and the next sync fills in.

## Testing

`tests/skills.spec.ts` mounts the real `dsh-skill` registry and `dsh-skill-filesystem` provider over the materialized root and asserts on what the provider discovered, rather than restating the layout rule as a path literal that could drift from it. The materialization assertion was confirmed to fail against the plugin-scoped copy; no assertion about the destination directory alone would have caught it.
