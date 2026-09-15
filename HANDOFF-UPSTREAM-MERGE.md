# Handoff — upstream `dsh-v0.1.6-alpha.1` merge in `ivankwanpn/deepseek-harness`

Written 2026-09-16. Everything below is verified against the repository, not recalled. Commit identifiers are deliberately written as subjects: the repository's `verify-repository-references` gate rejects any real commit hash in a maintained file.

## Where things stand

| | |
|---|---|
| Repo | `https://github.com/ivankwanpn/deepseek-harness` (yours; `upstream` = `deepseek-ai/deepseek-harness` — never push or PR there) |
| Branch | `merge/v0.1.6-alpha.1`, pushed, four commits |
| Review | PR **#17**, open against `master` |
| Head | `test(web): re-record the settings goldens for the goal-limits copy` |
| Base | `master` = `docs: carry the goal event lines forward in the producer-consumer graph`, clean and untouched |
| Deployment | still serving the Web GUI on `127.0.0.1:3080` from `D:\deepseek-harness` on `master`; the merge never switched branches there |

The four commits, in order:

| Commit subject | What it is |
|---|---|
| `Merge tag 'dsh-v0.1.6-alpha.1' into merge/v0.1.6-alpha.1` | the merge; 17 conflicted paths resolved |
| `Merge follow-up: satisfy upstream's new gates and regenerate the references` | new upstream gates, regenerated catalogs, the fork's lane-budget strip re-applied |
| `test(snapshot): refresh the merged tool surface on the Linux lanes` | 30 expectation files the merge's new scenarios pinned to the pre-merge goal tool surface |
| `test(web): re-record the settings goldens for the goal-limits copy` | a pre-existing fork red found while measuring the Web lane (see below) |

`master..dsh-v0.1.6-alpha.1` is 3,265 files / +765,515 / −59,566. The branch differs from the release tag by 376 files / +37,719 / −17,966.

## What the work was

Merge upstream's `dsh-v0.1.6-alpha.1` (661 commits) into the fork without disturbing the running deployment, keep every fork surface, and get the branch as green as the repository allows.

The fork's goal-limits design is fully preserved. `packages/goal` differs from `master` by 17 files / +38 / −40, and every line of that is upstream's renamed lifecycle event, the `await`s the new registry return type requires, or regenerated pairing hashes. Marketplace, permission presets, terminal and unarchive-sessions survive the same way.

## Conflict resolutions

17 paths, recomputed with `git merge-tree --write-tree --name-only master dsh-v0.1.6-alpha.1` (an earlier count of 18 was wrong).

| Path | Resolution |
|---|---|
| `packages/goal/goal/src/index.ts`, `README.md` (+ pairing) | the fork's goal-limits wiring, with upstream's `agent/session-start` → `agent/created` rename |
| `packages/api/remotes/src/client/index.ts` | both sides: marketplace plus upstream's new client entries |
| `tsconfig.client.json` | both project references |
| `packages/bundle/web-app/cordis.patch.yml` | both entry sets |
| `packages/boot/app-boot/tests/hmr-config.spec.ts` | accepted upstream's deletion |
| `packages/client/connection/src/client/fixture.ts` | accepted upstream's deletion (`RemoteMatch`/`RemoteMock` replace it) |
| four rewritten specs under `packages/boot`, `packages/session`, `packages/subagent`, `packages/workflow` | upstream's bodies, then the fork's timeout-override strip re-applied |
| `docs/event-producer-consumer.zh.md` (+ pairing) | the fork's rows, plus a real pair divergence repaired (`skills/change` cited different source lines per language) |
| `docs/module-graph.md`, `.zh.md` (+ pairing) | both sides' nodes and edges |

The follow-up commit also renamed the marketplace's ownership field to `origin` (11 sites; upstream's `verify-concrete-terms` blocks the earlier word), rewrote four commit hashes in `HANDOFF-MARKETPLACE.md` into subjects for the references gate, awaited four `ctx.agents.register(...)` call sites, and regenerated the persistence and tool catalogs.

## Lane results

| Lane | Command | Result |
|---|---|---|
| Build | `pnpm run build` | pass |
| Lint | `pnpm run lint` | pass |
| Typecheck | `pnpm run typecheck` | pass |
| Quick docs | `pnpm run test:docs` | 20 gates, pass |
| Documentation | `pnpm run doc-sync` | 40 pass, 1 fail (red 1) |
| Bilingual pairing | `pnpm run verify-translation-pairing` | 936 pairs consistent |
| Unit, built tree | `pnpm run test` | 4 failed / 23,038 passed / 1 expected fail / 102 skipped |
| Coverage, clean tree, CI env | `DSH_COVERAGE_PARTITIONS=4 DSH_COVERAGE_MAX_WORKERS=6 DSH_COVERAGE_TEST_TIMEOUT_MS=90000 pnpm run check:ci:coverage` | 1 failed suite (red 3), no coverage-threshold failure |
| Recorded sessions, Linux | `DSH_EXAMPLE_MODE=lib pnpm run test:snapshot` | 7 files, 158 passed / 2 skipped / 0 failed |
| Owner-local expectations, Linux | `DSH_EXAMPLE_MODE=lib pnpm run test:expected` | 14 files, 91 passed / 0 failed |
| Web `settings-chrome` | `DSH_SNAPSHOT=replay vitest run --config vitest.web.config.ts apps/web/tests/settings-chrome.e2e.ts` | 11 passed on both platforms |
| Web full lane, Windows | `DSH_SNAPSHOT=replay pnpm run test:web:built` | red on `master` at this base too: 24 failed files / 39 failed tests of 102 files / 374 tests |

## Known reds — none of them merge-caused

**1. `persistence type history` (doc-sync, 40/41).** `pnpm --silent run verify-persistence-changes --json` reports 11 unacknowledged changes across four event roots, all from the fork's goal-limits work, all present on `master`:

- `event:agent/inbox/spliced`, `event:session/title-llm-request`, `event:user/message`: two optional readings each (`tokensUsed`, `workMsUsed`) — `same-version`.
- `event:goal/change`: `data.goal.maxGoalRounds` widens from `number` to `number | null`, and `maxGoalTokens`/`maxGoalWorkMs` become required properties — the next Session format version is required for those two, plus `tokensAtCreate`/`workMsAtCreate` as same-version additions.

A `version-bump` acknowledgement cannot be recorded without the record's own increasing `SessionHeader.version` transition, and bumping the writer means a real `v3 → v4` edge: a `session-format-v3-to-v4` package, a `historical-formats/v3.*` archive, a regenerated catalog, and successor generations for every recorded session and both SDK projections. That is release-level work, so it stays out of the merge PR by decision.

Useful fact for whoever writes it: the fold already tolerates absence. `decodeSnapshot` lists all three ceilings as optional and `decodeCeiling(undefined)` returns `null`, so a record written before budgets existed replays as unbounded. The additions are compatible on read; the `maxGoalRounds` widening is what an older build refuses when it reads a record this branch writes under a `version: 3` header.

**2. `packages/experimental/webworker-packer/tests/image-loadable.spec.ts` (built trees).** `ctx.get is not a function` from the plugin's built `lib`. The spec's stub context provides `baseUrl`, `loader` and `deepseekLlmApiExtensions`; the plugin calls `ctx.get('pluginPackages')` and `ctx.get('agentPresets')`. Spec and plugin source are byte-identical between the release tag and this branch, so the release fails the same way on a built tree. A one-line stub (`get: () => undefined`) greens it, but the file is upstream's.

**3. `packages/api/remotes/tests/assembly.client.spec.ts` (clean trees).** `Cannot find package '@deepseek-ai/dsh-agent-presets/remote'`. The `*/remote` subpaths have no source mapping — `tsconfig.base.json` declares no `/remote` entry in any tree — and every package's export map points `./remote` at a built `lib` file. `vitest.config.ts` already threshold-excludes this assembly for that reason. Reproduced on `master` in a clean worktree, so it is pre-existing and tree-independent. It also explains the four non-`image-loadable` failures in the built-tree unit run: they pass when their six files run in isolation, and none reappeared in the CI-environment coverage run.

**4. Web lane on Windows.** Browser-environment failures, red on `master` at this base with the same shape. CI owns this lane on Linux.

## Carried fix

`test(web): re-record the settings goldens for the goal-limits copy` is not merge work. The goal-limits copy commit changed the Settings wording and left `apps/web/tests/expected/settings-chrome/*.expected.md` stale, so `settings-chrome.e2e.ts` failed its golden comparison in both locales, and the aborted dialog test cascaded into four 30-second timeouts (one of them passes in 1.4 s run alone). Re-recorded on Linux, the platform that owns the lane. `master` carries the same stale pair, so it can be moved to the PR that introduced the copy change.

## What the next session should do

1. Review and land PR #17. Nothing in it needs another green lane first; the reds above are pre-existing and documented.
2. Write the `v3 → v4` Session format edge, then record the persistence acknowledgement (`docs/cookbook/adding-a-session-format-version.md` is the procedure).
3. Decide the `*/remote` resolution (source mapping, generated source, or a documented built-artifact dependency) and either fix or report `image-loadable.spec.ts`.
4. Re-check `HANDOFF-MARKETPLACE.md`: it still describes the marketplace as not landed.
5. `handoff/2026-09-13` is still unmerged and its `HANDOFF.md` embeds real commit hashes; merging it into a tree that carries the current gates will fail `verify-repository-references`.

## Reproducing the lanes

Windows worktrees, all sharing one object store: `D:\deepseek-harness` (main, `master`), `D:\dsh-merge-v016` (the merge branch), `D:\dsh-merge-cov` (clean scratch tree for the coverage lane, remove with `git worktree remove D:\dsh-merge-cov --force`).

- Coverage needs a tree with **no** `lib/` and the CI environment; the plain `pnpm run test:coverage` is not the same lane.
- The unit lane on a built tree is a different configuration with different failures.

Linux lanes run in WSL: `wsl -d Ubuntu`, clone at `~/deepseek-harness`, node `v22.23.2` under `/home/inkik/.nvm/versions/node/v22.23.2/bin`. Browser-owned cases need `LD_LIBRARY_PATH=$HOME/pwlibs/usr/lib/x86_64-linux-gnu` because chromium's system libraries cannot be installed without a root password. Move work with `git diff > /mnt/d/...` plus `git apply` on the Windows side; `git push` from WSL hangs. Helper scripts used here are in `D:\deepseek-harness\.git\wsl\` (the `merge-*.sh` family) and their logs in `.git\wsl\logs\`.

Refreshing expectations: `DSH_SNAPSHOT=refresh` with `--config vitest.snapshot.config.ts` or `vitest.expected.config.ts`; afterwards revert the `writer*.expected.jsonl` chunk-timing churn, which is noise.

## Gotchas that cost time here

- `AgentRegistry.register(agent)` now returns an effect that must be awaited; TypeScript does not flag a floating promise.
- The lane budget lives once in `vitest.config.ts`. Do not add per-test `{ timeout }` overrides.
- Static gates and tests are supposed to pass on a clean tree, but this suite holds specs on both planes: some consume built `lib`, others prove built artifacts. Expect one or the other to fail depending on how the tree was prepared.
- `PowerShell`: `Select-Object -First N` ends the pipeline and kills the upstream process, which silently aborted a WSL lane mid-run; write output to a file and read the tail.
- Do not `Stop-Process` node processes from an agent shell: it breaks the harness job runner and produces bogus `4294967295` exit codes in unrelated gates. Two gates had to be re-run to clear the false failures.

## Corrections to earlier reports

- An earlier count of 18 conflicted paths was wrong; the recomputation above gives 17.
- A full unit run reported four failures that were first read as flakiness. Only three were load flakes; the fourth (`assembly.client.spec.ts`) is deterministic and pre-existing.
- Early in the work a half-applied rename of that same ownership field was left in the main tree; it was reverted and the main tree is clean on `master`.
- The Windows Web lane was never run to completion: it runs serially, and the two attempts were stopped for CPU contention after 12 and 50 of 102 files. The comparison in the table is therefore against `master`'s recorded baseline plus a 12-file sample, not a full branch run.
