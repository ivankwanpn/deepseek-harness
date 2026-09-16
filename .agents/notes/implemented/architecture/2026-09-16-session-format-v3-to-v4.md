# Agent Note: Session format v4 carries the goal-limits payload change

Status: implemented

English | [中文](2026-09-16-session-format-v3-to-v4.zh.md)

## Problem

The goal-limits work changed the durable shape of a goal change payload while the checkout still wrote Session format 3, and the latest released format was also 3. `pnpm run verify-persistence-changes` therefore refused to acknowledge the change and `doc-sync` stayed at 40/41:

- `event:goal/change.data.goal.maxGoalRounds` — the declared type widened from `number` to `number | null` (unbounded continuation).
- `event:goal/change.data.goal.maxGoalTokens` and `maxGoalWorkMs` — required properties added; they replaced the two default-only fields and now bound every create and edit.

Eight further changes were same-version additions that need no edge: `tokensUsed` and `workMsUsed` on the message sources of `agent/inbox/spliced`, `session/title-llm-request`, and `user/message`, plus `tokensAtCreate` and `workMsAtCreate` on `goal/change`. The writer bump moved `SessionHeader.version` as a further detected change.

The runtime already read the new shape tolerantly — the goal fold admits the three ceilings as optional and `decodeCeiling(undefined)` returns `null`, so a record written before budgets existed replays as unbounded. What was missing was the durable declaration: without an adjacent edge, a build predating the change refuses a format-3 record whose `maxGoalRounds` is `null`, and the persistence gate has no version transition to acknowledge.

## Decision

Session format v4 is the goal-limits payload as the current writer emits it; v3 keeps its released meaning. The adjacent edge **v3 → v4** materializes the ceilings, and the writer, the catalog, and every consumer that means "current" ship at v4.

### Transformation rules

Only `event:goal/change` events that carry a `data.goal` snapshot are transformed. For each of `maxGoalRounds`, `maxGoalTokens`, and `maxGoalWorkMs`:

- an absent field materializes as explicit `null` (unbounded, exactly what the tolerant decode already returns);
- a present numeric value is preserved unchanged.

`tokensAtCreate` and `workMsAtCreate` stay absent when absent: they are optional, and their absence means the record claims no usage baseline. Goal clear tombstones, unrelated Session events, and every other event type pass through unchanged.

The edge is lossless with respect to replay: a v3 record migrated to v4 carries the same meaning it already had when read by the tolerant decoder. The difference is that a v4 record states its ceilings explicitly instead of relying on absence.

### Packages and wiring

- The edge ships in `packages/session/session-format-v3-to-v4` following the `session-format-v2-to-v3` layout: the v4 codec, a stateful Stage migration (`transformEvent`, `transformRun`, `finish`), the target-header validator, and the target restorer.
- The edge declares `dsh.sessionFormatMigration` with numeric `from: 3`, `to: 4`, and **reuses** the v3 codec exported by `session-format-v2-to-v3`; it does not redefine a released codec.
- `SESSION_FORMAT_VERSION` moved from 3 to 4 in the core Session types alongside the declarations, and `pnpm run gen-session-format-catalog` regenerated the catalog. The generated file is never hand-edited.
- Before the writer changed, the archive command froze the complete v3 persistence schema as the bilingual `docs/persistence-changes/historical-formats/v3.*` reference, so every integer below the writer keeps its own document.

### Current-version consumers

Every consumer that means "current" reads `SESSION_FORMAT_VERSION`: Session creation and restoration, JSONL filename selection and publication, the catalog's current encoder and restorer, replay and snapshot normalization, and both SDK smoke mirrors. Literal historical versions stay in released codecs and historical fixtures, and persistence tests pin the current generation through the constant instead of a literal. The projection cache keeps binding its fold to the Session header's own version. Read paths keep their existing behavior: header-only listing reads no bodies, a historical read may return the migrated in-memory artifact without publishing, and a write publishes only the final current successor.

### Snapshot successors and SDK projections

Each historical snapshot keeps its file and gains a v4 successor generated from the target version's canonical filenames; predecessors stay byte-identical and parent/child roles stay contiguous. Both SDK projections re-record for the new generation. The Linux lane that produces this evidence also updates the snapshot corpus policy for the current generation, keeping direct-edge, multi-hop, packed-row, retry/failure, and shipped-profile coverage.

## Alternatives considered

**Identity conversion (re-stamp the version, touch nothing).** The cookbook treats an identity body conversion as an initial wiring scaffold, not a migration. It would also leave v4 records able to omit the ceilings their own type declares required, which is the drift the bump exists to end.

**Declare the three ceilings optional in `GoalSnapshot` to avoid the bump.** The gate treats a required property addition as version-bump work because the type mirrors what the writer emits, and the writer does emit all three fields on every non-clear mutation. Declaring them optional would understate the durable payload to silence a gate.

**Keep `maxGoalRounds: number` and encode unbounded as a sentinel.** A sentinel such as `0` re-introduces the ambiguity the nullable type removed, and it does nothing about the two required additions, which trigger the bump on their own.

**Fold the eight optional additions into v4 as well.** They are admissible in the current version, and admitting them in v4 would imply the edge normalizes the message-source shape, which nothing requires. They are acknowledged as same-version changes instead.

## Verification

- `pnpm run verify-persistence-changes` records the v3 → v4 transition and passes with every detected change acknowledged, including the `SessionHeader.version` transition.
- Focused tests cover the direct v3 → v4 edge; seeded multi-hop restoration from v0, v1, and v2 through v4; malformed and unknown-required-event refusal; deterministic repeated restores; independent concurrent stage state; seeded multi-hop inherited cuts; unchanged predecessors; and no fallback to a predecessor.
- `pnpm run verify-session-format-catalog` and the cookbook's focused Vitest baseline pass with the new edge's test path included; `pnpm run test:docs`, `pnpm run doc-sync`, and `pnpm run lint` pass.
- `docs/persistence-changes/historical-formats/v3.md` and `.zh.md` exist and the format coverage check passes for every integer below the writer.
- The [owning note](2026-08-31-released-session-format-migrations.md) is updated rather than duplicated; the bilingual pairing is re-recorded.
- The Linux lanes `pnpm run test:snapshot` (including the corpus) and `pnpm run test:expected` produce the successor and SDK-recording evidence; the Windows checkout cannot run them, so they are the edge's remaining release evidence.

## Consequences

The bump ends the drift between the declared durable payload and the written one: a v4 record states its ceilings explicitly, an older build refuses it instead of misreading absence, and the persistence gate acknowledges the transition.

- **One-way boundary.** A build predating v4 refuses a v4 record, and the fork's pre-bump writer already produced v3-header records carrying `null`. Interim files written during development carry the target writer version and will not migrate again, so integration testing must run from unchanged historical input in disposable homes.
- **Successor generation is not a rename.** A predecessor renamed to the target filename, or a packer-style rewrite used as an upgrader, corrupts the generation chain; the cookbook's snapshot rules are load-bearing.
- **The Windows checkout cannot produce the snapshot evidence.** Stages 5 and 6 depend on a Linux environment; on Windows the lane fails by policy, so the work is only complete once the Linux lanes have actually run.
- **A migration that normalizes too much.** Materializing the ceilings must not touch other payload members; an over-broad stage would rewrite unrelated goal changes and make the edge's admission rules untestable.
