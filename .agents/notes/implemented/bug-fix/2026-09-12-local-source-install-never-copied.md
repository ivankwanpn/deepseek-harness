# Agent Note: A local source is copied into its install, not referenced in place

Status: implemented

English | [中文](2026-09-12-local-source-install-never-copied.zh.md)

## Problem

`fetchPlugin` documented a `local` source as "used in place rather than copied" and returned the path the manifest named without touching `destination`. `installPlugin` fetches into a staging sibling and then renames that onto the install path, so the rename found nothing: installing any entry whose source is a directory — an absolute path, or a relative one whose marketplace url names no repository root — died with a raw `ENOENT` naming an internal temporary path. `installPlugin`'s own comment on the re-detection ("capabilities are read from disk, and a local source would otherwise record the pre-move path") shows the staging move was always expected to carry a local source; the fetch arm was never finished.

Reading the directory in place was also unsafe as designed. `uninstallPlugin` deletes `installPath` recursively, so recording the user's directory there would have deleted it — the same directory the manifest had merely pointed at.

[The verdict note](2026-09-12-marketplace-local-source-verdict.md) made the catalog agree with the installer about a marketplace-relative source. This is the remainder it left: a local source that resolves against no repository is still installable by the pin rule, and it crashed one step later.

## Decision

`fetchPlugin` copies a local source into `destination` exactly as it does a git source, through one `placeContent(from, destination)` that both arms call. The copy skips `.git`, so what lands under the plugins root is plugin content rather than a nested repository carrying a remote url and an object database.

Everything downstream is unchanged. The install path stays under the plugins root, the record keeps the path the manifest named as `sourceUrl` with no `sha`, and uninstall removes only what the install put there.

## Alternatives considered

**Recording the source path as the install path and skipping the move.** Rejected: `uninstallPlugin` deletes `installPath`, so this deletes the user's own directory. No wording makes that safe.

**Refusing a local source instead.** Rejected: the manifest format expresses it, the fetch layer already validates it, and the panel would offer a row that can never be installed — the dead end the verdict fix removed for the relative entries.

**Copying `.git` along with the content.** Rejected: the comment on the git arm already claimed an installed plugin is data rather than a nested repository, which was false for a whole-repository source. Both arms now share the exclusion, so the claim is true.

## Consequences

- An entry whose source is a directory installs, appears in the panel, and uninstalls, like every other entry.
- Edits to that directory do not reach the installed copy; re-installing is what carries them. The package README records this under its limitations.
- A whole-repository git source no longer installs its `.git` directory. The previous comment claimed that and the code did not do it.

## Testing

`tests/install-paths.spec.ts` installs a real directory through the real fetcher — the only step in that spec left unstubbed — and asserts the content is under the plugins root, the source directory survives, and uninstall removes the copy while leaving the source. `tests/git.spec.ts` pins the copy and the `.git` exclusion directly. All three fail against the previous in-place return, where the install case reports the original `ENOENT`.
