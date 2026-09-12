# Agent Note: The marketplace panel browses and installs plugins

Status: proposed

English | [中文](2026-09-12-marketplace-catalog-and-install.zh.md)

## Problem

The marketplace panel manages plugins that are already installed. It cannot show what is available, and it cannot install any of it. A user who has just registered a marketplace sees its name and nothing else: the entries that marketplace offers exist only behind `dsh plugin marketplace search`, in a terminal. Every decision to change the installation therefore starts outside the surface that displays it.

[The panel write face](../../implemented/feature/2026-09-11-marketplace-panel-write-controls.md) deferred this deliberately. An install resolves a source, fetches it, pins a revision, and reports the pin, and the note recorded that as a progress and partial-failure story a single request and response does not obviously carry.

The read path also carries a defect the panel would inherit rather than introduce. `dsh plugin marketplace search` awaits every registered marketplace in turn, and the first failing fetch aborts the whole command. A deployment with two registrations, one of them unreachable, gets no results from the one that answers.

## Proposal

Add a `catalog` read and an `install` write to the marketplace Remote face, one shared `catalog()` operation that both the CLI and the gateway call, and a lazily loaded available-plugins section in the settings tab.

Install stays a single request and a single response. `installPlugin` is already one await over resolve, fetch, pin, materialize, and reconcile; it has no stages to report, and inventing them would mean restructuring the only verified install path in the repository to drive a progress display.

### The catalog operation

`src/catalog.ts` owns one operation:

```ts
catalog(state: MarketplaceState, options: { fetch?: FetchOptions }): Promise<CatalogResult>
```

`CatalogResult` is `{ rows: CatalogRow[]; failed: MarketplaceFailure[] }`. `CatalogRow` carries everything a list row renders, with installability decided by the Host:

| Field | Source |
|---|---|
| `plugin`, `description`, `category`, `version`, `tags` | the parsed `MarketplaceEntry` |
| `marketplace` | which registration supplied the entry |
| `installable` | `isPinned(entry)` |
| `warnings` | the entry's own warnings, including the missing-pin one |
| `installed` | `findInstalled(state, rowIdFor(plugin))` |

A marketplace that cannot be read becomes one `MarketplaceFailure` carrying its name and reason. It does not abort the operation, so one unreachable registration cannot blank the list a reachable one supplies.

The CLI's `search` is rewritten on top of this operation rather than kept as a second implementation, which gives the CLI the same containment.

This operation deliberately does not absorb `resolveEntry`. `resolveEntry` resolves one name and stops at the first marketplace that lists it; `catalog` must visit every registration to produce a complete list. Merging them would make every install fetch every registered marketplace, which is a cost paid on the write path to save a loop on the read path.

### The Remote face

Two methods join `status`, `setEnabled`, and `uninstall`:

```ts
@Remote('catalog')  catalog(): Promise<MarketplaceCatalogView>
@Remote('install')  install(request: PluginInstallRequest): Promise<PluginInstallResultView>
```

`catalog` is a read and is served to a read-only deployment; browsing is not a mutation. It is not cached, consistent with this module's existing posture that reading per call cannot go stale — the panel holds its own snapshot, so one tab interaction costs one read. It performs network I/O, which `status` does not, and that difference is the reason the panel loads it on request rather than on mount.

`install` calls `requireMutations()` first and then `installPlugin`, the same entry point the CLI uses. It returns the resulting `MarketplaceStatusView` alongside what the install produced, so the panel renders post-install truth without a second round trip that could race the write.

Three failure codes join `RemoteErrorDetailsMap`:

| Code | Condition |
|---|---|
| `marketplace/not-found` | no registered marketplace lists the name |
| `marketplace/unpinned` | the source carries no `sha` and the request did not set `allowUnpinned` |
| `marketplace/install-failed` | any other fetch or filesystem fault, carrying its reason |

Distinguishing these requires a structural fact rather than a message match, so `InstallError` gains an optional `reason` field with a closed set of values, set where each refusal is raised. The CLI keeps printing `error.message`; the gateway maps `reason` to a code. Matching on message text would make a stable wire code depend on English wording.

The wire additions live in `./types`, which stays the contract's only home:

| Type | Fields |
|---|---|
| `MarketplaceCatalogView` | `rows: CatalogRowView[]`, `failed: MarketplaceFailureView[]` |
| `CatalogRowView` | `plugin`, `marketplace`, optional `description`/`category`/`version`, `tags`, `installable`, `installed`, `warnings` |
| `MarketplaceFailureView` | `marketplace`, `reason` |
| `PluginInstallRequest` | `plugin`, optional `allowUnpinned` |
| `PluginInstallResultView` | `plugin`, optional `sha`, `warnings`, `status` |

`catalog` on a deployment with no registered marketplace resolves empty `rows` and empty `failed` rather than refusing. An empty registry is a state the panel already renders, and the CLI's `search` keeps its own separate refusal for that case.

### The panel section

A third section sits in the existing tab, below the installed list.

**It loads on request.** The section opens with one control that reads the catalog; the search field, the rows, and a refresh control appear once it answers. This is the whole reason the read is separate from `status`: today the tab reads only local files and cannot be blanked by a network fault. Loading the catalog on mount would make opening a settings page wait on a `git` fetch, and a deployment behind an intercepting proxy would show an empty panel where it currently shows a correct one. A catalog failure is contained in this section; the registered and installed sections render regardless.

**Filtering happens in the browser.** The panel holds the returned rows and filters them locally, matching how the skill menu caches `skills/list` and filters a settled snapshot, and how the command directory answers from its cache. An empty query lists everything, which is what an empty query already does on the CLI.

**One row** shows the plugin name, an installed marker, the description, and category and version tags. An entry that is not installable shows a warning tag and its own warning text.

**An unpinned entry is installed through an explicit acknowledgement.** Pressing install on such a row opens the `RiskConfirmation` primitive, with the entry's warning as the description and a checkbox the user must set before the confirm control becomes available. This is the panel form of the CLI's `--allow-unpinned`, and it is what makes the earlier decision — allow these entries, label them clearly — visible rather than hidden: the label is the warning, the permission is the checkbox. The same primitive already gates uninstall.

**A read-only deployment draws no install control**, matching the toggle and the uninstall control, and the Host still refuses the call.

**After an install the panel renders the returned status.** The installed list gains its row, the catalog row becomes installed, and the install's warnings are shown against that row.

## Alternatives considered

**Filtering on the Host behind a `search(query)` method.** Rejected: it puts a network round trip behind every keystroke. The CLI can afford to refetch per invocation because an invocation is one command; a search field is not. Caching the catalog on the Host to compensate would add an invalidation problem this module currently does not have.

**Shipping both `catalog()` and `search()`.** Rejected as YAGNI. A server-side filter would duplicate a predicate the browser can evaluate over rows it already holds, and the two would be free to disagree while adding a second interface member to maintain.

**Streaming install stages as a forwarded event.** Rejected: `installPlugin` has no stages to report today, so this would first require giving it stage callbacks and restructuring the CLI's only verified install path. The panel needs to know that an install is running and how it ended, and a single request and response carries both.

**Loading the catalog when the tab opens.** Rejected: it makes an existing, purely local panel depend on a network fetch, and turns a slow or intercepted connection into a blank settings page.

**Merging `catalog` into `resolveEntry`.** Rejected: the two have opposite traversal rules, and the merged version pays the catalog's full traversal on every install.

**Mapping the unpinned refusal by matching its message.** Rejected: it makes a wire-visible code depend on English wording that no test would think to protect.

**A panel-level "allow unpinned" switch.** Rejected: it converts a per-install decision into a standing permission, so one acknowledgement would silently cover every later unpinned install.

## Acceptance criteria

- `dsh plugin marketplace search` keeps its current output and gains containment: one unreadable registration no longer suppresses results from the rest.
- `marketplace.catalog` returns one row per entry across every registered marketplace, with `installable` false exactly for entries whose source is an unpinned git source, and `installed` true exactly for entries with an installed record.
- `marketplace.install` on a read-only deployment is refused with `marketplace/read-only`; `marketplace.catalog` still answers.
- `marketplace.install` on an unlisted name is refused with `marketplace/not-found`.
- `marketplace.install` on an unpinned entry without `allowUnpinned` is refused with `marketplace/unpinned`; the same call with `allowUnpinned: true` installs it and records the commit the ref resolved to.
- A successful install returns the resulting status, and that status lists the plugin as installed.
- The panel's available-plugins section stays unloaded until asked, renders no rows while its read fails, and leaves the registered and installed sections rendered.
- An unpinned row's install control does not become available until its acknowledgement checkbox is set.

## Risks

- **The filter predicate exists in two places.** The CLI filters on the Host and the panel filters in the browser, because they are different programs; the package has no browser-safe runtime module to share a pure function through, since `./types` is types-only by rule and `./gateway` is Node-only. The predicate stays one substring test over the same four fields, and both sides are pinned with the same cases so a drift is a test failure rather than a silent difference.
- **A read that performs network I/O.** `catalog` is the first method on this Remote face that can be slow or fail for reasons outside the machine. It is separated from `status` and loaded on request for exactly that reason, but it does mean the panel's vocabulary now includes a failure that has nothing to do with the user's plugins.
- **The catalog is a snapshot.** A marketplace can change between the read and the click. Install re-resolves the entry from the registry at install time, so the recorded pin is current rather than what the panel displayed; a name that disappeared between the two reads fails as `marketplace/not-found` rather than installing something else.
- **An unpinned install records a commit the user never saw.** The opt-in resolves the ref at install time and records that commit. This is what the CLI already does, and it is strictly more than a silent HEAD install, but the recorded revision is chosen by the remote at the moment of install.
- **Browsing is not gated by `allowMutations`.** A read-only deployment still performs the catalog's network fetch. This is intended, since browsing is not a mutation, but it does mean the read-only posture does not make the panel network-silent.
