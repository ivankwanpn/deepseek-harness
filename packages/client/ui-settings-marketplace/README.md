---
description: "Read-only marketplace tab in the dsh web Plugins settings: registered marketplaces and installed plugins with pin, capabilities, owned loader rows, and enablement read back from the patch layer."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-marketplace

English | [中文](README.zh.md)

## Summary

Use the **Marketplace** tab in Plugins settings to see what the plugin marketplace installed and how each plugin currently stands. It lists the registered marketplaces and, for every installed plugin, its pinned commit, its detected capabilities, the loader rows it owns, and whether those rows are enabled, disabled, absent, or unnecessary. The tab reads on mount and offers a retry after a failed read. It has no write action: installing, uninstalling, and enabling stay on the `dsh plugin marketplace` command line.

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

Each installed plugin is one card. The title is the plugin name, and the tag beside it is its state: **enabled** when every loader row it owns is present and on, **disabled** when they are present and off, **not mounted** when state records the plugin but the patch layer has no matching row, and **skills only** when it owns no loader row at all. Below the tag the card shows the pinned commit, the capabilities detected on disk, the row ids themselves, and the content directory. The provenance line under the facts names the marketplace the plugin came from.

The **skills only** state is not a fault and is not toned like one. A plugin whose only capability is skills mounts no loader row, because `skill-filesystem` discovers skills from the filesystem; calling that disabled would tell the user a live plugin is off.

### Retrying a failed read

A failed read renders a short failure line with a **Retry** button. The panel does not surface a transport code, because the actionable part is the retry and the code would not change what the user does next.

## Understand the implementation

### Design concept

**A status reader, not a controller.** Every action this package could offer is a filesystem mutation — fetch a repository, write a plugin directory, rewrite the patch layer — and those belong to the CLI, which runs with the user's own authority on their own machine. A browser-driven install would need a permission model, a confirmation step, and a partial-failure story, and none of those exist yet. So this surface reads, and says so by having no buttons that write.

**Nothing is cached.** The Host reads the state file and parses the patch layer on each call. Both change underneath a running harness: the CLI can install or disable something while the browser is open, and Cordis HMR can rewrite the patch layer at any moment. A cached snapshot would need an invalidation path for every writer, and the read is cheap enough that it needs none.

### What the Host read guarantees

The Host's `status()` never materializes. `materializeEntry` copies skills into the discovery root and can park them under `.disabled`, so a status read built on it would mutate the user's disk as a side effect of opening a settings tab. Row ids are derived from each installed plugin's `.mcp.json` instead, which is the same derivation the writer performs, so the two agree without either one writing.

Enablement comes from the patch layer and nowhere else, matching the ownership rule the marketplace package states: existence and provenance live in the state file, enablement lives in the patch layer. There is exactly one answer to "is it on", and this read reports it rather than a copy.

### Source map

| File | Role |
|---|---|
| `src/client/index.ts` | registers the tab into `settings.plugins.tab` and unwraps the Remote result |
| `src/client/MarketplaceSettingsTab.tsx` | the panel: both sections, the state tags, and the retry state |
| `src/client/locales.ts` | the `settings.marketplace` dictionaries, key union declared first |
| `src/index.ts` | host loader entry with no host-side behavior |
| — | No runtime invariant companion is published; this package owns no durable state, performs no write, and contributes one read-only settings tab. |

## Further Exploration

- `packages/host/plugin-marketplace` — the marketplace itself: parsing, fetching, and the Remote face this tab reads.
- `packages/client/ui-settings-plugin-inventory` — the sibling Plugins tab, which lists the Loader's own entries.
- `packages/client/ui-settings-plugins` — the section that declares `settings.plugins.tab` and renders each contribution.
- `packages/client/ui-slots` — the slot registry and the locale contract this tab registers against.

## Model Experience

### The marketplace panel

#### What the model sees

Nothing. The panel is a Settings surface for the human operator: no part of it reaches the system prompt, the tool block, or the message stream, and the model cannot read or invoke it. What the panel REPORTS — a plugin's install path, pinned commit, and row ids — describes what is mounted elsewhere, and anything that does reach the model does so through those mounted rows and discovered skills rather than through this tab: an MCP row appears as `mcp__<serverName>__<tool>` tools, and a discovered skill appears as one catalog line the model reaches through the `skill` tool.

#### Token effect

Zero. No contribution of this package is added to a request, and the panel's own text is rendered only while a human has the tab open.

#### KV Cache effect

None. Opening, reading, or closing the panel changes nothing in the request prefix, so no cache boundary moves.

## Known Limitations and Deferred Work

- **It reads and cannot act.** Installing, uninstalling, enabling, and disabling are CLI-only. A browser-driven write needs a permission and confirmation story this package does not have.
- **A failed read is not diagnosed.** The panel shows one generic failure with a retry, because the Host's error text is a filesystem or parse diagnosis that the operator resolves in a terminal.
- **The two sections are lists, not a search.** A marketplace with hundreds of plugins is browsed from the CLI; this tab exists to answer "what did I install, and is it on?" rather than "what could I install?".
- **No update or version view.** The panel shows the pinned commit but not whether the marketplace now lists a newer one, because nothing in this package resolves upstream revisions.

### Dev Note

Two decisions here were forced by the build rather than chosen, and both are recorded because the next person will otherwise rediscover them the hard way:

- The Host's `status()` return type reaches the BROWSER compilation face through the generated Remote declaration. An earlier version re-exported the wire contract from the gateway module, which made the client build resolve that module and compile the entire Node-side package — `node:fs`, `node:url` and all — for a browser target. The contract therefore lives in `types.ts` alone, and the gateway imports it without re-exporting.
- The same constraint removed an import of `PROFILE_PATCH_FILENAME` from `@deepseek-ai/dsh-app-boot`, which is Node-only. The literal is used instead, with a comment naming the package that owns the real constant.
