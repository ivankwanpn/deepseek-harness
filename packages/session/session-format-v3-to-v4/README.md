---
description: "Adjacent Session format migration from v3 to v4: goal change payloads carry explicit maxGoalRounds, maxGoalTokens, and maxGoalWorkMs ceilings, and nothing else changes."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v3-to-v4

English | [中文](README.zh.md)

## Summary

Restore released V3 Sessions as V4 by stating the goal-limit ceilings a goal change already implies. The edge reuses the released V3 physical framing, re-stamped to version 4; only `goal/change` payloads carrying a `data.goal` snapshot change, and an absent `maxGoalRounds`, `maxGoalTokens`, or `maxGoalWorkMs` becomes an explicit `null` unbounded ceiling. Everything else passes through unchanged. Persistence consumes the edge through the static catalog; the library reads and publishes no files.

## Table of Contents

- [Use this package](#use-this-package)
- [V3-to-V4 specification](#v3-to-v4-specification)
  - [Goal change payloads](#goal-change-payloads)
  - [Framing, admission, and preservation](#framing-admission-and-preservation)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

### When to use it

Use the [catalog](../session-format-catalog/README.md) to restore a Session. Direct imports serve catalog assembly and tests; this library has no Cordis mount configuration. The [public exports](src/index.ts) provide the released V4 codec, the target header validator, and the target restorer. The adjacent migration is declared by this package's `dsh.sessionFormatMigration` manifest entry and reaches callers through the generated catalog.

### Entry point

The header-only operation does not convert or validate an event body:

```text
const targetHeader = sessionFormatV3ToV4.migrateHeader(sourceHeader)
```

Full restoration decodes physical rows through [the v4 codec](src/codec.ts) and compiles the adjacent chain; callers must not treat partial stage emissions as a successful restore, because a refusal can surface at a later event or at finish. The [format protocol](../session-format/README.md) owns chain scheduling and catalog error handling; the [v2-to-v3 edge](../session-format-v2-to-v3/README.md) owns the released V3 rules this edge reuses.

-----

<a id="v3-to-v4-specification"></a>
## V3-to-V4 specification

The edge is deliberately narrow. V4 admits exactly the goal payload shape the current writer already emits; no other event, envelope, or header rule moves. A migrated record is lossless with respect to current replay, because the tolerant decoder already reads an absent ceiling as unbounded, and what the edge adds is the durable statement of that ceiling.

<a id="goal-change-payloads"></a>
### Goal change payloads

Only `event:goal/change` events that carry a `data.goal` snapshot are transformed. For each of `maxGoalRounds`, `maxGoalTokens`, and `maxGoalWorkMs`:

- an absent field materializes as explicit `null`, meaning unbounded;
- a present numeric value is preserved unchanged.

`tokensAtCreate` and `workMsAtCreate` stay absent when absent: they are optional, and their absence claims no usage baseline. Goal clear tombstones, unrelated Session events, and every other event type pass through unchanged.

<a id="framing-admission-and-preservation"></a>
### Framing, admission, and preservation

V4 adds no envelope admission rule beyond V3. [The codec](src/codec.ts) is the released V3 physical codec with the header version re-stamped on both sides, and [the restorer](src/validation.ts) delegates the released V3 relationship rules; no released codec is redefined. Migration classifies and refuses unknown required events exactly as V3 admission does, so a log this edge cannot vouch for is refused rather than guessed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The codec](src/codec.ts) presents each v4 physical header to the released V3 codec as a v3 header, so framing, recovery, and inherited-cut derivation stay frozen. [The restorer](src/validation.ts) re-validates the v4 header, then runs the released V3 relationship validation against a private v3 view and returns the original artifact. The manifest edge entry names the migration, the source and target codecs, the target header validator, and the target restorer; [the catalog generator](../../../scripts/gen-session-format-catalog.ts) is the only consumer and refuses any mismatch. No runtime invariant companion is published because this library owns no independently observable registrations or state replicas.

[The codec test](tests/codec.spec.ts) pins header acceptance and the version round trip.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Released V2 to V3](../session-format-v2-to-v3/README.md) — frozen preceding edge and the released V3 codec this package reuses.
- [Adding a Session format version](../../../docs/cookbook/adding-a-session-format-version.md) — the release sequence every adjacent edge follows.
- [The v3-to-v4 design note](../../../.agents/notes/implemented/architecture/2026-09-16-session-format-v3-to-v4.md) — the goal-limit payload change and how it shipped.

-----

<a id="model-experience"></a>
## Model Experience

### Goal-limit payload restoration

#### What the model sees

Restored `goal/change` events keep every recorded snapshot field, and the three ceilings (`maxGoalRounds`, `maxGoalTokens`, `maxGoalWorkMs`) become explicit, so a goal change read from a migrated record states the same continuation budget the tolerant decoder already applied. The edge registers no tool, prompt section, or model-visible text of its own.

#### Token effect

The edge adds no model-visible text and changes no request assembly; the ceilings it materializes bound goal continuation budgets, they do not change a prompt.

#### KV Cache effect

The edge preserves historical request meaning and model configuration; it does not guarantee provider cache hits or byte-identical recordings.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One-way boundary** — a build predating v4 refuses a v4 record, and persistence publishes only the current successor; superseded generations are never rewritten. The [format release status](../../../docs/session-format-status.md) owns the current generation.
- **Payload scope** — only goal change snapshots carrying a `data.goal` are normalized; the same-version message-source and usage-baseline additions stay exactly as recorded.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
