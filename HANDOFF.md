# Handoff — goal limits work in `ivankwanpn/deepseek-harness`

Written 2026-09-13. Everything below is verified against the repository, not recalled.

## Where things stand

| | |
|---|---|
| Repo | `https://github.com/ivankwanpn/deepseek-harness` (your fork; `upstream` = `deepseek-ai/deepseek-harness` — **never push or PR there**) |
| Branch | `master` |
| Head | `e3aa96c407 docs: carry the goal event lines forward in the producer-consumer graph` |
| Working tree | clean, no unmerged local branches |
| Merged this session | PRs **#6 – #16** |
| Test suites | all green except four pre-existing environmental failures documented below |

The code state travels with `git pull`. **Two things do not travel** and are the first things to restore on a new machine — see "Local-only state" below.

## What the work was

Goal: make a goal's stop condition resource-based instead of a round number the model invents, and give humans control over the limits. Landed as four stacked PRs plus fixes.

### #13 — the deployment owns the continuation round cap

`create_goal` no longer accepts `max_goal_rounds`. `GoalService.create` already resolved `defaultMaxGoalRounds` only for a request that omitted its own cap, so a model that named 14 rounds capped its own goal at 14 regardless of deployment configuration. The parameter is gone; `update_goal` keeps it for the `edit` action, which already requires a direct human message in a runtime-root agent's turn.

Fixtures changed with it: the ACP and headless goal scenarios now take their round cap from the deployment (`snapshots/acp/escalation-approved/cordis.yml`, `apps/cli/tests/profiles/headless/goal-snapshot.patch.yml`) instead of from the recorded model turn.

**This PR also fixed a pre-existing red master.** The two `goal.expected.e2e.ts` tests in the `test:expected` lane were failing on `master` because the ACP goal transcripts had never been re-recorded for the resource budgets (#6). That lane was not run locally before #6 merged, which is how it survived. Also: the ACP goal stdout fixtures baked in a scheduling-dependent `config_option_update`, which is now projected out the same way the shared suite does it.

### #14 — humans set the limits, from Settings and from chat

Two seams, no new syntax.

- The three deployment fields are the `goal` **settings namespace**, registered through `installSection` so the composition entry stays both the base layer and the fallback. `GoalService` holds a configuration source instead of a resolved value and derives the defaults per `create`, so a committed change governs the next goal rather than the next process.
- `ui-goal` contributes a **Goal limits row** to the Web Settings General section over `ctx.settingsScope.bind`. It registers inside a child `ctx.inject(['settingsScope'], …)` with `ctx.slots.inject('settings.general.item', …)`, so a composition without the settings transport or without the General section keeps GoalBar and drops the row.
- The goal prompt section now says which tool carries a human's limit request, which is what makes "ask in chat" work on surfaces with no Settings panel (headless, ACP).

`/goal` deliberately still takes no limit argument: it parses its input locally and calls the goal service directly, so text typed there never reaches a model.

### #15 — rounds are unbounded unless a deployment caps them

`GoalSnapshot.maxGoalRounds` is `number | null`, and `dsh-goal` ships no default cap. One shared rule interprets the null cap — `roundsExhausted` and `roundWithinCap` in `packages/goal/goal/src/domain.ts` — read by the continuation driver, the replay fold, the projection-state schema, and the admitted-round validation. The round prompt renders `Round: 7` while unbounded and `Round: 7/40` under a cap; `/goal` does the same.

Durable format: `goal.maxGoalRounds` moved from the required key set to the optional set and decodes through the same helper as the budgets, so an absent field and an explicit `null` both read as unbounded. **A build predating this refuses a log carrying `null`** — that is the intended one-way boundary.

### #16 — a deployment's budget value is also the maximum

`maxGoalTokens` and `maxGoalWorkMs` replaced `defaultMaxGoalTokens` / `defaultMaxGoalWorkMs`. Each is both the default a create inherits and the most any create or edit may name. `resolveBudget(value, limit, field)` enforces it on both mutation paths; a request over the limit, or asking for `null` while the deployment bounds that budget, is refused with the new code `GOAL_BUDGET_EXCEEDS_LIMIT`.

**The test caught a real defect:** the first version failed on the edit path because `edit` resolved budgets against a `null` limit while `create` used the deployment's. Had the test only covered create, the ceiling would have shipped decorative.

### Reference

Codex v0.149.1's persisted thread goal was the model: `thread_goals` has **no round column** (`token_budget`, `tokens_used`, `time_used_seconds` only), and `[goals] max_goal_token_budget` is documented as "maximum token budget allowed for a goal **and** default budget for new goals". Source read at `D:\agent-complete\codex-rust-v0.149.1` on the old machine — **that checkout will not exist elsewhere**; the relevant paths are `codex-rs/state/src/model/thread_goal.rs`, `codex-rs/config/src/config_toml.rs`, `codex-rs/ext/goal/src/spec.rs`, `codex-rs/ext/goal/src/runtime.rs`.

## Local-only state to recreate on the new machine

### 1. The web profile patch (required for the limits to be non-default)

`~/.dsh/profiles/web/cordis.patch.yml` (i.e. `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` on Windows) is **not repository content**. Without it the deployment ships no limits at all. Current content:

```yaml
- id: goal
  config:
    maxGoalTokens: 400000000
    maxGoalWorkMs: 21600000
```

`defaultMaxGoalRounds` is deliberately absent: goals are unbounded in rounds and stop on work actually spent. Set it only if you also want a meter-free runaway guard. Verify with `pnpm dsh --profile web --dump-config` — the `goal` row must show the patched config and there must be no unmatched-target warning. The web template is `patchReload: live`, so config edits apply without a restart; **code** changes do not.

### 2. The web server must be restarted for host-side changes

The running server on the old machine was started before this work (pid at 19:50, `node --import tsx/esm apps/cli/src/bin.ts web`). It live-reloads *configuration* but not *modules*, so the Settings row rendered with empty fields: the `goal` settings namespace did not exist in the loaded code. A restart is required after any host-side change; a browser refresh is enough for client-bundle changes.

### 3. The WSL clone used for the Linux snapshot lane

`~/deepseek-harness` in WSL (Ubuntu), left on `master`, clean. It needs Node v22.23.2 via nvm, `bubblewrap`, and `musl-tools` (for `native/system`'s `pnpm build:native`); without them the sandbox backend is unavailable and the lane is not deterministic. Recreate with a fresh clone plus `pnpm install && pnpm build && pnpm build:native`.

## Environment facts worth not rediscovering

- **`test:snapshot` is Linux/macOS only.** `scripts/run-gates.ts` says Linux owns required lint and snapshots; Windows omits those. On Windows the lane fails with `unknown tool "bash"` (97/133) — that is the lane policy, not a defect.
- **`test:expected` is a different lane from `test:snapshot`.** `test:snapshot` covers `snapshots/**`; `test:expected` covers `apps/cli/tests/profiles/**`. Master was red in the second one across several merges because only the first was being run. Run both.
- **Four `headless.expected.e2e.ts` tests fail on this host and on master alike** — `ENOENT … scandir …/.sessions` and `Agent Teams snapshot did not persist its Lead`. Environmental; not caused by this work. Baseline any doubtful expected-lane result with a stashed clean `master`.
- **`writer*.expected.jsonl` refreshes are wall-clock churn.** The replay records `time`/`dt` from the running clock, so a refresh rewrites values the comparison already normalizes. **Never commit them** — revert after every refresh. (Two slipped into #13 before this was clear; harmless but noise.)
- **Generated artifacts are freshness-gated and `test:docs` does not cover them.** `pnpm run doc-sync` (34 gates) does. Regenerate with `gen-tool-catalog`, `gen-config-catalog`, `gen-cordis-catalog`, `gen-doc-graphs`, `gen-client-catalog`. Editing a type in `packages/**/src` also shifts line numbers cited in `docs/config-catalog.md`, `docs/event-producer-consumer.md`, and `packages/extensions/tool-cordis/src/api-catalog.ts`.
- **`docs/subsystems/*.md` `ts type-equiv` blocks are verified against source.** Changing a documented type without updating the block fails `verify-type-equiv`. Same for the `.zh.md` pair, where code blocks stay in English.
- **Bilingual pairs are hash-recorded.** After editing either side, run `pnpm run verify-translation-pairing --write <english-path>`. The gate also requires link targets to match between the pair; translated READMEs use an explicit `<a id="english-anchor"></a>` before a translated heading.
- **Agent Notes are mandatory for non-trivial changes** — `.agents/notes/implemented/<kind>/YYYY-MM-DD-slug.md` plus `.zh.md` plus a recorded `.i18n.yaml`. Four were added this session: `2026-09-13-deployment-owned-goal-round-cap`, `…-human-owned-goal-limits`, `…-unbounded-goal-rounds`, `…-goal-budget-ceiling`, and `…-acp-snapshot-topology-notifications` (updated).
- **Coverage is per-file 100%.** A scoped `vitest run --coverage <paths>` reports thousands of threshold errors for files the run never touched; judge it only by whether your files appear in an `ERROR:` line.
- **`git push` from inside WSL hangs.** Kill the orphaned WSL-side processes and transfer commits with `git format-patch` / `git diff > patch` plus `git apply` on the Windows side. Compare `git show -s --format=%T HEAD` on both sides to prove the trees match.
- **`gh pr create` and `gh stack` do not work on this repo** (`GraphQL: Pull requests are disabled`). Use `gh api repos/ivankwanpn/deepseek-harness/pulls --method POST --input body.json` and `PUT …/pulls/N/merge -f merge_method=merge`. `gh stack` is not installed.
- **Do not `git add -A`** in this repo; stage explicit paths. A stray commit-message file reached master that way once (#12).
- **Do not run a command that changes the working tree in the background while continuing to edit files.** A background `git checkout master` for a baseline silently moved six README edits onto the wrong tree; they were recovered from a saved patch, but it cost an hour.

## Verification commands that matter

```sh
pnpm run lint          # oxlint, must be 0 warnings 0 errors
pnpm run typecheck     # tsc -b, several compiler faces
pnpm run test:docs     # 16 quick doc gates (does NOT cover generated artifacts)
pnpm run doc-sync      # 34 gates — the one that covers generated artifacts
pnpm exec vitest run packages/goal packages/client/ui-goal
pnpm exec vitest run --coverage packages/goal packages/client/ui-goal
# Linux lane, from the WSL clone:
pnpm run test:snapshot          # read-only
pnpm run test:snapshot:refresh  # writes goldens; revert writer*.expected.jsonl afterwards
pnpm run test:expected          # apps/cli lane
DSH_SNAPSHOT=replay pnpm run test:web:built   # Web lane; red on Windows (53 tests / 24 files on master too)
```

## Open items

1. **Restart the web server** on whichever machine runs the GUI so the host-side changes load. Expected Settings → General → Goal limits values afterwards: round limit empty (unbounded), token budget `400000000`, active work `21600000`.
2. **The token budget is a real ceiling now.** A goal that reaches 400M tokens stops with code `budget-limit`. The largest observed single goal spend this session was ~142M tokens, so the guard is close enough to matter — raise it if a legitimate goal ever hits it.
3. **Codex parity gaps not yet addressed.** Codex's model-facing surface is narrower than ours in ways nobody has decided about: its `update_goal` sets only `complete`/`blocked` (the model cannot pause, resume, or edit an objective); `create_goal` is allowed only on explicit request, never inferred; and it distinguishes `usage_limited` (account/provider quota) from `budget_limited` (the goal's own token budget) where DSH has only the latter. None of these is a defect — they are open design questions.
4. **`maxGoalRounds` is still a required column in the durable payload** whenever a goal has `null`. A build predating #15 refuses such a log. If that ever needs to be readable by older builds, it is a migration, not a relaxation.
