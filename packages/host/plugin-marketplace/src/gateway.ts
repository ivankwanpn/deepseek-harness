/**
 * Remote face for the marketplace, consumed by the Web settings panel.
 *
 * READS NEVER WRITE. `status` resolves enablement from the patch layer and
 * ownership names from state, and never materializes: opening a settings tab
 * must not copy or move anything on the user's disk. The two mutations are
 * separate methods that say what they do.
 *
 * The mutations are gated HERE, in the operation that makes the decision, not by
 * hiding a button in the panel:
 *  - `allowMutations` (Config, default true) turns the write surface off for a
 *    deployment that wants a read-only panel.
 *  - Both call the same `operations.ts` entry point the CLI calls, so the two
 *    faces cannot disagree about what a plugin owns.
 *  - Every call returns the status it produced, so the panel renders post-write
 *    truth without a second round trip that could race the write it just made.
 *
 * It owns no cache. The state file and the patch layer both change underneath a
 * running harness — the CLI can install or disable something while the browser
 * is open, and Cordis HMR can rewrite the patch layer at any moment. A cached
 * snapshot would therefore need an invalidation path for every writer; reading
 * per call cannot go stale at all.
 *
 * @module @deepseek-ai/dsh-host-plugin-marketplace/gateway
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { uninstallPlugin } from './install.ts'
import { readPluginMcp, sanitizeServerName, skillEntryNames, skillsEnabled, type MaterializeOptions } from './materialize.ts'
import { setPluginEnabled } from './operations.ts'
import { parsePatchLayer, readEnabled } from './patch-layer.ts'
import { findInstalled, loadState, rowIdFor, type InstalledEntry, type MarketplaceState } from './state.ts'
import type { SyncOptions } from './sync.ts'
import type {
  InstalledPluginView,
  InstalledStateView,
  MarketplaceStatusView,
  PluginEnableRequest,
  PluginEnablementView,
  PluginRemovalView,
  PluginUninstallRequest,
  SkillsStateView,
} from './types.ts'

// NOTE: no `export type * from './types.ts'` here, deliberately. The generated
// Remote declaration names the return type through THIS module, and this module
// is Node-only (node:path, node:fs further down its graph). Re-exporting the
// wire contract from here made the browser compilation face resolve
// `@deepseek-ai/dsh-host-plugin-marketplace/gateway` and compile the whole host
// package for a browser target. `types.ts` stays the contract's only home, and
// consumers import it from the `./types` subpath.

/**
 * Name of the per-user patch layer.
 *
 * Deliberately NOT imported from `@deepseek-ai/dsh-app-boot`, which is where it
 * is defined. That package is Node-only, and this module's types are reached by
 * the BROWSER compilation face through the generated `./remote` declaration, so
 * importing it would drag `node:fs` and `node:url` into the client build. The
 * literal is the whole value; the boot package's own tests pin it.
 */
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The parsed patch rows `readEnabled` accepts, named once for its two callers. */
type PatchRows = Parameters<typeof readEnabled>[0]

/**
 * Where the panel reads from and writes to.
 *
 * Both paths are overridable so a deployment can point the Remote face at a
 * state file the CLI is not using, but a row in `cordis.yml` normally sets
 * neither: the defaults are exactly what `dsh plugin marketplace` writes.
 */
export interface Config {
  /** Harness home holding the marketplace record. @default DSH_HOME */
  harnessHome?: string
  /** State file to read. @default `<harnessHome>/marketplace/state.json` */
  statePath?: string
  /**
   * Patch layer holding enablement.
   * @default `<harnessHome>/cordis.patch.yml`, which `dsh web` watches
   * (apps/cli/src/profile-boot.ts watches both the profile layer and this one).
   */
  patchLayerPath?: string
  /**
   * Whether `setEnabled` and `uninstall` are served at all.
   *
   * A deployment that shares one harness home between users, or that wants the
   * panel to stay a pure view, sets this false: the methods then refuse and the
   * panel offers no controls. The check lives here rather than in the panel
   * because a hidden button is not an enforcement point.
   * @default true
   */
  allowMutations?: boolean
}

/**
 * Require a non-blank plugin name from the wire.
 *
 * The Remote boundary is a trust boundary: the request arrives as JSON from a
 * browser, so its fields are validated rather than assumed.
 *
 * @param value - the received field.
 * @param method - the Remote method, named in the refusal.
 * @returns the plugin name.
 * @throws {RemoteError} when the field is absent or blank.
 */
function requirePluginName(value: unknown, method: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new RemoteError('gateway/bad-request', `marketplace.${method} requires a non-blank plugin name`, {})
  }
  return value
}

/**
 * Require a boolean from the wire.
 *
 * @param value - the received field.
 * @param field - the field name, reported and named in the refusal.
 * @returns the boolean.
 * @throws {RemoteError} when the field is not a boolean.
 */
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new RemoteError('gateway/bad-request', `marketplace.setEnabled requires a boolean ${field}`, {
      issues: [{ path: ['enabled'], message: 'expected a boolean' }],
    })
  }
  return value
}

/** The marketplace Remote face: one status read and the writes the panel offers. */
export class MarketplaceGateway extends TypertRemoteService {
  static Config: z<Config> = z.object({
    harnessHome: z.string(),
    statePath: z.string(),
    patchLayerPath: z.string(),
    allowMutations: z.boolean().default(true),
  })

  /** Resolved paths, fixed at construction so every read sees one configuration. */
  private readonly statePath: string
  private readonly patchLayerPath: string
  /** Where the write path materializes skills and reads ownership from. */
  private readonly materialize: MaterializeOptions
  private readonly allowMutations: boolean

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'marketplace')
    const harnessHome = config.harnessHome ?? resolveDshHome()
    this.statePath = config.statePath ?? join(harnessHome, 'marketplace', 'state.json')
    this.patchLayerPath = config.patchLayerPath ?? join(harnessHome, PROFILE_PATCH_FILENAME)
    this.materialize = { harnessHome }
    this.allowMutations = config.allowMutations ?? true
  }

  /**
   * Read the current marketplace status: registrations plus installed plugins.
   *
   * Every plugin's `state` and `skills` are resolved at call time rather than
   * stored, so what the browser shows is what enablement currently says.
   *
   * @returns the marketplaces and installed plugins the panel renders.
   * @throws {MarketplaceStateError} when the state file exists but cannot be
   * trusted. The Remote layer turns that into a failed result rather than a
   * dropped connection, so the panel can say so instead of rendering an empty
   * list that reads as "nothing is installed".
   */
  @Remote('status')
  status(): Promise<MarketplaceStatusView> {
    const state = this.readState()
    // An absent patch layer is a normal first run: nothing is mounted yet.
    const layer = parsePatchLayer(this.patchLayerPath)

    const installed = state.installed.map((entry): InstalledPluginView => {
      const rowIds = this.rowsFor(entry)
      const skills = this.skillsFor(entry)
      return {
        plugin: entry.plugin,
        marketplace: entry.marketplace,
        ...(entry.sha !== undefined ? { sha: entry.sha } : {}),
        installPath: entry.installPath,
        capabilities: [...entry.capabilities],
        rowIds,
        skillIds: skills.skillIds,
        state: this.stateOf(rowIds, layer.patches),
        skills: skills.skills,
      }
    })

    // Resolved rather than `async`, because this read has nothing to await:
    // an async signature here would be a Promise wrapper around no suspension
    // point, which is what the lint rule objects to.
    return Promise.resolve({
      marketplaces: state.marketplaces.map(({ name, url }) => ({ name, url })),
      installed,
      allowMutations: this.allowMutations,
    })
  }

  /**
   * Turn one installed plugin's mounts and skills on or off.
   *
   * @param request - the plugin and the state it is asked to reach.
   * @returns what moved, and the status that write produced.
   * @throws {RemoteError} when mutations are disabled, the request is malformed,
   * or no such plugin is installed.
   */
  @Remote('setEnabled')
  async setEnabled(request: PluginEnableRequest): Promise<PluginEnablementView> {
    const plugin = requirePluginName(request.plugin, 'setEnabled')
    const enabled = requireBoolean(request.enabled, 'enabled')
    this.requireMutations()
    const result = setPluginEnabled(this.requireInstalled(plugin), enabled, this.writeTarget())
    // Only a skills move changes what `/` lists. Announcing a row-only toggle
    // would make every live client repull a command list that did not change.
    if (result.skillsMoved) this.notifyCommandSurface()
    return {
      plugin,
      rowsChanged: result.rowsChanged,
      skillsMoved: result.skillsMoved,
      alreadyInState: result.alreadyInState,
      mountsNothing: result.mountsNothing,
      status: await this.status(),
    }
  }

  /**
   * Remove one installed plugin: its content, its skills, its rows, its record.
   *
   * @param request - the plugin to remove.
   * @returns whether a record existed, and the status that write produced.
   * @throws {RemoteError} when mutations are disabled or the request is malformed.
   */
  @Remote('uninstall')
  async uninstall(request: PluginUninstallRequest): Promise<PluginRemovalView> {
    const plugin = requirePluginName(request.plugin, 'uninstall')
    this.requireMutations()
    const { removed } = uninstallPlugin(this.readState(), plugin, {
      statePath: this.statePath,
      sync: this.writeTarget(),
    })
    if (removed) this.notifyCommandSurface()
    return { plugin, removed, status: await this.status() }
  }

  /** The patch layer and skills root both write paths target. */
  private writeTarget(): SyncOptions {
    return { patchLayerPath: this.patchLayerPath, materialize: this.materialize }
  }

  /**
   * Publish that the skills behind `/` may have moved.
   *
   * A user-invocable skill is listed by `command.list`, but `commands/change`
   * belongs to the COMMANDS registry, which cannot see a plugin's files moving —
   * this write is what moves them, so this write publishes the notification.
   * It fires after the mutation commits, so a listener that repulls reads the
   * new state rather than the one it is replacing.
   *
   * Listener failures are contained exactly as the registry contains them: a
   * broken observer must not veto a completed write, and Cordis emit uses
   * `Array.map`, so one synchronous throw would otherwise starve later
   * observers.
   */
  private notifyCommandSurface(): void {
    for (const callback of this.ctx.events.dispatch('emit', ['commands/change'])) {
      try {
        const returned: unknown = callback()
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`marketplace: commands/change listener rejected: ${String(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`marketplace: commands/change listener threw: ${String(error)}`)
      }
    }
  }

  /**
   * Refuse a write on a deployment that serves this panel read-only.
   *
   * @throws {RemoteError} when `allowMutations` is false.
   */
  private requireMutations(): void {
    if (this.allowMutations) return
    throw new RemoteError(
      'marketplace/read-only',
      'this deployment serves the marketplace panel read-only',
      {},
    )
  }

  /**
   * Resolve an installed entry by plugin name.
   *
   * @param plugin - the validated plugin name.
   * @returns the installed record.
   * @throws {RemoteError} when nothing is installed under that name, so the
   * panel hears "not installed" rather than a write that silently did nothing.
   */
  private requireInstalled(plugin: string): InstalledEntry {
    const entry = findInstalled(this.readState(), rowIdFor(plugin))
    if (entry === undefined) {
      throw new RemoteError('marketplace/not-installed', `${plugin} is not installed`, { plugin })
    }
    return entry
  }

  /**
   * Read the state file, treating an absent one as an empty marketplace.
   *
   * A first-run harness has no state file at all, and a panel that errored on
   * that would be reporting the absence of a file the user has no reason to
   * have yet.
   *
   * @returns the parsed state; an empty one when nothing is recorded.
   */
  private readState(): MarketplaceState {
    try {
      return loadState(this.statePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, marketplaces: [], installed: [] }
      }
      throw error
    }
  }

  /**
   * The loader rows one entry owns.
   *
   * Prefers the ids recorded by sync. A record written before that field existed
   * has none, so they are derived from the plugin's `.mcp.json` — the same
   * source the writer reads. `marketplace:<plugin>` is deliberately never
   * returned: this package writes no such row, so reporting its enablement would
   * describe a row that does not exist.
   *
   * @param entry - the installed record to resolve rows for.
   * @returns the ids the entry owns; empty when it mounts no loader row.
   */
  private rowsFor(entry: InstalledEntry): string[] {
    if (entry.rowIds !== undefined) return [...entry.rowIds]
    // Warnings are discarded: this read reports what IS mounted, and a coerced
    // name is already reflected in the id it produces.
    return readPluginMcp(entry.installPath, []).map(
      server => `marketplace:mcp:${sanitizeServerName(server.name, [])}`,
    )
  }

  /**
   * The discovery-root entries one plugin owns, and where they are.
   *
   * Derived from state when sync has recorded them, and from the plugin's own
   * `skills/` directory otherwise. Neither path materializes, so this stays a
   * read: `skillsEnabled` only tests for the presence of the entries.
   *
   * @param entry - the installed record to resolve skills for.
   * @returns the owned entry names and their current placement.
   */
  private skillsFor(entry: InstalledEntry): { skillIds: string[]; skills: SkillsStateView } {
    const skillIds = entry.skillIds !== undefined
      ? [...entry.skillIds]
      : skillEntryNames(entry.installPath).names
    const live = skillsEnabled(this.materialize, entry.plugin, skillIds)
    return { skillIds, skills: live === undefined ? 'none' : live ? 'live' : 'parked' }
  }

  /**
   * Classify one entry's loader rows against the patch layer.
   *
   * `no-rows` is a real outcome, not a failure: a skills-only plugin mounts no
   * loader row because skills are discovered from the filesystem. Calling that
   * `disabled` would tell the user their live plugin is off.
   *
   * @param rowIds - the rows the entry owns.
   * @param patches - the parsed patch layer's rows, the sole enablement source.
   * @returns the row state a panel shows for this plugin.
   */
  private stateOf(rowIds: readonly string[], patches: PatchRows): InstalledStateView {
    if (rowIds.length === 0) return 'no-rows'
    const states = rowIds.map(id => readEnabled(patches, id))
    if (states.some(state => state === undefined)) return 'not-mounted'
    return states.every(state => state === false) ? 'disabled' : 'enabled'
  }
}

export default MarketplaceGateway
