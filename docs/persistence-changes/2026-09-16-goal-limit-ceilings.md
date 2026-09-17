---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-09-16-goal-limit-ceilings

English | [中文](2026-09-16-goal-limit-ceilings.zh.md)

## Summary

Bump the Session format to v4: a `goal/change` snapshot states its three continuation ceilings explicitly, and the optional usage fields on message sources and goal changes are acknowledged in the same record.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-09-16-goal-limit-ceilings
baseline: false
changes:
  - root: "SessionHeader"
    previous: "2026-09-11-initial"
    after: "1a3440e3577382704d42a6263aa463504eb74c566734a55e9503a63efcd02445"
    decision: version-bump
  - root: "event:agent/inbox/spliced"
    previous: "2026-09-14-image-offload"
    after: "68d464aa2a05151ea659d382a7d62fa6b893231668ed95f9146fd9f39eda3328"
    decision: version-bump
  - root: "event:goal/change"
    previous: "2026-09-11-initial"
    after: "91b1959f77647fbd930d89a8e01413a241d5f46ce5b4353ee2bb2407b6d1649f"
    decision: version-bump
  - root: "event:session/title-llm-request"
    previous: "2026-09-14-image-offload"
    after: "813ba0eec41b0d095cf0e7457cc3137c2c98e4d015a0eb2b62543d0da5e9f718"
    decision: version-bump
  - root: "event:user/message"
    previous: "2026-09-14-image-offload"
    after: "9754c81e96a39c602f3dd717e5bcbc01a5153a2f7dd39ebcd0df9d899fdbeaff"
    decision: version-bump
```

<a id="compatibility"></a>
## Compatibility

`event:goal/change` requires the version bump: `data.goal.maxGoalRounds` widens from `number` to `number | null`, while `data.goal.maxGoalTokens` and `data.goal.maxGoalWorkMs` become required properties that every non-clear mutation already writes. The same record carries the increasing `SessionHeader.version` transition implemented by the adjacent migration `@deepseek-ai/dsh-session-format-v3-to-v4`. A v3 record could omit a ceiling and an absent field already meant an unbounded budget — the tolerant goal fold decodes a missing ceiling as `null` — so absence and `null` state the same unbounded ceiling, and migrating is lossless with respect to replay.

The edge rewrites only a `goal/change` that carries a `data.goal` snapshot: each absent ceiling materializes as an explicit `null`, a present numeric value is preserved unchanged, `tokensAtCreate` and `workMsAtCreate` stay as recorded, goal-clear tombstones and unrelated events pass through, and the header is re-stamped to version 4. The remaining detected additions are optional properties the fixed rules admit in the same version: `tokensUsed` and `workMsUsed` on the `agent/inbox/spliced`, `session/title-llm-request`, and `user/message` message sources, plus `tokensAtCreate` and `workMsAtCreate` on `goal/change`. Older records omit them, and a reader that does not know them ignores them without changing replay, so they need no conversion; the inferred decision is the bump the goal payload and the header transition require, and it declares every changed root under that one transition. A build predating v4 refuses a v4 record rather than guessing it.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-format-v3-to-v4 — 3 test files passed, 14 tests passed. `tests/migration.spec.ts` covers an absent ceiling materializing as an explicit `null` while a present numeric value survives unchanged; `tests/chain.spec.ts` covers a seeded v0 goal change through every adjacent edge to v4, identical repeated restores, concurrent stage independence, refusals of malformed payloads and unknown required events, and no fallback to a predecessor once a v4 record exists. `pnpm --silent run verify-persistence-changes --json` reports ok, with every detected change acknowledged.

<a id="dev-note"></a>
## Dev Note

None.
