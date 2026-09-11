/**
 * Install one plugin from a marketplace: fetch it at its pinned revision,
 * record it, then reconcile the loader rows.
 *
 * Transactional by ordering. The order below is the point:
 *   1. resolve the entry, and refuse an unpinned source
 *   2. fetch content to a temp path, verifying the commit
 *   3. move it into the install root
 *   4. write state
 *   5. sync the patch layer
 *
 * A failure before step 4 leaves the state file untouched, so a partial install
 * is invisible to the next sync rather than becoming a row that points at a
 * directory that does not exist. A failure at step 5 leaves the plugin recorded
 * but unmounted, which the next sync repairs — the recoverable direction.
 */
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fetchMarketplace, marketplaceRepoRoot, resolveLocalSource, type FetchOptions } from './fetch.ts'
import { detectCapabilities, fetchPlugin, resolveRefSha } from './git.ts'
import type { MarketplaceEntry } from './parse.ts'
import { isPinned } from './parse.ts'
import { sync, type SyncOptions, type SyncResult } from './sync.ts'
import {
  findInstalled,
  removeInstalled,
  rowIdFor,
  saveState,
  upsertInstalled,
  upsertMarketplace,
  type InstalledEntry,
  type MarketplaceState,
} from './state.ts'

/**
 * A refused install, raised before any state is written.
 *
 * The distinction this type buys a caller: these errors are deliberate
 * diagnoses — an unpinned source, an unknown name, an unusable plugin name —
 * and each is raised before the state file is touched, so the recorded state
 * still describes the disk. Failures from fetching or moving content propagate
 * unwrapped, because there the underlying error is already the diagnosis.
 */
export class InstallError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'InstallError'
  }
}

/**
 * What an install reads, and where it writes.
 *
 * Sync options are required rather than optional because an install that
 * stopped once the row was recorded would leave the plugin registered but
 * unmounted: state and the patch layer are only consistent together, so every
 * install reconciles before it returns.
 */
export interface InstallOptions {
  state: MarketplaceState
  statePath: string
  /** Where plugin content is materialized. Defaults to `<harnessHome>/marketplace/plugins`. */
  pluginsRoot?: string
  /** Patch layer + skills root for the post-install sync. */
  sync: Omit<SyncOptions, never>
  /**
   * Install a git source that declares no `sha`, by resolving its ref to a
   * commit NOW and recording that.
   *
   * Off by default. The pin rule exists because a ref resolves at fetch time,
   * so opting in is the caller saying the manifest's missing pin is accepted —
   * which measured as 52 of the 294 official entries, none of which carries one.
   * The recorded commit keeps the install verifiable even so.
   */
  allowUnpinned?: boolean
  /** Look up the entry by name in these marketplaces, in order. */
  fetch?: FetchOptions
}

/**
 * What an install produced, including what it wants to tell the user.
 *
 * Warnings are returned instead of logged so the caller decides how loud a
 * followed rename, a plugin that mounts nothing, or a sync conflict should be.
 */
export interface InstallResult {
  entry: InstalledEntry
  synced: SyncResult
  warnings: string[]
}

/**
 * Where one plugin's content lives. Stable so re-install replaces in place.
 *
 * The plugin name is third-party input that becomes a directory name, so it is
 * sanitized: anything outside `[A-Za-z0-9._-]` becomes a dash and leading
 * dots are removed, so a name cannot escape the install root or collide with
 * a path separator. A name left with nothing usable is refused rather than
 * silently mapped somewhere else.
 *
 * @param pluginsRoot - the root every plugin directory sits under.
 * @param plugin - the plugin name as the marketplace entry declares it.
 * @returns the directory to materialize this plugin's content into.
 * @throws {InstallError} when sanitizing leaves no usable characters.
 */
export function pluginInstallPath(pluginsRoot: string, plugin: string): string {
  // The plugin name is third-party input and becomes a directory name, so strip
  // anything that could escape the root or collide with a path separator.
  const safe = plugin.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^\.+/, '')
  if (safe === '') throw new InstallError(`plugin name ${JSON.stringify(plugin)} has no usable characters`)
  return join(pluginsRoot, safe)
}

/**
 * Find an entry by name across the registered marketplaces.
 *
 * A `renames` hit is followed and reported: the registry published the rename,
 * so failing with "not found" for a name the registry itself still lists would
 * be a needless dead end.
 *
 * Every marketplace gets the literal name before any rename is followed, so an
 * exact hit in a later marketplace still outranks a rename in an earlier one.
 *
 * @param state - the registered marketplaces to search, in stored order.
 * @param plugin - the plugin name to look for.
 * @param options - fetch overrides passed to every marketplace read.
 * @returns the matching entry, the marketplace it came from, and the previous
 *   name when the match came from a published rename.
 * @throws {InstallError} when no marketplace is registered, or none lists the
 *   name directly or as a rename target.
 */
export async function resolveEntry(
  state: MarketplaceState,
  plugin: string,
  options: { fetch?: FetchOptions } = {},
): Promise<{ entry: MarketplaceEntry; marketplace: string; marketplaceUrl: string; renamedFrom?: string }> {
  if (state.marketplaces.length === 0) {
    throw new InstallError('no marketplaces registered; run `dsh plugin marketplace add <repo>` first')
  }
  for (const registration of state.marketplaces) {
    const market = await fetchMarketplace(registration.url, options.fetch ?? {})
    const direct = market.plugins.find(p => p.name === plugin)
    if (direct !== undefined) {
      return { entry: direct, marketplace: market.name, marketplaceUrl: registration.url }
    }
  }
  // Second pass: follow a published rename.
  for (const registration of state.marketplaces) {
    const market = await fetchMarketplace(registration.url, options.fetch ?? {})
    const target = market.renames[plugin]
    if (target === undefined) continue
    const renamed = market.plugins.find(p => p.name === target)
    if (renamed !== undefined) {
      return { entry: renamed, marketplace: market.name, marketplaceUrl: registration.url, renamedFrom: plugin }
    }
  }
  throw new InstallError(`no marketplace lists a plugin named ${JSON.stringify(plugin)}`)
}

/**
 * Install one plugin and reconcile it into the patch layer.
 *
 * Re-installing a name is an upgrade rather than a conflict: the content
 * directory is replaced wholesale and its state row overwritten, because a
 * tree that is half old and half new is worse than either version. The step
 * order that makes a mid-way failure safe is described at the top of the file.
 *
 * @param plugin - the plugin name to install.
 * @param options - the state to extend, where it persists, and the sync
 *   configuration the post-install reconcile runs with.
 * @returns the row that was recorded, the reconcile that followed it, and the
 *   warnings worth showing the user.
 * @throws {InstallError} when the entry cannot be resolved or its source has
 *   no sha pin; a failing fetch rethrows its own error after removing the
 *   staging directory.
 */
export async function installPlugin(plugin: string, options: InstallOptions): Promise<InstallResult> {
  const warnings: string[] = []
  const { entry, marketplace, marketplaceUrl, renamedFrom } = await resolveEntry(
    options.state,
    plugin,
    { ...(options.fetch !== undefined ? { fetch: options.fetch } : {}) },
  )
  if (renamedFrom !== undefined) warnings.push(`${renamedFrom} was renamed to ${plugin}`)

  // A marketplace-relative `local` source names content INSIDE the marketplace
  // repository, so it is resolved against that repository's root rather than
  // the process working directory. Left unresolved it would be read as a
  // cwd-relative path that almost never exists.
  const repoUrl = marketplaceRepoRoot(marketplaceUrl)
  const source = entry.source.kind === 'local'
    ? (resolveLocalSource(entry.source.path, repoUrl, entry.source.ref) ?? entry.source)
    : entry.source

  // An unpinned git source is refused by default, because a ref resolves at
  // fetch time and the same manifest could deliver different code tomorrow.
  // When the caller opts in, the refusal is replaced by a RECORDED commit: the
  // remote is asked what its ref points at now, and that commit becomes the
  // install's pin. The result is still one specific revision, and the state
  // file can be held to it — which is strictly more than a silent HEAD install.
  const resolved = source.kind === 'git' && source.sha === undefined && options.allowUnpinned === true
    ? { ...source, sha: await resolveRefSha(source.url, source.ref ?? 'HEAD') }
    : source

  if (!isPinned({ ...entry, source: resolved })) {
    throw new InstallError(
      `refusing to install ${plugin}: its source has no sha pin, so the content is not reproducible`
      + ' (pass allowUnpinned / --allow-unpinned to record the commit the ref names now)',
    )
  }

  const pluginsRoot = options.pluginsRoot ?? join(options.sync.materialize.harnessHome, 'marketplace', 'plugins')
  mkdirSync(pluginsRoot, { recursive: true })
  const destination = pluginInstallPath(pluginsRoot, plugin)

  // Fetch into a staging path first so a failure cannot leave a half-populated
  // install directory that a later sync would treat as valid.
  const staging = `${destination}.staging-${String(process.pid)}`
  rmSync(staging, { recursive: true, force: true })
  let fetched: Awaited<ReturnType<typeof fetchPlugin>>
  try {
    fetched = await fetchPlugin(resolved, staging)
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }

  rmSync(destination, { recursive: true, force: true })
  renameSync(staging, destination)
  // Re-detect against the FINAL path: capabilities are read from disk, and a
  // local source would otherwise record the pre-move path.
  const capabilities = detectCapabilities(destination)

  const installed: InstalledEntry = {
    id: rowIdFor(plugin),
    marketplace,
    plugin,
    sourceUrl: resolved.kind === 'git' ? resolved.url : resolved.path,
    // Prefer the sha git actually checked out over the manifest's declared one.
    // fetchPlugin already fails when they differ, so they agree today; recording
    // the resolved value means a future relaxation cannot leave state claiming a
    // revision the disk does not hold. For an unpinned source this is the commit
    // resolveRefSha named, which is the only revision fact available.
    ...(fetched.resolvedSha !== '' ? { sha: fetched.resolvedSha } : {}),
    // The subdirectory is recorded whenever one was fetched from, including a
    // resolved marketplace-relative source: it is what makes the recorded
    // sourceUrl and sha resolvable back to these bytes.
    ...(resolved.kind === 'git' && resolved.subdirectory !== undefined ? { subdirectory: resolved.subdirectory } : {}),
    ...(repoUrl !== undefined ? { repoUrl } : {}),
    installPath: destination,
    capabilities,
    installedAt: new Date().toISOString(),
  }

  if (capabilities.length === 0) {
    warnings.push(`${plugin} declares no skills, commands, MCP servers or runtime entry; it will install but mount nothing`)
  }

  // Record, then reconcile. Overwriting a previous install of the same plugin is
  // intentional: this is an upgrade.
  const nextState = upsertInstalled(options.state, installed)
  saveState(options.statePath, nextState)

  // statePath travels with the sync so the resolved row ids are recorded back:
  // enablement addresses rows by id, and an id is not a function of the plugin
  // name (see recordRowIds in sync.ts).
  const synced = sync(nextState, { ...options.sync, statePath: options.statePath })
  for (const w of synced.warnings) warnings.push(w)

  return { entry: installed, synced, warnings }
}

/**
 * Register a marketplace url, replacing any same-named registration.
 *
 * Replacement is by name and the registration is appended, so a newly added
 * marketplace is searched last and cannot shadow an entry an older one already
 * lists.
 *
 * @param state - the state to add to; the input is not mutated.
 * @param name - the marketplace name to register under.
 * @param url - the url the marketplace manifest is fetched from.
 * @returns the state carrying the added or replaced registration.
 */
export function addMarketplace(state: MarketplaceState, name: string, url: string): MarketplaceState {
  return upsertMarketplace(state, name, url)
}

/**
 * Uninstall: drop the record, delete the content, and let sync drop the rows.
 *
 * Content goes before the record, because the two failure directions are not
 * equal: content without a record is an orphan directory the next install
 * replaces, while a record without content is a mount that fails on every
 * session start.
 *
 * @param state - the state to remove from; the input is not mutated.
 * @param plugin - the plugin name to uninstall.
 * @param options - where the pruned state is written, and how the rows are
 *   reconciled afterwards.
 * @returns whether an install was removed, plus the reconcile that followed —
 *   it runs on the no-op path too, so callers get an up-to-date view of the
 *   patch layer either way.
 */
export function uninstallPlugin(
  state: MarketplaceState,
  plugin: string,
  options: { statePath: string; sync: SyncOptions },
): { removed: boolean; synced: SyncResult } {
  const existing = findInstalled(state, rowIdFor(plugin))
  if (existing === undefined) {
    return { removed: false, synced: sync(state, { ...options.sync, statePath: options.statePath }) }
  }
  // Delete content BEFORE dropping the record: a record without content is a
  // broken mount, while content without a record is merely an orphan directory.
  if (existsSync(existing.installPath)) rmSync(existing.installPath, { recursive: true, force: true })
  const nextState = removeInstalled(state, rowIdFor(plugin))
  saveState(options.statePath, nextState)
  const synced = sync(nextState, { ...options.sync, statePath: options.statePath })
  return { removed: true, synced }
}
