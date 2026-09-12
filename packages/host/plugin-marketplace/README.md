---
description: "Install and enable Claude-ecosystem marketplace plugins by parsing the marketplace manifest, fetching a plugin at its pinned commit, and reconciling it into the user patch layer and the skills discovery root."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-plugin-marketplace

English | [中文](README.zh.md)

## Summary

Parses a Claude-compatible `marketplace.json`, browses what the registered marketplaces offer, installs one plugin at its pinned commit, and reconciles it into DSH without teaching the core the external schema: every skill a plugin ships is materialized FLAT into the discovery root, and each `.mcp.json` server becomes one loader row. Enablement is one verb over two mechanisms: a row's `disabled` flag and moving skills out of discovery. Every write is limited to entries the marketplace owns, so user patches and skills are never rewritten; the CLI and the Web settings panel share that implementation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Call this package when a user asks DSH to install something from a plugin marketplace. The CLI face is `dsh plugin marketplace <add|list|search|install|uninstall|installed|enable|disable>`; the programmatic face is `catalog`, `installPlugin`, `sync`, and `setEnabled`; the Remote face is `MarketplaceGateway`, whose `marketplace.status` and `marketplace.catalog` reads and `marketplace.install` / `marketplace.setEnabled` / `marketplace.uninstall` writes back the Web settings panel.

```ts
import { defaultStatePath, installPlugin, loadState } from '@deepseek-ai/dsh-host-plugin-marketplace'

const harnessHome = '/home/user/.dsh'
const patchLayerPath = `${harnessHome}/cordis.patch.yml`
const statePath = defaultStatePath(harnessHome)
const result = await installPlugin('aikido', {
  state: loadState(statePath),
  statePath,
  sync: { patchLayerPath, materialize: { harnessHome } },
})
```

### What an install produces

- **skills** are copied into the agents skills root, each one directly under it, which is the only depth `skill-filesystem` reads. Discovery is dynamic, so they are live without a restart.
- **MCP servers** each become one row mounting `@deepseek-ai/dsh-mcp-client`, with the plugin's `.mcp.json` normalized to DSH's config shape.
- **one state record** under the harness home names the marketplace, the plugin, the pinned commit, where the content landed, and which discovery-root entries the plugin owns.

The user patch layer is watched through Cordis HMR, so a row takes effect without a restart.

## Understand the implementation

### Design concept

**A translation layer, not a registry.** The external format is a de-facto standard that other harnesses also read; teaching DSH's core about it would weld a third-party schema into internal models that have their own lifecycle. Instead the schema is parsed at the edge and its *effects* are expressed in primitives DSH already has — a directory of skills and a loader row — so the core never learns the word "marketplace".

### Two mechanisms, one verb

Skills and loader rows behave differently enough that collapsing them would be wrong in both directions:

| Content | How it mounts | How it is disabled |
|---|---|---|
| skills | one entry per skill, directly under the discovery root | each owned entry moved to `<root>/.disabled/<plugin>/` |
| MCP server | one loader row | the row's `disabled` flag |

Reporting "installed" for a row that was never written would be false, and registering skills twice — once by discovery and once by row — would double them. `enable`/`disable` therefore does both and reports which one moved.

### Who owns what

- **existence and provenance** live in the marketplace state file
- **enablement** lives in the patch layer, where the user can see and hand-edit it

Splitting one fact across two files is how "I disabled it and it came back" happens, so `disabled` has exactly one home. A sync reads the current value back before composing, which is why a hand edit survives.

A row id is **not** a function of the plugin name: an MCP row is keyed on the sanitized server name, and one plugin may declare several servers. The install records the ids it resolved into the state entry, and `enable`/`disable` address exactly those — a caller that recomputed `marketplace:<plugin>` would match no row, write nothing, and still report success. Skill entries are recorded the same way for the same reason: the discovery root is flat, so one plugin contributes one entry per skill, and only the record says which.

Because the root is flat, two plugins that ship a skill entry of the same name are a real conflict. The first entry in state order keeps the name and the second is reported instead of overwriting it, so neither plugin can silently replace the other's skill or delete it on uninstall.

Two cleanup functions split by what they may delete. `removeMaterializedSkills` removes only the entry names it is given, live or parked, and is what a sync uses to drop a name a plugin stopped shipping. `removePluginSkills` is uninstall's wider cleanup: those same names plus the parking directory and the plugin-scoped container an earlier layout wrote. The split is load-bearing because the parking directory is a DISABLED plugin's only copy of its skills, so folding it into the sync path deletes them the first time a stale name is dropped.

### The catalog read

`src/catalog.ts` owns one read that both faces call. It visits every registered marketplace in stored order and returns one row per entry: the fields a list renders, the name the supplying manifest declares, whether this package's pin rule accepts the source an install would read, whether an installed record already exists, and the warnings the entry carried.

`installable` is that pin rule's verdict on the source an install would read, and it is not a promise that an install succeeds: a marketplace can change between the read and the click. The verdict and the refusal are decided from the same source, so a row this read declines is exactly one an install accepts only with `allowUnpinned` — which is the acknowledgement the panel asks for. A marketplace-relative `local` entry is what makes that agreement load-bearing: the path names content inside the marketplace repository, so an install reads it as a git subdirectory carrying no `sha`, and the entry is installable only through the acknowledgement.

A registration that cannot be read becomes one reported failure carrying its registration name and the fetch layer's reason, and the loop continues to the next one. The CLI's `search` prints each failure to stderr and still prints the matches the readable registrations supplied, so silence never reads as "this marketplace lists nothing". An empty query lists everything, and a deployment with no registration resolves empty rather than refusing — `search` keeps its own separate refusal for that case.

The read accepts an optional fetch budget, and `marketplace.catalog` passes none: every manifest read uses the fetch layer's own budget. It is the only read on this Remote face that reaches the network, which is why the panel asks for it on request rather than when its tab opens.

The traversal is deliberately not shared with `resolveEntry`, which resolves one name and stops at the first marketplace listing it. A catalog must visit every registration, and merging the two would make every install fetch every registered marketplace to save the read path a loop.

### The Remote face

The Web settings panel talks to `MarketplaceGateway` (Remote namespace `marketplace`): `marketplace.status` and `marketplace.catalog` read, and `marketplace.install`, `marketplace.setEnabled` and `marketplace.uninstall` write. Four rules hold across it.

**Reads never write.** `marketplace.status` resolves ownership from the state record and the plugin's own `skills/` directory, and enablement from the patch layer. It does not materialize, so opening a settings tab cannot copy or move anything on the user's disk. `marketplace.catalog` only fetches manifests.

**A deployment decides whether writes exist.** The `allowMutations` config field (default `true`) is checked in the write path itself. The panel reads the same flag from the status snapshot and renders no controls when it is false, but the flag is enforced on every call: a hidden button is never the enforcement point. Browsing is not a mutation, so `marketplace.catalog` answers on a read-only deployment while `marketplace.install` refuses with `marketplace/read-only`.

**One implementation per operation.** The CLI and the panel call `setPluginEnabled` in `src/operations.ts` for enablement, `catalog` in `src/catalog.ts` for the read, and `installPlugin` for an install, so the two faces cannot disagree about which rows and discovery-root entries a plugin owns or what a marketplace offers; `marketplace.install` adds only the Remote checks around that call. Each write also returns the status it produced, so the panel renders post-write truth rather than issuing a second read that could race the write it just made, and `marketplace.install` returns the recorded `sha` and the install's warnings alongside it.

**A refusal keeps its identity across the wire.** `InstallError` carries a structural `reason` from the closed `InstallRefusal` set — `name-unusable`, `no-marketplace`, `not-found`, or `unpinned` — and the gateway maps it to a `RemoteErrorDetailsMap` code rather than matching the message text, so a reworded message cannot change what a client is told. An unusable name is `gateway/bad-request`, an empty registry or an unlisted name is `marketplace/not-found`, and a source with no `sha` that the request did not accept is `marketplace/unpinned`. A fault after admission is not a refusal at all: it is `marketplace/install-failed`, carrying the fault's own reason.

The status view reports two facts per installed plugin that the patch layer cannot answer. `skillIds` names the discovery-root entries the plugin owns, and `skills` says where they are: `live` in the discovery root, `parked` under `<root>/.disabled/<plugin>/`, or `none` when the plugin ships no discoverable skill. Skills mount by discovery rather than by a row, so their placement has no patch-layer representation at all.

### Sources that point inside the marketplace

A manifest entry may name its content relative to the marketplace repository (`./plugins/foo`), which measured at 52 of the official registry's 294 entries. That path is resolved against the repository the manifest was read from, not the process working directory.

None of those entries declares a `sha`, so the pin rule still declines them by default. `--allow-unpinned` replaces the refusal with a **recorded commit**: the remote is asked what its ref points at, that commit becomes the install's pin, and `install` prints it alongside the manifest's own. Refusing was accurate but unhelpful — the resolver knows which revision it is about to fetch, so recording it loses nothing and keeps the install verifiable.

### Source map

| File | Role |
|---|---|
| `src/parse.ts` | manifest parsing; strict, and reports an unpinned source |
| `src/fetch.ts` | manifest fetch over the process-wide proxy policy |
| `src/git.ts` | pinned fetch (`execFile`, argv only — never a shell), the copy that places content at its install path, and capability detection |
| `src/state.ts` | the installed record |
| `src/patch-layer.ts` | composing rows into the user patch layer; the only writer |
| `src/materialize.ts` | capability → surface mapping: MCP normalization, flat skill materialization, and the ownership-aware cleanup |
| `src/operations.ts` | the write operations the CLI and the Remote face share |
| `src/catalog.ts` | the catalog read the CLI's `search` and `marketplace.catalog` share |
| `src/gateway.ts` | the Remote face: two reads and three gated write verbs |
| `src/sync.ts` | state → materialize → patch layer |
| `src/install.ts` | resolve → fetch → record → sync |
| `src/marketplace-command.ts` | the CLI face |
| — | No runtime invariant companion is published; this package owns no durable event stream, and its three writer surfaces (the state file, the patch layer, and the discovery root) are each derived from a re-read of its inputs before the write. |

## Further Exploration

- `packages/host/plugin-inventory` — the read-only view of what is composed, for display.
- `packages/mcp/mcp-client` — the module every MCP row mounts.
- `packages/skill/skill-filesystem` — where skills are discovered, and which environment variable selects the root.
- `packages/boot/app-boot` — the patch layer, its `!!js` dialect, and the watcher that makes it live.

## Model Experience

### Installed skills

#### What the model sees

Each skill the plugin ships becomes one catalog entry carrying only its `name` and `description`, discovered from the agents skills root by [`skill-filesystem`](../../skill/skill-filesystem/README.md). Bodies stay out of the prompt until the model calls the `skill` tool. Nothing in this package adds text of its own: the manifest's marketing description never reaches the model, and neither does the plugin's provenance.

#### Token effect

One catalog line per skill for as long as the plugin stays enabled. A disabled plugin contributes nothing, because its skills are moved out of the discovery root rather than flagged.

#### KV Cache effect

Append-only in the common case: enabling or disabling a plugin changes the catalog, so the system-prompt prefix changes once at that boundary and is stable afterwards.

### Installed MCP servers

#### What the model sees

Every server a plugin declares appears as tools named `mcp__<serverName>__<tool>`, mounted through [`mcp-client`](../../mcp/mcp-client/README.md). The server name is sanitized to `[A-Za-z0-9_-]{1,32}` when the plugin's own name does not fit, and the rename is reported because that public name is what saved approvals and session history key on. An unreachable server contributes no tools and does not fail the turn.

#### Token effect

Tool schemas are static per registration and small; result text is whatever the server returns. A disabled server's row stays in the patch layer with `disabled: true`, so its schemas leave the prompt as soon as the layer reloads.

#### KV Cache effect

Stable while the enabled server set is unchanged. Adding or removing a server changes the tool block, which invalidates reuse from that point rather than across the whole session.

## Known Limitations and Deferred Work

- **No loader-mountable runtime plugin.** Measured against the 294-plugin official registry: no entry ships a cordis-mountable entry point. The only plugins carrying a `package.json` are MCP-server sources (dependencies but no `main`/`exports`), which arrive through the MCP path. A runtime entry would therefore be an unexercised guess, so `InstalledCapability` does not claim one.
- **`commands/` is detected but is a FORMAT gap, not a wiring gap.** The capability is reported and the directory is recorded, but it cannot be mounted by connecting two APIs: a Claude plugin's command is a Markdown file whose frontmatter carries a `description` and whose body is an instruction addressed to the model (`## Your Task` …), so invoking it MEANS sending that text as a prompt. DSH's `CommandDefinition.handler` is documented as executing "against the receiving agent *without sending the command to the model*" (`packages/interaction/commands/src/index.ts`), and `CommandInvocation` exposes only `commandId`, `agent`, `rawInput`, `attachments` and `signal` — no path to the model. Giving DSH prompt-expansion commands is a core capability decision, so this package reports the capability honestly instead of pretending to mount it.
- **`lspServers` from an entry is parsed but not mounted.** It is the one capability the manifest does declare inline, in 12 of 294 entries.
- **No update or version-pinning policy.** Re-installing a plugin replaces it in place; a plugin pinned to a moving ref (`ref` without `sha`) is refused rather than resolved, which means such an entry cannot be installed at all.
- **An unpinned entry needs an explicit opt-in.** 52 of the 294 official entries name their content relative to the marketplace repository and none of them carries a `sha`. The path is resolved against that repository, and the pin rule still declines the install unless `--allow-unpinned` is passed — which resolves the source's ref to the commit it names *now* and records that. The install is then one specific revision and can be held to it, but it is a snapshot of a ref, not a guarantee the next install matches. Entries pinned to a moving ref are unaffected either way.
- **A local source is copied, not linked.** An entry whose source is a directory rather than a repository installs as a copy under the plugins root, which is what lets uninstall delete an install without ever deleting the directory the manifest named. Later edits to that directory do not reach the installed copy; re-installing is what picks them up.
- **The manifest fetch is GitHub-shaped.** A repository url is resolved to its `raw/main` manifest; another host needs an explicit manifest url.
- **A skill entry must be discoverable at the top of the plugin's `skills/` directory.** An entry that is a directory without `SKILL.md`, or a file that is not Markdown, is reported and skipped instead of copied: `skill-filesystem` reads exactly one level, so copying it into the discovery root would produce a file the model is never offered.
- **The catalog is a snapshot.** A marketplace can change between the read and the click. `marketplace.install` re-resolves the entry from the registry at install time, so the recorded pin is the current one rather than what the panel displayed, and a name that disappeared between the two reads fails as `marketplace/not-found` instead of installing something else.
- **An unpinned install records a commit the user never saw.** The opt-in resolves the source's ref at install time and records that commit; the recorded revision is chosen by the remote at the moment of install.
- **Browsing is not gated by `allowMutations`.** A read-only deployment still performs the catalog's network fetch. Browsing is not a mutation, so the read-only posture does not make the panel network-silent.
- **Registering a marketplace stays on the CLI.** The Remote face lists the registrations and installs from them; adding one is `dsh plugin marketplace add` in a terminal.
- **The catalog read can be slow or fail for reasons outside the machine.** A catalog failure therefore reaches the panel even though nothing is wrong with the user's plugins, which is the price of asking a marketplace what it offers.
- **The search predicate exists on both faces.** The CLI filters on the Host and the panel filters in the browser, because they are different programs and `./types` is types-only by rule. Both pin the same substring test over the same four fields, so a drift is a test failure rather than a silent difference.
- **Comment preservation is best-effort.** A patch-layer write re-serializes the file, and a full dump cannot keep the user's comments. Writes happen only when the composed rows actually change, and change detection is canonicalized so key order alone never triggers one.

### Dev Note

The failure modes this package was built against were all measured rather than assumed, and were found by the probes rather than by review:

- `insert` **pushes**, so re-inserting an id duplicates the row; composing must drop its own previous rows first.
- recomposing from the desired rows alone **erased a `disabled` flag** it never set — the two-sources-of-truth bug, caught by a probe.
- comparing dumps to detect change made **key order alone look like a change**, which would have rewritten a hand-annotated file for nothing.
- namespacing an MCP row id by plugin **hid a real conflict**: `mcp-client` reserves `serverName` per scope and throws on a duplicate, so the id is keyed on the server name instead.
- keying the row id on the server name then **broke enablement**: the command surface still recomputed `marketplace:<plugin>`, matched no row, wrote nothing, and reported success. The ids are now recorded at install and read back.
- a marketplace-relative source was read as a **cwd-relative path**, so every entry naming its content that way failed with a message about a missing local file. Measured at 52 of 294.
- deriving that source's clone url by appending `.git` to the **manifest** url produced `…/raw/main.git`; a raw-content url is not a repository, so the mapping is explicit and host-scoped.
- the on-disk capability comparison **omitted `commands/`**, so every plugin shipping one reported "capabilities changed on disk" on every sync forever, because the install recorded a capability the comparison could never find.
- the `skills/` subtree was copied into a **plugin-scoped** directory, one level deeper than `skill-filesystem` reads. Install, state and the settings panel all reported success while the model was offered none of the skills — a probe that asked the real provider what it had discovered is what found it, and no assertion about the destination directory alone would have.
- uninstall deleted the plugin directory but **never touched the discovery root**, because materialized skills live outside it by design. Only the recorded ownership makes them removable.

### Tests

`tests/marketplace.spec.ts` pins both identity rules. Each assertion is written against the outcome — what the patch layer holds, whether a toggle returns true — so it stays green under refactoring and reddens when the fix is reverted; the two row-id tests and the two url tests were each confirmed to fail against a reverted implementation.

`tests/skills.spec.ts` asks the REAL `dsh-skill-filesystem` provider what it discovered rather than restating the layout rule as a path literal: the materialization test fails against the plugin-scoped copy that shipped, and was confirmed to do so.
