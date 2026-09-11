/**
 * Marketplace state file — what the marketplace has installed, and where from.
 *
 * SCOPE, deliberately narrow: this file records EXISTENCE and PROVENANCE only
 * (which marketplace, which entry, which pinned sha, where it landed). It does
 * NOT record enablement — that lives in the patch layer, where a user can see
 * and hand-edit it. Splitting a single fact across two files is how the
 * "I disabled it and it came back" class of bug happens, so enablement has
 * exactly one home.
 *
 * The file is a plain JSON document under the harness home. A missing file is
 * a normal first run; a CORRUPT one is an error rather than an empty default,
 * because silently discarding the record of what was installed would orphan
 * every row the marketplace put in the user's patch layer.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Bump when the on-disk shape changes incompatibly. */
export const MARKETPLACE_STATE_VERSION = 1

/** One installed entry, keyed by its stable id. */
export interface InstalledEntry {
  /** Stable identity; also the patch row id. Namespaced `marketplace:<plugin>`. */
  id: string
  /** Marketplace this came from (the manifest's `name`). */
  marketplace: string
  /** The entry name inside that marketplace. */
  plugin: string
  /** Source url as resolved at install time. */
  sourceUrl: string
  /** Pinned commit, when the source is a git url. */
  sha?: string
  /** Subdirectory inside the repo, for `git-subdir` sources. */
  subdirectory?: string
  /**
   * Repository root this plugin came from, when the marketplace is a git repo.
   *
   * Needed to resolve a relative `local` source: the marketplace format defines
   * `./plugins/x` against the MARKETPLACE ROOT, not the process working
   * directory, so an absolute path cannot be built without the root. Absent for
   * a directly-registered manifest url whose root cannot be derived.
   */
  repoUrl?: string
  /** Absolute path the content was materialized to. */
  installPath: string
  /**
   * Patch rows this entry owns, as last composed by sync.
   *
   * Recorded rather than recomputed because a row id is NOT a function of the
   * plugin name: an MCP row is keyed on the sanitized SERVER name, and one
   * plugin may declare several. Enablement and uninstall address rows by these
   * ids, so recomputing would toggle rows that do not exist and report success.
   *
   * Optional: a state file written before this field existed still loads, and
   * the next sync fills it in.
   */
  rowIds?: string[]
  /**
   * Discovery-root entries this entry owns, as last materialized by sync.
   *
   * Recorded rather than recomputed for the same reason as `rowIds`: the skills
   * root is FLAT, so one plugin contributes SEVERAL entries named after its own
   * `skills/` children, and the set changes when the plugin's content does.
   * Enablement and uninstall address exactly these names — a caller that
   * recomputed them would move entries that do not exist, or leave every
   * materialized skill behind on uninstall.
   *
   * Optional: a state file written before this field existed still loads, and
   * the next sync fills it in.
   */
  skillIds?: string[]
  /** Capabilities detected on disk after fetching. */
  capabilities: readonly InstalledCapability[]
  installedAt: string
}

/**
 * What an installed plugin contributes, decided by what is on disk.
 *
 * Deliberately EXCLUDES a loader-mountable runtime entry. Measured against the
 * 294-plugin official registry: no entry ships one — the only plugins carrying a
 * `package.json` are MCP-server sources (dependencies, no `main`/`exports`),
 * which arrive through the `mcp` path instead. Listing a `plugin` capability we
 * cannot mount would put a claim in the state file that no code acts on.
 */
export type InstalledCapability = 'skills' | 'commands' | 'mcp'

/**
 * Everything the harness knows about marketplaces: what is registered, and
 * what is installed.
 *
 * Existence and provenance only. Enablement is NOT here; it lives in the patch
 * layer, where the user can read and hand-edit it: one home for the fact, so a
 * state rewrite cannot resurrect a plugin the user turned off.
 */
export interface MarketplaceState {
  version: number
  /** Registry manifests the user has added. */
  marketplaces: readonly { name: string; url: string }[]
  installed: readonly InstalledEntry[]
}

/**
 * Read-path failure: the state file cannot be read, parsed, or trusted.
 *
 * Only `loadState` and its row parser throw this, and they throw rather than
 * degrade to an empty state — a caller that cannot tell "nothing installed"
 * from "the record is unreadable" would orphan every row the marketplace owns.
 */
export class MarketplaceStateError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MarketplaceStateError'
  }
}

/**
 * The state a harness that has never installed anything should see.
 *
 * A missing file is a normal first run (see loadState), so there is one
 * well-formed empty document to return instead of special-casing absence at
 * every read site.
 *
 * @returns a fresh state at the current version with nothing registered and
 * nothing installed.
 */
export function emptyState(): MarketplaceState {
  return { version: MARKETPLACE_STATE_VERSION, marketplaces: [], installed: [] }
}

/**
 * Default state location: `<harnessHome>/marketplace/state.json`.
 *
 * @param harnessHome - the harness home whose `marketplace/` directory holds
 * the state.
 * @returns the path of that state file.
 */
export function defaultStatePath(harnessHome: string): string {
  return join(harnessHome, 'marketplace', 'state.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

const CAPABILITIES: readonly InstalledCapability[] = ['skills', 'commands', 'mcp']

/** The required string fields of one installed record. */
type InstalledStrings = Pick<
  InstalledEntry,
  'id' | 'marketplace' | 'plugin' | 'sourceUrl' | 'installPath' | 'installedAt'
>

/**
 * Read the required string fields, refusing a record that omits any.
 *
 * Each field is proved defined by narrowing the local itself — an early
 * throw per field — rather than by a non-null assertion later. A loop over
 * `Object.entries` cannot narrow anything, because the compiler sees a
 * `[string, string | undefined]` pair rather than the property it came from.
 *
 * @param raw - the unvalidated record.
 * @param index - its position in the array, for the error message.
 * @returns the six required string fields, all defined.
 * @throws {MarketplaceStateError} when one is missing or empty.
 */
function requireInstalledStrings(raw: Record<string, unknown>, index: number): InstalledStrings {
  const id = asString(raw.id)
  const marketplace = asString(raw.marketplace)
  const plugin = asString(raw.plugin)
  const sourceUrl = asString(raw.sourceUrl)
  const installPath = asString(raw.installPath)
  const installedAt = asString(raw.installedAt)
  const missing = (field: string): never => {
    throw new MarketplaceStateError(`installed[${String(index)}] is missing ${field}`)
  }
  return {
    id: id ?? missing('id'),
    marketplace: marketplace ?? missing('marketplace'),
    plugin: plugin ?? missing('plugin'),
    sourceUrl: sourceUrl ?? missing('sourceUrl'),
    installPath: installPath ?? missing('installPath'),
    installedAt: installedAt ?? missing('installedAt'),
  }
}

function parseInstalled(raw: unknown, index: number): InstalledEntry {
  if (!isRecord(raw)) throw new MarketplaceStateError(`installed[${String(index)}] is not an object`)
  const required = requireInstalledStrings(raw, index)
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((c): c is InstalledCapability => typeof c === 'string' && (CAPABILITIES as readonly string[]).includes(c))
    : []
  const sha = asString(raw.sha)
  const subdirectory = asString(raw.subdirectory)
  // Sanitized, not trusted: an id that is not a string cannot address a patch
  // row, and keeping it would make enablement silently match nothing.
  const rowIds = Array.isArray(raw.rowIds)
    ? raw.rowIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : undefined
  // Sanitized for the same reason as rowIds: a name that is not a non-empty
  // string cannot address a discovery-root entry, and keeping it would make
  // enablement and uninstall silently skip that skill.
  const skillIds = Array.isArray(raw.skillIds)
    ? raw.skillIds.filter((id): id is string => typeof id === 'string' && id !== '')
    : undefined
  const repoUrl = asString(raw.repoUrl)
  return {
    ...required,
    ...(sha !== undefined ? { sha } : {}),
    ...(subdirectory !== undefined ? { subdirectory } : {}),
    ...(repoUrl !== undefined ? { repoUrl } : {}),
    ...(rowIds !== undefined ? { rowIds } : {}),
    ...(skillIds !== undefined ? { skillIds } : {}),
    capabilities,
  }
}

/**
 * Read the state file.
 *
 * @param path - the state file to read; an absent file is a normal first run
 * and yields an empty state.
 * @returns the parsed state, sanitized rather than trusted: registrations
 * missing a name or url are dropped, and unknown capabilities are filtered
 * out. A version newer than this build refuses instead, so an older build
 * never rewrites fields it cannot see.
 * @throws {MarketplaceStateError} when the document exists but cannot be
 * trusted — an unreadable record of installed plugins is worse than none,
 * because callers would then re-install or orphan rows.
 */
export function loadState(path: string): MarketplaceState {
  let content: string
  try {
    content = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw new MarketplaceStateError(`cannot read marketplace state ${path}`, { cause: error })
  }

  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch (error) {
    throw new MarketplaceStateError(`marketplace state ${path} is not valid JSON`, { cause: error })
  }
  if (!isRecord(raw)) throw new MarketplaceStateError(`marketplace state ${path} is not an object`)

  const version = typeof raw.version === 'number' ? raw.version : undefined
  if (version === undefined) throw new MarketplaceStateError(`marketplace state ${path} has no version`)
  if (version > MARKETPLACE_STATE_VERSION) {
    // A newer DSH wrote this. Downgrading the file would lose fields we do not
    // understand, so refuse rather than guess.
    throw new MarketplaceStateError(
      `marketplace state ${path} is version ${String(version)}, newer than this build understands (${String(MARKETPLACE_STATE_VERSION)})`,
    )
  }

  const marketplaces = Array.isArray(raw.marketplaces)
    ? raw.marketplaces.flatMap((m) => {
      if (!isRecord(m)) return []
      const name = asString(m.name)
      const url = asString(m.url)
      return name !== undefined && url !== undefined ? [{ name, url }] : []
    })
    : []

  const installed = Array.isArray(raw.installed) ? raw.installed.map((entry, index) => parseInstalled(entry, index)) : []

  const seen = new Set<string>()
  for (const entry of installed) {
    if (seen.has(entry.id)) throw new MarketplaceStateError(`marketplace state ${path} lists id ${entry.id} twice`)
    seen.add(entry.id)
  }

  return { version, marketplaces, installed }
}

/**
 * Write the state file atomically enough for a single-user CLI (tmp + rename).
 *
 * rename is atomic on the same volume, so a crash mid-write leaves the previous
 * file intact rather than a truncated one: this file records what is installed,
 * and half a record is worse than a stale one.
 *
 * @param path - the state file to replace; missing parent directories are
 * created.
 * @param state - the whole document to serialize; callers pass the result of
 * an updater below rather than a partially updated object.
 */
export function saveState(path: string, state: MarketplaceState): void {
  mkdirSync(dirname(path), { recursive: true })
  const text = `${JSON.stringify(state, null, 2)}\n`
  const temp = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temp, text, 'utf8')
  // rename is atomic on the same volume, so a crash cannot leave a half file.
  renameSync(temp, path)
}

/**
 * Add or replace one installed entry, preserving order for everything else.
 *
 * Replacement is in place rather than an append, so re-installing (an upgrade)
 * rewrites one record and leaves the list order — and therefore the order a
 * user sees — untouched.
 *
 * @param state - the state to copy; the argument is never mutated.
 * @param entry - the record to insert, matched against existing entries by its
 * `id`.
 * @returns a new state with the entry in place, or appended when its id is new.
 */
export function upsertInstalled(state: MarketplaceState, entry: InstalledEntry): MarketplaceState {
  const at = state.installed.findIndex(existing => existing.id === entry.id)
  const installed = at === -1
    ? [...state.installed, entry]
    : state.installed.map((existing, index) => (index === at ? entry : existing))
  return { ...state, installed }
}

/**
 * Remove one installed entry. A no-op when the id is absent.
 *
 * Absence is not an error: the caller's intent is that the id is not
 * installed, and that intent already holds — so no caller needs a findInstalled
 * pre-check just to delete safely.
 *
 * @param state - the state to copy; the argument is never mutated.
 * @param id - the `InstalledEntry.id` to drop, normally from rowIdFor.
 * @returns a new state without that entry, or an equal state when the id was
 * not recorded.
 */
export function removeInstalled(state: MarketplaceState, id: string): MarketplaceState {
  return { ...state, installed: state.installed.filter(entry => entry.id !== id) }
}

/**
 * Register a marketplace url, replacing any same-named registration.
 *
 * The name is the registration's identity, so re-adding one is a re-point
 * rather than a duplicate — and it moves to the end of the list, which is the
 * order `resolveEntry` searches when two marketplaces could list the same
 * plugin name.
 *
 * @param state - the state to copy; the argument is never mutated.
 * @param name - the marketplace name that identifies the registration.
 * @param url - the manifest url that name now resolves to.
 * @returns a new state whose registrations carry this name/url pair last.
 */
export function upsertMarketplace(state: MarketplaceState, name: string, url: string): MarketplaceState {
  const others = state.marketplaces.filter(m => m.name !== name)
  return { ...state, marketplaces: [...others, { name, url }] }
}

/**
 * Look up one installed entry.
 *
 * @param state - the state to search.
 * @param id - the `InstalledEntry.id` to match, normally from rowIdFor.
 * @returns the matching entry, or undefined when this state records no entry
 * under that id.
 */
export function findInstalled(state: MarketplaceState, id: string): InstalledEntry | undefined {
  return state.installed.find(entry => entry.id === id)
}

/**
 * The patch-layer row id for one entry. Central so install and sync cannot
 * drift.
 *
 * Deriving the id from the plugin name alone is what lets install, uninstall,
 * and the command surface agree on a row without reading the state file, and
 * the `marketplace:` prefix keeps those rows from colliding with anything else
 * the patch layer mounts.
 *
 * @param plugin - the plugin name as it appears inside its marketplace.
 * @returns the namespaced id used for both the installed record and its patch
 * row.
 */
export function rowIdFor(plugin: string): string {
  return `marketplace:${plugin}`
}
