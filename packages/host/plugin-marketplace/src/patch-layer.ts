/**
 * Merge marketplace-managed rows into a user patch layer.
 *
 * THE contract this file exists to hold: a user's `cordis.patch.yml` may
 * already contain unrelated hand-written patches, and DSH's own guide says
 * "Do not copy over an existing file: it may already contain unrelated user
 * patches" (docs/user/guide/mcp-memory.md). So this module never regenerates
 * the file from a template — it reads what is there, changes only the ids it
 * owns, and writes the rest back untouched.
 *
 * Round-trip notes, both measured against vendor/include:
 *  - `entryListSchema` is `yaml.JSON_SCHEMA.extend(JsExpr)`, and
 *    `yaml.dump(…, { schema: entryListSchema })` prints `!!js` expressions
 *    VERBATIM, unevaluated. So a config value like `!!js process.cwd()` survives
 *    a parse/dump cycle.
 *  - The cost is COMMENTS: a full dump cannot keep them. We therefore only
 *    rewrite the file when the composed rows actually change, so an idempotent
 *    sync does not churn a hand-annotated file.
 *
 * WHO OWNS WHAT (the invariant that keeps this from having two sources of truth):
 *  - EXISTENCE of a managed row  -> the marketplace state file.
 *  - ORIGIN of one           -> the `marketplace:` id namespace, because a row
 *    whose plugin was uninstalled is named by neither the desired set nor a state
 *    record that went with the plugin.
 *  - ENABLEMENT (`disabled`)                    -> the patch file, because a user
 *    can edit it by hand and the guide encourages exactly that. A sync reads the
 *    current `disabled` back before composing, so hand edits are never clobbered;
 *    `setEnabled` is the only path that flips it.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { isManagedRowId } from './state.ts'

/** One row the marketplace wants to exist in the patch layer. */
export interface ManagedRow {
  /** Stable identity; also the patch row's `id`. Namespaced by the caller. */
  id: string
  /** Module specifier mounted by the loader (`options.name`). */
  name: string
  /** Row config. `undefined` means "no config key at all". */
  config?: unknown
}

/** A parsed user patch layer: the raw patch list, preserved in order. */
export interface ParsedPatchLayer {
  patches: PatchOptions[]
  /** True when the file did not exist or was empty. */
  empty: boolean
}

/**
 * Raised when the patch layer cannot be read, parsed, or safely rewritten.
 *
 * Every throw site is a deliberate refusal, not a bug: the module prefers to
 * fail rather than persist or overwrite a document it cannot read back, so a
 * caller that catches this can count on the user's `cordis.patch.yml` being
 * exactly as it was.
 */
export class PatchLayerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PatchLayerError'
  }
}

/**
 * Parse a user patch layer.
 *
 * A missing file is a normal first run, not an error. A malformed one IS an
 * error: silently rewriting a file we failed to understand would destroy
 * whatever the user wrote, and the guide explicitly warns against that.
 *
 * @param path - the patch layer file to read; a first run has none yet, so a
 * missing file must not look like a failure.
 * @returns the parsed patch list in file order, plus whether the source held
 * no patch list at all (missing, empty, or an empty document).
 * @throws {PatchLayerError} when the file exists but cannot be read, is not a
 * YAML list, or does not parse — rewriting it would lose the user's patches.
 */
export function parsePatchLayer(path: string): ParsedPatchLayer {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { patches: [], empty: true }
    throw new PatchLayerError(`cannot read patch layer ${path}`, { cause: error })
  }
  if (content.trim() === '') return { patches: [], empty: true }

  let parsed: unknown
  try {
    parsed = yaml.load(content, { schema: entryListSchema })
  } catch (error) {
    throw new PatchLayerError(`cannot parse patch layer ${path}; refusing to rewrite it`, { cause: error })
  }
  // An empty document (`[]`) is the profile template's initial state.
  if (parsed === undefined || parsed === null) return { patches: [], empty: true }
  if (!Array.isArray(parsed)) {
    throw new PatchLayerError(`patch layer ${path} is not a YAML list; refusing to rewrite it`)
  }
  return { patches: parsed as PatchOptions[], empty: false }
}

/**
 * A row that is actually mounted at the root, and therefore addressable.
 *
 * Narrower than `EntryOptions` on purpose. `EntryOptions` is a loose patch shape
 * with an index signature, so its `id` behaves like `any` and a `row.id !==
 * undefined` guard on it is dead code the linter rightly rejects. A root row has
 * a real id — that is what makes it mountable and what enablement addresses —
 * so the narrowing happens once, at the boundary, and every consumer below works
 * with a type whose guarantees are true.
 */
interface RootRow extends EntryOptions {
  id: string
}

/** Whether one inserted row carries the id that makes it a root row. */
function hasId(row: EntryOptions): row is RootRow {
  return typeof row.id === 'string' && row.id !== ''
}

/** Find the root-level rows a patch list inserts (those are the mountable ones). */
function rootRows(patches: readonly PatchOptions[]): RootRow[] {
  const rows: RootRow[] = []
  for (const patch of patches) {
    // An `insert` WITH an id targets a group's config, not the root list, so it
    // is not a root row. Only an id-less insert appends at the root.
    if (Array.isArray(patch.insert) && patch.id === undefined) rows.push(...patch.insert.filter(hasId))
  }
  return rows
}

/**
 * The effective enablement of an id, read back from the user's layer.
 *
 * Enablement is owned by the patch file rather than by marketplace state (see
 * this file's header), so reading it back here is the only way to observe a
 * toggle the user flipped by hand.
 *
 * @param patches - the parsed patch list to read.
 * @param id - the row id whose enablement is wanted.
 * @returns true when the row is present and not disabled, false when it is
 * present and disabled, and undefined when nothing claims the id — callers
 * must not read "absent" as "disabled".
 */
export function readEnabled(patches: readonly PatchOptions[], id: string): boolean | undefined {
  for (const row of rootRows(patches)) {
    if (row.id === id) return row.disabled !== true
  }
  // A later id-targeted patch can flip a row without re-inserting it.
  for (const patch of patches) {
    if (patch.id === id && patch.insert === undefined && 'disabled' in patch) {
      return (patch as { disabled?: unknown }).disabled !== true
    }
  }
  return undefined
}

/**
 * Ids already present as root rows — used to avoid the duplicate-insert trap.
 *
 * Scoped to root rows on purpose: an `insert` that carries an id targets a
 * group's config rather than the root list, so such a row cannot collide with
 * a root insert here.
 *
 * @param patches - the parsed patch list to scan.
 * @returns every id a root-level row already occupies.
 */
export function presentIds(patches: readonly PatchOptions[]): Set<string> {
  const ids = new Set<string>()
  for (const row of rootRows(patches)) ids.add(row.id)
  return ids
}

/**
 * Compose the desired rows into the existing patch list.
 *
 * Ordering rule: managed rows are appended as ONE id-less `insert` at the end,
 * so the user's own ordering and grouping stay exactly as written. Rows the
 * marketplace already inserted are removed from the composition first — both
 * to keep the operation idempotent and because `insert` pushes, so leaving them
 * would duplicate every row on the second sync.
 *
 * A row already present under a DIFFERENT mount (`name`) is left alone and
 * reported: something else owns that id and silently retargeting it would break
 * that owner.
 *
 * @param parsed - the user's current layer; its rows are carried over in order
 * so the grouping and ordering they wrote survive the compose.
 * @param desired - the rows the marketplace wants to exist. Only existence and
 * shape come from here: `disabled` is carried over from the existing row
 * instead, because the patch file owns enablement.
 * @returns the next patch list, one message per id already mounted under a
 * different name, and whether that list differs from `parsed` — the last is
 * what lets a caller skip a write that would cost the user's comments.
 */
export function composePatchLayer(
  parsed: ParsedPatchLayer,
  desired: readonly ManagedRow[],
): { patches: PatchOptions[]; conflicts: string[]; changed: boolean } {
  const conflicts: string[] = []

  // Detect a row this package wants under an id something else already mounted.
  const existingById = new Map<string, RootRow>()
  for (const row of rootRows(parsed.patches)) existingById.set(row.id, row)
  const desiredById = new Map(desired.map(row => [row.id, row]))
  for (const row of desired) {
    const existing = existingById.get(row.id)
    if (existing !== undefined && existing.name !== row.name) {
      conflicts.push(`${row.id} is already mounted as ${existing.name}; leaving it untouched`)
    }
  }

  const kept: PatchOptions[] = []
  for (const patch of parsed.patches) {
    if (Array.isArray(patch.insert) && patch.id === undefined) {
      // Preserve user rows. A row this package inserted is dropped even when it
      // is no longer desired — that is what removes the rows of an uninstalled
      // plugin — while a foreign row that sits under our id and mount survives,
      // because silently retargeting another owner's row breaks that owner.
      const survivors = patch.insert.filter((row): boolean => {
        if (!hasId(row) || !isManagedRowId(row.id)) return true
        const want = desiredById.get(row.id)
        return want !== undefined && row.name !== want.name
      })
      if (survivors.length > 0) kept.push({ ...patch, insert: survivors })
      continue
    }
    kept.push(patch)
  }

  const insertable = desired.filter(row => !conflicts.some(c => c.startsWith(`${row.id} `)))
  const next: PatchOptions[] = [...kept]
  if (insertable.length > 0) {
    next.push({
      insert: insertable.map((row) => {
        // CARRY ENABLEMENT FORWARD. `desired` describes existence and shape; it
        // deliberately says nothing about `disabled`. Rebuilding the row without
        // this would erase a toggle the user set by hand (or that setEnabled
        // wrote) on the very next sync — the two-sources-of-truth failure this
        // file's header exists to prevent. Measured: omitting it loses the flag.
        const existing = existingById.get(row.id)
        const disabled = existing?.disabled
        return {
          id: row.id,
          name: row.name,
          ...(row.config !== undefined ? { config: row.config } : {}),
          ...(disabled !== undefined ? { disabled } : {}),
        }
      }),
    })
  }

  // Canonical comparison. `sortKeys` matters: without it, a user row whose keys
  // happen to be written in a different order (e.g. `disabled` above `config`,
  // which is perfectly valid YAML) makes every sync look like a change and
  // rewrites the file — destroying their comments for no reason. Measured: the
  // key-order difference alone flipped `changed` to true on identical values.
  const before = canonicalDump(parsed.patches)
  const after = canonicalDump(next)
  return { patches: next, conflicts, changed: before !== after }
}

/** Deterministic serialization used only for change detection. */
function canonicalDump(patches: readonly PatchOptions[]): string {
  return yaml.dump(patches, { schema: entryListSchema, noRefs: true, sortKeys: true })
}

/**
 * Serialize a composed patch layer.
 *
 * The header is a comment, and a full dump cannot preserve comments elsewhere —
 * which is why callers only write when `changed` is true.
 *
 * @param patches - the composed list to render.
 * @returns the full file text: the marketplace header comment followed by the
 * YAML dump, with `!!js` expressions printed verbatim.
 */
export function serializePatchLayer(patches: readonly PatchOptions[]): string {
  const header = [
    '# User patch layer — applied over every bundle layer of every profile.',
    '#',
    '# Sections delimited by "marketplace:" are maintained by the plugin',
    '# marketplace. Rows it does not own are never rewritten; enablement is the',
    '# `disabled` key, and editing it here by hand is supported.',
    '',
  ].join('\n')
  return `${header}${yaml.dump(patches, { schema: entryListSchema, noRefs: true })}`
}

/**
 * Write the composed layer only when the composition actually changed.
 *
 * @param path - the patch layer file to rewrite.
 * @param composed - the composed list and the caller's verdict on whether it
 * changed. The verdict is trusted rather than recomputed, so a caller that
 * already paid for the comparison does not pay twice.
 * @returns true when the file was written.
 */
export function writePatchLayerIfChanged(
  path: string,
  composed: { patches: PatchOptions[]; changed: boolean },
): boolean {
  if (!composed.changed) return false
  const text = serializePatchLayer(composed.patches)
  // Re-parse before writing: never persist a document we cannot read back, or a
  // serialization bug becomes a destroyed user file.
  try {
    yaml.load(text, { schema: entryListSchema })
  } catch (error) {
    throw new PatchLayerError('refusing to write a patch layer that does not round-trip', { cause: error })
  }
  writeFileSync(path, text, 'utf8')
  return true
}

/**
 * Toggle one managed row's enablement, IN THE PATCH LAYER.
 *
 * Enablement lives here and nowhere else (see this file's header): writing it
 * into the state file as well would create a second answer to the same
 * question, and the loser of that disagreement is always whichever the user
 * hand-edited. So this rewrites exactly one root row's `disabled` key.
 *
 * Implemented as an in-place edit of the row object rather than a separate
 * id-targeted patch: an id-targeted patch must carry a matching `name`, and if
 * the row is later re-inserted elsewhere the toggle would silently stop
 * applying. A flag on the row itself cannot drift from the row.
 *
 * @param path - the patch layer that holds the row.
 * @param id - the id of the root row whose `disabled` key is rewritten.
 * @param enabled - true to enable the row, false to disable it.
 * @returns true when the file was written; false when the row is absent.
 * Also false when the row already holds the requested state, since the file is
 * then left alone.
 */
export function setEnabled(path: string, id: string, enabled: boolean): boolean {
  const parsed = parsePatchLayer(path)

  // Decided as a plain computation rather than a flag a closure sets. A `let`
  // mutated inside a callback reads as its initial value to the compiler at the
  // later check, so that shape both needs a suppression and is easy to get
  // wrong; `some` on the same data is the same question with a narrower answer.
  const holdsId = parsed.patches.some(
    patch => Array.isArray(patch.insert) && patch.id === undefined && patch.insert.some(row => row.id === id),
  )
  if (!holdsId) return false

  const rows: PatchOptions[] = parsed.patches.map((patch) => {
    if (!Array.isArray(patch.insert) || patch.id !== undefined) return patch
    const insert = patch.insert.map((row) => {
      if (row.id !== id) return row
      // OMIT the key when enabling, rather than writing `disabled: undefined`.
      // `exactOptionalPropertyTypes` rejects the explicit `undefined` form, and
      // omitting also keeps the emitted YAML clean (no `disabled: false` noise)
      // since an absent `disabled` already means enabled.
      const { disabled: _was, ...rest } = row
      return enabled ? rest : { ...rest, disabled: true }
    })
    return { ...patch, insert }
  })

  const before = canonicalDump(parsed.patches)
  const after = canonicalDump(rows)
  if (before === after) return false
  writePatchLayerIfChanged(path, { patches: rows, changed: true })
  return true
}
