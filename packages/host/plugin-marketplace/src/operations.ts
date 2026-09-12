/**
 * The write operations the CLI and the Web panel both perform.
 *
 * ONE implementation for both faces. A second copy would drift, and this
 * package's history is a list of failures caused by a caller recomputing what
 * another had already resolved (see the README's Dev Note): "which entries does
 * this plugin own" is exactly that kind of derived fact, and the two faces can
 * be open at the same time.
 *
 * @module @deepseek-ai/dsh-host-plugin-marketplace/operations
 */

import { materializeEntry, setSkillsEnabled, type MaterializeOptions } from './materialize.ts'
import { setEnabled } from './patch-layer.ts'
import type { InstalledEntry } from './state.ts'

/** Where enablement is written: rows into the patch layer, skills into the discovery root. */
export interface EnablementOptions {
  /** The user patch layer holding loader-row enablement. */
  patchLayerPath: string
  /** The harness home and skills root the owned skill entries live under. */
  materialize: MaterializeOptions
}

/** The loader rows and discovery entries one installed plugin owns. */
export interface Ownership {
  /** Patch rows the plugin owns; empty when it mounts no loader row. */
  rowIds: string[]
  /** Discovery-root entries the plugin owns; empty when it ships no skill. */
  skillIds: string[]
}

/** What one enablement change did. */
export interface EnablementResult {
  /** Loader rows whose `disabled` flag this call rewrote. */
  rowsChanged: number
  /** True when the plugin's skills moved between discovery and parking. */
  skillsMoved: boolean
  /** True when the plugin already stood in the requested state. */
  alreadyInState: boolean
  /** True when the plugin owns nothing to toggle, which is not the same as being off. */
  mountsNothing: boolean
}

/**
 * What one installed plugin owns.
 *
 * Read from the record when present. A state file written before `rowIds` or
 * `skillIds` existed has neither, so the entry is materialized to recover them —
 * that reads only the plugin directory already on disk, and the next sync
 * persists the result. Falling back to `marketplace:<plugin>`, or to the plugin
 * name, is deliberately NOT done: neither addresses anything this package
 * writes, so the caller would toggle nothing and report success.
 *
 * @param entry - the installed record to resolve ownership for.
 * @param options - the harness home and skills root the entry's content lives under.
 * @returns every row id and discovery-root entry name the plugin owns.
 */
export function ownedBy(entry: InstalledEntry, options: MaterializeOptions): Ownership {
  if (entry.rowIds !== undefined && entry.skillIds !== undefined) {
    return { rowIds: [...entry.rowIds], skillIds: [...entry.skillIds] }
  }
  let resolved: Ownership
  try {
    const materialized = materializeEntry(entry, options)
    resolved = { rowIds: materialized.rowIds, skillIds: materialized.skillIds }
  } catch {
    // A missing or unreadable plugin directory is reported by the sync that
    // follows; here it just means nothing can be named.
    resolved = { rowIds: [], skillIds: [] }
  }
  return {
    rowIds: entry.rowIds === undefined ? resolved.rowIds : [...entry.rowIds],
    skillIds: entry.skillIds === undefined ? resolved.skillIds : [...entry.skillIds],
  }
}

/**
 * Turn one installed plugin's mounts and skills on or off.
 *
 * Two mechanisms, one verb. A loader row is toggled by its `disabled` flag; a
 * skill has no row, so it is moved out of (or back into) the discovery tree.
 * Doing only one of them is how a plugin ends up half enabled.
 *
 * @param entry - the installed record to act on.
 * @param enabled - true to mount and discover, false to take both away.
 * @param options - the patch layer and skills root the write targets.
 * @returns what moved, and whether there was anything to move.
 */
export function setPluginEnabled(
  entry: InstalledEntry,
  enabled: boolean,
  options: EnablementOptions,
): EnablementResult {
  const ownership = ownedBy(entry, options.materialize)
  let rowsChanged = 0
  for (const id of ownership.rowIds) {
    if (setEnabled(options.patchLayerPath, id, enabled)) rowsChanged += 1
  }
  const skillsMoved = setSkillsEnabled(options.materialize, entry.plugin, ownership.skillIds, enabled)
  return {
    rowsChanged,
    skillsMoved,
    alreadyInState: rowsChanged === 0 && !skillsMoved,
    mountsNothing: ownership.rowIds.length === 0 && ownership.skillIds.length === 0,
  }
}
