# Agent Note: The write face's bookkeeping now survives the operation that removes what it describes

Status: implemented

English | [中文](2026-09-12-marketplace-write-face-bookkeeping.zh.md)

## Problem

Four defects, each measured against the shipped code before it was fixed. They share one shape: something an earlier step recorded stopped matching what a later step could see.

**A row outlived its plugin.** `composePatchLayer` decided ownership from the *desired* rows, so a row the marketplace had inserted for a plugin that was later uninstalled appeared in none of them and was kept. `uninstallPlugin` removed the record and the content, and the loader went on mounting an `mcp-client` whose plugin was gone. The function's own header claimed it dropped "our own previously-inserted rows", and a loop that did nothing sat where that was meant to happen.

**A rename was recorded under the alias.** `resolveEntry` follows a marketplace's published `renames` table and reports `renamedFrom`, but `installPlugin` then wrote the record with the name the caller had typed — for the record's `plugin`, its `id`, the content directory, and twice in the notice (`"previous was renamed to previous"`). The catalog marks an entry installed by the name the manifest lists, so a renamed install showed as not installed and a second install duplicated it.

**A capability could never match.** `detectCapabilities`, which the install records with, reports a capability when its carrier file exists. The comparison a sync runs built its own list and counted `mcp` only when at least one server was usable, so a `.mcp.json` declaring nothing mountable announced "capabilities changed on disk since install (recorded mcp, found none)" on every sync forever. The same class had already been fixed once for `commands/` by adding another hand-written clause.

**`add` let a failure escape.** Every other write path reports a failed subprocess as a diagnostic and exits 1; `marketplace add` awaited its fetch outside any `try`, so a mistyped registry reached `bin.ts`'s `process.exit(await …)` as an unhandled rejection instead of a one-line message. Its own spec pinned the rejection rather than the requirement.

## Decision

- **Ownership is the id namespace, not the desired set.** `state.ts` exports `isManagedRowId`, and `composePatchLayer` drops any row carrying it that is not currently desired — including one whose plugin is gone — while a foreign row under our id and mount still survives untouched. The header's ownership table now splits EXISTENCE (the state file) from PROVENANCE (the namespace), because a row whose record went with its plugin is named by neither the desired set nor a state record.
- **An install is identified by the name the marketplace lists.** `installPlugin` derives one `name` from the resolved entry and uses it for the record, its row id, the content directory and every message; `renamedFrom` is reported once, in the notice.
- **The capability comparison reads through one probe.** `materializeEntry` calls `detectCapabilities` — the function the install recorded with — instead of assembling the same three capabilities by hand with a different rule for one of them. The dead `isDirectory` helper and the hand-written clauses are gone.
- **Every facing command reports its failures.** `add` wraps its fetch and registration, and both catches share one `failureText` helper, so the coercion from an `unknown` throw exists once.

## Alternatives considered

**Recording the desired ids on the state so sync can identify stale rows.** Rejected: the ids of an uninstalled plugin are exactly what `removeInstalled` drops, so the caller would have to thread them through `SyncOptions` and remember to — and the namespace already answers the question from the layer alone.

**Keeping the alias in the record and matching either name in the catalog.** Rejected: two names for one installed plugin is the state this defect produced. The manifest's name is what every other surface already keys on.

**Leaving `marketplace-command`'s two catches as they were.** Rejected: the second one made the `String(error)` arm an uncovered branch. Reading through one helper both removes the duplicate expression and keeps the arm covered by the existing non-Error test.

## Consequences

- Uninstalling a plugin removes its loader rows, so a deployment stops mounting a client for content that is gone.
- An install that followed a rename is addressable by the marketplace's name everywhere: the catalog marker, the panel, enablement, and uninstall. Uninstalling by the retired alias reports it as not installed, which the README records as a limitation, and `install` reports the rename when it follows one.
- A `.mcp.json` that declares nothing mountable no longer announces a capability change on every sync. It still reports the unusable server, which is a separate and accurate warning.
- `marketplace add` prints `dsh: <reason>` and exits 1 for a registry it cannot fetch.
- `isManagedRowId` and `mcpRowId` join `rowIdFor` as the package's row-id vocabulary; `materialize` and `gateway` build an MCP row id through the same function instead of spelling the prefix themselves.

## Testing

Each fix was reproduced before it was made. `install-paths.spec.ts` installs an MCP-shipping plugin through a real reconcile, asserts the row is present, uninstalls, and asserts it is gone — that case failed with `expected true to be false` against the shipped code. The rename case failed with `expected [ 'previous was renamed to previous' ] to include 'previous was renamed to renamed'` against the reverted install. `materialize.spec.ts` failed with the spurious capability warning. `command-surface.spec.ts` failed with the escaping `MarketplaceFetchError`. The package stays at 100% per file for statements, branches, functions and lines.
