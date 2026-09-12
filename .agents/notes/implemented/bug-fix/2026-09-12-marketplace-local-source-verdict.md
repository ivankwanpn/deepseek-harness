# Agent Note: The catalog's installability verdict and the installer's refusal read one source

Status: implemented

English | [中文](2026-09-12-marketplace-local-source-verdict.zh.md)

## Problem

A marketplace entry may name its content relative to the marketplace repository: `"source": "./plugins/code-review"`. The official registry spells 52 of its 294 entries that way.

`parseSource` reads a relative path as a `local` source, and `isPinned` accepts a `local` source on the premise that the content is already on disk, so there is nothing to resolve. An install disagrees. The path names content INSIDE the marketplace repository, so `installPlugin` re-expresses it as a git subdirectory of that repository, and such a source carries no `sha`.

The catalog decided `installable` from the entry's own `local` form, so it called every relative entry installable. The panel installs an installable row in one call with `allowUnpinned: false`, so no acknowledgement appeared, and the Host then refused the request as `unpinned`. The acknowledgement dialog is the panel's only route that sends `allowUnpinned: true`, and it opens only for a row the catalog declined — so those entries could not be installed from the panel by any sequence of clicks. The CLI was unaffected: `--allow-unpinned` is a flag a user passes without consulting a verdict.

## Decision

Both faces take the source from `installSource(entry, marketplaceUrl)` in `src/fetch.ts`. It returns the entry's own source for anything that is not a relative path, and otherwise the git subdirectory `resolveLocalSource` derives against `marketplaceRepoRoot(marketplaceUrl)`. `installPlugin` and `catalog` both call it, so the pin rule is applied to one source rather than to two spellings of the same one.

`installPlugin` still computes its own `marketplaceRepoRoot`, because the install record stores that root. The rule that turns a declared path into a source lives only in `installSource`.

## Alternatives considered

**Refusing a relative source outright.** Rejected: it is the registry's own spelling for a plugin that ships inside the marketplace repository, and the fetch layer already reads it correctly. Refusing would delete a working capability to avoid a verdict mismatch.

**Treating a `local` source as pinned inside `isPinned`.** Rejected: whether the path resolves depends on the marketplace url, which `isPinned` is not given, so the rule would need a parameter it cannot supply. The premise that a `local` source is already on disk is also simply false for this form.

**Marking the row unpinned in the catalog without touching the install path.** Rejected: install is where the resolution happens and where the refusal is decided. A second, catalog-local copy of that rule is the defect being removed, not a fix for it.

## Consequences

- A relative entry renders with the unpinned tag and installs through the acknowledgement, which is the panel form of `--allow-unpinned` that the panel already implemented and could not reach.
- `installable` now means "installs without an acknowledgement" rather than "the pin rule accepts the manifest's own spelling of the source". It remains a snapshot: a marketplace can change between the read and the click.
- `src/fetch.ts` exports `installSource`. The resolution has one home, so a later change to either face cannot reintroduce the disagreement.
- [The marketplace catalog and install note](../feature/2026-09-12-marketplace-catalog-and-install.md) documented the disagreement as shipped behaviour; its `installable` row, its prose and its verification list now state the agreement.
- A local source that resolves against no repository stayed installable by the pin rule and still could not be fetched; [the install now copies it](2026-09-12-local-source-install-never-copied.md).

## Testing

`tests/catalog.spec.ts` serves a manifest from a github-shaped url and asserts `./plugins/relative` is not installable while `../outside` — which resolves to no repository root and stays local — is. Against the reverted `isPinned(entry)` it fails with `[['relative', true]]` where the verdict must be false. `tests/install-unpinned.spec.ts` runs the whole install for a relative entry: refused as `unpinned` without the opt-in, and with it resolving `HEAD` against the marketplace repository and recording the subdirectory, the repository root and the commit. Against an `installSource` that returns the declared source unchanged it fails with a resolved install where the refusal is required, which is the silent install that made the entry look pinned.
