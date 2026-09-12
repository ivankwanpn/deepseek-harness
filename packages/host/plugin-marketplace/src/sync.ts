/**
 * Reconcile the marketplace state file into the two surfaces it drives.
 *
 * This is the only function that writes on the marketplace's behalf, so it is
 * deliberately the narrowest possible seam: it reads state, materializes what
 * each entry carries, derives the loader rows, and merges them into the user
 * patch layer. It does not fetch, clone, or decide enablement — those belong to
 * install and to the patch layer respectively.
 *
 * Runs are idempotent. Re-syncing with an unchanged state writes nothing, which
 * matters because a write re-serializes the patch file and a full dump cannot
 * preserve the user's comments (see patch-layer.ts).
 */
import {
  composePatchLayer,
  parsePatchLayer,
  writePatchLayerIfChanged,
  type ManagedRow,
} from './patch-layer.ts'
import { materializeEntry, skillEntryNames, type MaterializeOptions, type MaterializeResult } from './materialize.ts'
import { saveState, type MarketplaceState } from './state.ts'

/** Where a sync reads its inputs from and writes its result to. */
export interface SyncOptions {
  /** The user patch layer to merge into. */
  patchLayerPath: string
  /** Where materialized skills go; see MaterializeOptions. */
  materialize: MaterializeOptions
  /**
   * State file to write the resolved row ids back to.
   *
   * Row ids are not derivable from a plugin name, so the entry that owns them
   * has to carry them; sync is where they are resolved, so sync is what records
   * them. Omitting the path makes the reconcile read-only, which is what a
   * purely diagnostic caller wants.
   */
  statePath?: string
}

/** What one sync did, and what it wants to tell the user. */
export interface SyncResult {
  /** Rows the composed layer should contain for marketplace entries. */
  rows: ManagedRow[]
  /** True when the patch file was rewritten. */
  wrotePatchLayer: boolean
  /** True when state was rewritten to record resolved ownership. */
  wroteState: boolean
  /** Ids that two entries claim; these are skipped, never guessed between. */
  duplicateRowIds: string[]
  /** Ids already mounted by something that is not us; left untouched. */
  foreignRowIds: string[]
  /** Per-plugin notes worth showing the user. */
  warnings: string[]
  /** What each entry materialized to. */
  materialized: { plugin: string; result: MaterializeResult }[]
}

/**
 * Sync state into the patch layer and the skills root.
 *
 * @param state - the installed record to reconcile; unchanged entries still
 * re-materialize, so this is safe to call after any external edit.
 * @param options - the patch layer to merge into, where skills belong, and
 * where the resolved row ids are recorded.
 * @returns what was composed, whether the patch file or the state file changed,
 * and the conflicts and warnings worth surfacing.
 * @throws {PatchLayerError} when the patch layer cannot be parsed — refusing to
 * rewrite a file we do not understand is the point (see patch-layer.ts).
 */
export function sync(state: MarketplaceState, options: SyncOptions): SyncResult {
  const rows: ManagedRow[] = []
  const warnings: string[] = []
  const materialized: { plugin: string; result: MaterializeResult }[] = []
  const duplicateRowIds: string[] = []

  const seen = new Map<string, string>()
  // Resolve discovery-root ownership BEFORE anything is copied. The root is
  // flat, so two entries that ship a skills entry of the same name would
  // otherwise overwrite each other, and uninstalling either would delete content
  // the other still claims. First entry in state order keeps the name; the later
  // claimant is told which plugin holds it and materializes nothing under it.
  const ownerOf = new Map<string, string>()
  for (const entry of state.installed) {
    for (const name of skillEntryNames(entry.installPath).names) {
      if (!ownerOf.has(name)) ownerOf.set(name, entry.plugin)
    }
  }
  const claimedByOthers = (plugin: string): ReadonlyMap<string, string> =>
    new Map([...ownerOf].filter(([, owner]) => owner !== plugin))

  for (const entry of state.installed) {
    const result = materializeEntry(entry, options.materialize, claimedByOthers(entry.plugin))
    materialized.push({ plugin: entry.plugin, result })
    for (const warning of result.warnings) warnings.push(`${entry.plugin}: ${warning}`)
    for (const row of result.rows) {
      const owner = seen.get(row.id)
      if (owner !== undefined) {
        // Two entries want the same mount. Picking one arbitrarily would make
        // which plugin wins depend on state-file order, so neither is mounted
        // and both are reported.
        duplicateRowIds.push(`${row.id} (claimed by ${owner} and ${entry.plugin})`)
        continue
      }
      seen.set(row.id, entry.plugin)
      rows.push(row)
    }
  }

  const parsed = parsePatchLayer(options.patchLayerPath)
  const composed = composePatchLayer(parsed, rows)
  for (const conflict of composed.conflicts) warnings.push(conflict)
  const wrotePatchLayer = writePatchLayerIfChanged(options.patchLayerPath, composed)

  // Record what each entry owns. Enablement reads rows back from the patch layer
  // by id and moves skills between the discovery root and their parked
  // directory by name, so a caller that recomputed either from the plugin name
  // would address entries that do not exist, report success, and toggle nothing.
  // Comparing before writing keeps this from re-serializing state every run.
  const wroteState = recordOwnership(state, materialized, options.statePath)

  return {
    rows,
    wrotePatchLayer,
    wroteState,
    duplicateRowIds,
    foreignRowIds: composed.conflicts,
    warnings,
    materialized,
  }
}

/**
 * Persist the row ids and skill entries each entry resolved to, when they
 * changed.
 *
 * @param state - the state whose entries are annotated; the argument is not
 * mutated.
 * @param materialized - what each entry produced during this sync.
 * @param statePath - destination for the annotated state, or undefined to skip
 * writing entirely.
 * @returns true when the state file was rewritten.
 */
function recordOwnership(
  state: MarketplaceState,
  materialized: readonly { plugin: string; result: MaterializeResult }[],
  statePath: string | undefined,
): boolean {
  if (statePath === undefined) return false
  const byPlugin = new Map(materialized.map(m => [m.plugin, m.result]))
  const sameIds = (before: readonly string[], after: readonly string[]): boolean =>
    before.length === after.length && before.every((id, i) => id === after[i])
  // Rebuilt in one pass with no mutated accumulator: the rewrite decision is
  // `some(changed)`, which the compiler can see, and the installed list carries
  // the entries that did not change by reference.
  const installed = state.installed.map((entry) => {
    const result = byPlugin.get(entry.plugin)
    const rowIds = result?.rowIds ?? []
    const skillIds = result?.skillIds ?? []
    const unchanged = sameIds(entry.rowIds ?? [], rowIds) && sameIds(entry.skillIds ?? [], skillIds)
    return unchanged ? entry : { ...entry, rowIds, skillIds }
  })
  const changed = installed.some((entry, index) => entry !== state.installed[index])
  if (!changed) return false
  saveState(statePath, { ...state, installed })
  return true
}
