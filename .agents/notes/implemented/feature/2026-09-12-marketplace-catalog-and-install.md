# Agent Note: The marketplace panel browses and installs plugins

Status: implemented

English | [中文](2026-09-12-marketplace-catalog-and-install.zh.md)

## Problem

The marketplace panel managed plugins that were already installed. It could not show what was available, and it could not install any of it. A user who had just registered a marketplace saw its name and nothing else: the entries that marketplace offered existed only behind `dsh plugin marketplace search`, in a terminal. Every decision to change the installation therefore started outside the panel that displays it.

[The panel write face](2026-09-11-marketplace-panel-write-controls.md) deferred this deliberately. An install resolves a source, fetches it, pins a revision, and reports the pin, and the note recorded that as a progress and partial-failure story a single request and response does not obviously carry.

The read path also carried a defect the panel would have inherited rather than introduced. `dsh plugin marketplace search` awaited every registered marketplace in turn, and the first failing fetch aborted the whole command. A deployment with two registrations, one of them unreachable, got no results from the one that answered.

## Decision

`marketplace.catalog` and `marketplace.install` join the marketplace Remote face, one `catalog()` operation serves both the CLI's `search` and the gateway, and the settings tab gains an available-plugins section that reads on request and installs from it.

An install stays a single request and a single response. `installPlugin` is one await over resolve, fetch, pin, materialize, and reconcile; it has no stages to report, and inventing them would mean restructuring the only verified install path in the repository to drive a progress display.

### The catalog operation

`src/catalog.ts` owns one operation:

```ts
catalog(state: MarketplaceState, options?: { fetch?: FetchOptions }): Promise<CatalogResult>
```

`CatalogResult` is `{ rows: CatalogRow[]; failed: MarketplaceFailure[] }`. `CatalogRow` carries everything a list row renders, with installability decided by the Host:

| Field | Source |
|---|---|
| `plugin`, `description`, `category`, `version`, `tags` | the parsed `MarketplaceEntry` |
| `marketplace` | the name the supplying manifest declares |
| `installable` | `isPinned(entry)` |
| `warnings` | the entry's own warnings, including the missing-pin one |
| `installed` | `findInstalled(state, rowIdFor(plugin))` |

`installable` is not a promise that an install succeeds. It applies the pin rule to the source as the manifest declares it, while an install re-resolves the source before it checks: a marketplace-relative `local` entry passes the pin rule here and becomes a git subdirectory carrying no `sha`, which the install then declines as unpinned.

A marketplace that cannot be read becomes one `MarketplaceFailure` carrying its registration name and the fetch layer's reason, and the loop continues. It does not abort the operation, so one unreachable registration cannot blank the list a reachable one supplies.

The CLI's `search` calls this operation rather than keeping a second implementation, which is what gives the CLI the same containment. Its output is unchanged — one bare plugin name per match, the description indented under it, `[installed]` beside a name with an install record, and `no plugin matched "<query>"` when nothing matches — and each unreadable registration is printed to stderr before the matches, so silence never reads as "this marketplace lists nothing".

`marketplace.catalog` calls the same operation with the stored registrations and no fetch override, so every manifest read uses the fetch layer's own budget; no cancellation signal crosses the Remote call either. It is the only read on this face that reaches the network, which is why the panel asks for it on request rather than when its tab opens.

This operation deliberately does not absorb `resolveEntry`. `resolveEntry` resolves one name and stops at the first marketplace that lists it; `catalog` must visit every registration to produce a complete list. Merging them would make every install fetch every registered marketplace, which is a cost paid on the write path to save a loop on the read path.

### The Remote face

`marketplace.catalog` is a read and is served to a read-only deployment; browsing is not a mutation. It is not cached, consistent with this module's posture that reading per call cannot go stale — the panel holds its own snapshot, so one tab interaction costs one read.

`marketplace.install` calls `requireMutations()` first, then validates the plugin name, then `installPlugin` — the same entry point the CLI uses — passing `allowUnpinned` only when the request set it. It returns the plugin, the commit recorded, the install's warnings, and the status that install produced, so the panel renders post-install truth without a second round trip that could race the write.

Three failure codes join `RemoteErrorDetailsMap`:

| Code | Condition |
|---|---|
| `marketplace/not-found` | no registered marketplace lists the name, or none is registered at all |
| `marketplace/unpinned` | the source carries no `sha` and the request did not set `allowUnpinned` |
| `marketplace/install-failed` | any other fetch or filesystem fault, carrying its reason |

Distinguishing these requires a structural fact rather than a message match, so `InstallError` carries a required `reason` from the closed `InstallRefusal` set — `name-unusable`, `no-marketplace`, `not-found`, `unpinned` — set where each refusal is raised. The gateway maps it through `INSTALL_REFUSAL_CODE`: an unusable name is `gateway/bad-request`, because the request itself was malformed, while `no-marketplace` and `not-found` share `marketplace/not-found`. `install-failed` is not a refusal at all but the fallback for anything else thrown after admission. The CLI keeps printing `error.message`, so a stable wire code never depends on English wording.

The wire additions live in `./types`, which stays the contract's only home; `gateway.ts` imports them without re-exporting, because its module graph is Node-only and a re-export would drag that into the browser compilation face. [`api-remotes`](../../../../packages/api/remotes/README.md) republishes the same types on its browser face, which is where the panel imports them from:

| Type | Fields |
|---|---|
| `MarketplaceCatalogView` | `rows: CatalogRowView[]`, `failed: MarketplaceFailureView[]` |
| `CatalogRowView` | `plugin`, `marketplace`, optional `description`/`category`/`version`, `tags`, `installable`, `installed`, `warnings` |
| `MarketplaceFailureView` | `marketplace`, `reason` |
| `PluginInstallRequest` | `plugin`, optional `allowUnpinned` |
| `PluginInstallResultView` | `plugin`, optional `sha`, `warnings`, `status` |

`catalog` on a deployment with no registered marketplace resolves empty `rows` and empty `failed` rather than refusing. An empty registry is a state the panel already renders, and the CLI's `search` keeps its own separate refusal for that case.

### The panel section

A third section sits in the existing tab, below the installed list, and it loads on request: the section opens with one control that reads the catalog, and the search field, the rows, and a refresh control appear once it answers. This is the whole reason the read is separate from `status` — the tab's other reads are local, and loading the catalog on mount would make opening a settings page wait on a git fetch. A catalog failure is contained in this section; the registered and installed sections render regardless, a failed refresh keeps the rows already on screen, and each registration the Host could not read is named with its reason.

Filtering happens in the browser over the rows the Host returned, so a keystroke costs nothing. The predicate is the CLI's: one case-insensitive substring test over the plugin name, description, category, and tags, with the filter trimmed and an empty filter matching everything. It exists twice because the CLI and the browser are different programs and the package has no browser-safe runtime module to share a pure function through — `./types` is types-only by rule and `./gateway` is Node-only — so both sides pin the same cases.

One row shows the plugin name, an installed marker, the description, the entry's warnings, and a warning tag when the source is not installable. An unpinned entry is installed only through an explicit acknowledgement: pressing install on such a row opens the `RiskConfirmation` primitive, whose description states that the marketplace declares no commit for the plugin, and whose confirm control stays unavailable until its acknowledgement checkbox is set. This is the panel form of the CLI's `--allow-unpinned`; the acknowledgement is per install rather than a standing permission.

A read-only deployment draws no install control, matching the toggle and the uninstall control, and the Host still refuses the call. After an install the panel renders the returned status and re-reads the catalog, so the installed list gains its row and the catalog row shows the Host's own view rather than the panel's guess. The install's own warnings come back on the wire and the panel renders none of them; what a row shows is the entry's warnings from that re-read. A refusal is shown against the row it was refused for.

## Alternatives considered

**Filtering on the Host behind a `search(query)` method.** Rejected: it puts a network round trip behind every keystroke. The CLI can afford to refetch per invocation because an invocation is one command; a search field is not. Caching the catalog on the Host to compensate would add an invalidation problem this module does not have.

**Shipping both `catalog()` and `search()`.** Rejected as YAGNI. A server-side filter would duplicate a predicate the browser can evaluate over rows it already holds, and the two would be free to disagree while adding a second interface member to maintain.

**Streaming install stages as a forwarded event.** Rejected: `installPlugin` has no stages to report, so this would first require giving it stage callbacks and restructuring the CLI's only verified install path. The panel needs to know that an install is running and how it ended, and a single request and response carries both.

**Loading the catalog when the tab opens.** Rejected: it makes an existing, purely local panel depend on a network fetch, and turns a slow or intercepted connection into a blank settings page.

**Merging `catalog` into `resolveEntry`.** Rejected: the two have opposite traversal rules, and the merged version pays the catalog's full traversal on every install.

**Mapping the unpinned refusal by matching its message.** Rejected: it makes a wire-visible code depend on English wording that no test would think to protect.

**A panel-level "allow unpinned" switch.** Rejected: it converts a per-install decision into a standing permission, so one acknowledgement would silently cover every later unpinned install.

## Consequences

- Browsing and installing happen in the panel that displays the installation: it lists what the registered marketplaces offer and installs from that list, and the CLI keeps both commands.
- `dsh plugin marketplace search` keeps its output and gains containment: an unreadable registration is reported on stderr and the matches from the readable ones still print.
- `marketplace.catalog` returns one row per entry across every registered marketplace, with `installable` false exactly for a source the pin rule declines as the manifest declares it and `installed` true exactly for a name with an install record; an install re-resolves the source and can refuse an entry this read accepted.
- `marketplace.install` on a read-only deployment is refused with `marketplace/read-only` while `marketplace.catalog` still answers; an unlisted name is `marketplace/not-found`, and an unpinned entry without `allowUnpinned` is `marketplace/unpinned`.
- With `allowUnpinned: true` the same call installs the entry and records the commit the ref named at that moment, so the install is one specific revision rather than a moving ref.
- A successful install returns the status it produced, and that status lists the plugin as installed.
- An unpinned row's install control is drawn and available like any other, and it opens the acknowledgement dialog instead of installing; the checkbox gates that dialog's confirm.
- `InstallError.reason` is a required field of a closed union, so a new refusal has to name itself and be mapped to a wire code rather than fall through to a message match.
- The filter predicate exists in two places. The CLI filters on the Host and the panel filters in the browser, because they are different programs and the package has no browser-safe runtime module to share a pure function through. Both are pinned with the same cases, so a drift is a test failure rather than a silent difference.
- `catalog` is the first read on this Remote face that can be slow or fail for reasons outside the machine, which is why it is separated from `status` and read on request. A catalog failure therefore reaches the panel even though nothing is wrong with the user's plugins.
- The catalog is a snapshot, so a marketplace can change between the read and the click. Install re-resolves the entry from the registry at install time, which makes the recorded pin current rather than what the panel displayed; a name that disappeared between the two reads fails as `marketplace/not-found` rather than installing something else.
- An unpinned install records a commit the user never saw. The opt-in resolves the ref at install time and records that commit, which is what the CLI already did, but the recorded revision is chosen by the remote at the moment of install.
- Browsing is not gated by `allowMutations`: a read-only deployment still performs the catalog's network fetch. Browsing is not a mutation, so the read-only posture does not make the panel network-silent.
- The package satisfies the REAL-composition requirement [packages/AGENTS.md](../../../../packages/AGENTS.md) states for a product-visible plugin, which it had been failing before this work.

## Testing

`tests/catalog.spec.ts` covers the read: one row per entry with installability and the installed marker decided by the Host, containment of an unreadable registration, ordered so the unreachable one is visited first, registration order across marketplaces, and the empty registry. `tests/search-command.spec.ts` drives the CLI command itself and pins both halves of the containment — the readable registration's match on stdout and the failed one's reason on stderr — together with the output format, the `[installed]` marker, and the no-match line. `tests/gateway.spec.ts` pins the five published methods, the install failure codes, the read-only refusal, the catalog answering on a read-only deployment, and a successful install returning what it recorded alongside the status. `tests/install-reasons.spec.ts` asserts the `reason` field of all four refusals rather than their messages, so a reworded message cannot change a wire code. The opt-in that records the commit a ref resolved to (`allowUnpinned: true`) is the one path here without automated coverage: it needs a real git remote, so the suite pins only the refusal that the opt-in lifts.

`tests/loader-composition.spec.ts` is the REAL-composition test [packages/AGENTS.md](../../../../packages/AGENTS.md) requires of a product-visible plugin. It writes a test-only `cordis.yml` carrying the marketplace row, boots it through the vendored Loader, and asserts against the service the Loader composed: the `marketplace` namespace, the five methods, the row's configured state path as the path the read actually uses, and that an `allowMutations: false` row refuses `install` while `catalog` still answers. The manifest fetch is the only external service stubbed; the Loader resolves the row through its own module seam, so the config reaches the service through the Loader rather than through a hand-built context.

`tests/components.client.spec.tsx` drives the panel against a fixture: the section staying unloaded until asked, the filter's four fields and its whitespace cases, a pinned entry installing in one call, an unpinned entry reaching the Host only once its acknowledgement is set, a refusal landing on its own row, and a read-only deployment drawing no install control. `tests/browser-plugin.client.spec.tsx` covers the registration entry's five Remote wrappers and the refusals they pass through.
