---
description: "Marketplace tab in the dsh web Plugins settings: registered marketplaces, installed plugins with pin, capabilities, owned loader rows and skill entries, and the controls that enable, disable or uninstall one."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-marketplace

English | [中文](README.zh.md)

## Summary

Use the **Marketplace** tab in Plugins settings to see what the plugin marketplace installed, how each plugin currently stands, and to turn one on or off or remove it. It lists the registered marketplaces and, for every installed plugin, its pinned commit, its detected capabilities, the loader rows and discovery-root entries it owns, and where each of those is now. A toggle enables or disables the plugin and an **Uninstall** control removes it, the latter gated behind an explicit acknowledgement because it deletes files. Installing a plugin stays on the `dsh plugin marketplace` command line.

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

Open the Plugins section in Settings and select the **Marketplace** tab. The tab reads nothing until it is selected; selecting it mounts the component, which calls `ctx.remote.marketplace.status()` once through `api-remotes`.

### Reading a card

Each installed plugin is one card. The title is the plugin name, and the tag beside it is its state: **enabled** when every loader row it owns is present and on, **disabled** when they are present and off, **not mounted** when state records the plugin but the patch layer has no matching row, and **skills only** when it owns no loader row at all. Below the tag the card shows the pinned commit, the capabilities detected on disk, the row ids themselves, where the skill entries it owns currently are (**live**, **parked**, or **none**), and the content directory. The provenance line under the facts names the marketplace the plugin came from.

The **skills only** state is not a fault and is not toned like one. A plugin whose only capability is skills mounts no loader row, because `skill-filesystem` discovers skills from the filesystem; calling that disabled would tell the user a live plugin is off. Its skills placement answers the question the row state cannot.

### Turning a plugin on or off

A toggle appears on every card whose plugin mounts something — a loader row, skill entries, or both — and is absent on a plugin that mounts nothing, because there is nothing for it to move. Its position is the plugin's whole state: on when every mechanism it has is on, off when any is off.

Flipping it asks the Host for the opposite state and renders the status the Host returns, so the control follows the Host rather than the click. A write in flight disables the toggle for that plugin only. Nothing is confirmed here: disabling moves skills and rows aside without deleting them, and enabling moves them back without a re-fetch, so both directions are reversible.

### Uninstalling a plugin

**Uninstall** opens a confirmation that requires an explicit acknowledgement before its confirm button becomes available, naming the plugin in its title. Uninstall deletes the plugin content directory, its materialized skills, its loader rows and its install record, and none of that is recoverable.

### When a write is refused

A refused write renders the Host's own message on the card it was refused for, leaving every other card untouched: one refusal is not a page-level error, and the panel does not discard a status it already has. The message carries the Host's refusal code, which says more than a translated sentence that would have to guess which refusal it was.

### When the deployment serves the panel read-only

A deployment can turn the write verbs off. The status snapshot reports that, and the panel then renders a short notice instead of the controls: no toggle and no uninstall button appear at all, so no click can fail. The read itself still works, because a read-only panel is not an unavailable one.

### Retrying a failed read

A failed read renders a short failure line with a **Retry** button. The panel does not surface a transport code, because the actionable part is the retry and the code would not change what the user does next.

## Understand the implementation

### Design concept

**A request surface, not an authority.** The panel decides nothing: it asks the Host for a state, renders the answer, and asks again to change one. The permission, the ownership rules, and the writes themselves live in `packages/host/plugin-marketplace`, which is why a deployment that turns writes off is obeyed rather than worked around — the flag is checked where the write happens, and this package only stops drawing controls.

**A control that cannot act is not drawn.** A toggle on a plugin that mounts nothing, an uninstall on a read-only deployment, a second click while a write is in flight: each is a button whose only possible outcome is a refusal, so the panel withholds it. The refusal is still enforced on the Host side for the cases the panel cannot see, such as a change made from the CLI between a read and a click.

**Nothing is cached.** The Host reads the state file and parses the patch layer on each call. Both change underneath a running harness: the CLI can install or disable something while the browser is open, and Cordis HMR can rewrite the patch layer at any moment. A cached snapshot would need an invalidation path for every writer, and the read is cheap enough that it needs none. A write returns the status it produced, so the panel never re-reads to find out what it did.

### What the Host read guarantees

The Host's `status()` never materializes. `materializeEntry` copies skills into the discovery root and can park them under `.disabled`, so a status read built on it would mutate the user's disk as a side effect of opening a settings tab. Row ids are derived from each installed plugin's `.mcp.json`, and skill ownership from the state record or the plugin's own `skills/` directory, so the read names what the writer would address without either one writing.

Enablement comes from the patch layer and nowhere else, matching the ownership rule the marketplace package states: existence and provenance live in the state file, enablement lives in the patch layer. Skills are the one capability the patch layer cannot describe, because they mount by discovery; the status view therefore carries where they are as its own fact rather than inferring it from a row.

### Source map

| File | Role |
|---|---|
| `src/client/index.ts` | registers the tab into `settings.plugins.tab` and wraps the three Remote calls |
| `src/client/MarketplaceSettingsTab.tsx` | the panel: both sections, the state tags, the per-plugin controls and confirmations, and the retry state |
| `src/client/locales.ts` | the `settings.marketplace` dictionaries, key union declared first |
| `src/index.ts` | host loader entry with no host-side behavior |
| — | No runtime invariant companion is published; this package owns no durable state, writes nothing itself, and contributes one settings tab whose every mutation is a Remote call. |

## Further Exploration

- `packages/host/plugin-marketplace` — the marketplace itself: parsing, fetching, and the Remote face this tab reads.
- `packages/client/ui-settings-plugin-inventory` — the sibling Plugins tab, which lists the Loader's own entries.
- `packages/client/ui-settings-plugins` — the section that declares `settings.plugins.tab` and renders each contribution.
- `packages/client/ui-slots` — the slot registry and the locale contract this tab registers against.

## Model Experience

### The marketplace panel

#### What the model sees

Nothing. The panel is a Settings surface for the human operator: no part of it reaches the system prompt, the tool block, or the message stream, and the model cannot read or invoke it. What the panel REPORTS — a plugin's install path, pinned commit, and row ids — describes what is mounted elsewhere, and anything that does reach the model does so through those mounted rows and discovered skills rather than through this tab: an MCP row appears as `mcp__<serverName>__<tool>` tools, and a discovered skill appears as one catalog line the model reaches through the `skill` tool. A control used here changes that material elsewhere — disabling a plugin takes its row's schemas out of the tool block and parks its skills, and uninstalling removes both — but the change belongs to the mounted contribution, and this package adds no text of its own.

#### Token effect

Zero on its own. No contribution of this package is added to a request, and the panel's own text is rendered only while a human has the tab open. A write moves the same token accounts the equivalent CLI command does, through the row or skill it changed.

#### KV Cache effect

None on its own. Opening, reading, or closing the panel changes nothing in the request prefix, so no cache boundary moves. A write from the panel moves the one boundary its CLI equivalent moves: the tool block when a row changes, or the skill catalog when entries move in or out of discovery.

## Known Limitations and Deferred Work

- **Installing is not here.** The tab manages what is already installed; browsing a marketplace, searching it, and installing from it stay on the CLI, where a fetch and its pinned revision have somewhere to report progress.
- **A write has no progress of its own.** A toggle or an uninstall shows that it is in flight and then the result, because both are short filesystem operations. A future install from this panel would need a progress channel rather than a longer spinner.
- **A failed read is not diagnosed.** The panel shows one generic failure with a retry, because the Host's error text is a filesystem or parse diagnosis that the operator resolves in a terminal.
- **The two sections are lists, not a search.** A marketplace with hundreds of plugins is browsed from the CLI; this tab exists to answer "what did I install, and is it on?" rather than "what could I install?".
- **No update or version view.** The panel shows the pinned commit but not whether the marketplace now lists a newer one, because nothing in this package resolves upstream revisions.

### Dev Note

Two decisions here were forced by the build rather than chosen, and both are recorded because the next person will otherwise rediscover them the hard way:

- The Host's `status()` return type reaches the BROWSER compilation face through the generated Remote declaration. An earlier version re-exported the wire contract from the gateway module, which made the client build resolve that module and compile the entire Node-side package — `node:fs`, `node:url` and all — for a browser target. The contract therefore lives in `types.ts` alone, and the gateway imports it without re-exporting.
- The same constraint removed an import of `PROFILE_PATCH_FILENAME` from `@deepseek-ai/dsh-app-boot`, which is Node-only. The literal is used instead, with a comment naming the package that owns the real constant.
