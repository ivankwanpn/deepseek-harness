/**
 * Read-only Remote face for the marketplace, consumed by the Web settings panel.
 *
 * READ-ONLY BY DESIGN for this first surface. The writes this package performs
 * (fetch, install, uninstall, enable) are filesystem mutations driven from a
 * browser process, so their contract needs a permission and confirmation story
 * that a status read does not. Exposing the read first keeps the Remote
 * namespace's shape honest about what it can do.
 *
 * It owns no cache. The state file and the patch layer are both cheap to read
 * and both change underneath a running harness — the CLI can install or disable
 * something while the browser is open, and Cordis HMR can rewrite the patch
 * layer at any moment. A cached snapshot would therefore need an invalidation
 * path for every writer; reading per call cannot go stale at all.
 *
 * It also never materializes. `materializeEntry` copies skills into the
 * discovery root and can park them under `.disabled`, which is a WRITE; a status
 * read that used it would mutate the user's disk as a side effect of opening a
 * settings tab. Row ids are therefore derived from the plugin's `.mcp.json`
 * alone, which is the same derivation the writer performs.
 *
 * @module @deepseek-ai/dsh-host-plugin-marketplace/gateway
 */

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readPluginMcp, sanitizeServerName } from './materialize.ts'
import { parsePatchLayer, readEnabled } from './patch-layer.ts'
import { loadState, type InstalledEntry, type MarketplaceState } from './state.ts'
import type {
  InstalledPluginView,
  InstalledStateView,
  MarketplaceStatusView,
} from './types.ts'

// NOTE: no `export type * from './types.ts'` here, deliberately. The generated
// Remote declaration names the return type through THIS module, and this module
// is Node-only (node:path, node:fs further down its graph). Re-exporting the
// wire contract from here made the browser compilation face resolve
// `@deepseek-ai/dsh-host-plugin-marketplace/gateway` and compile the whole host
// package for a browser target. `types.ts` stays the contract's only home, and
// consumers import it from the planned `./types` subpath.

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
 * Where the panel reads from.
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
}

/** Read-only projection of what marketplaces have installed, and their state. */
export class MarketplaceGateway extends TypertRemoteService {
  static Config: z<Config> = z.object({
    harnessHome: z.string(),
    statePath: z.string(),
    patchLayerPath: z.string(),
  })

  /** Resolved paths, fixed at construction so every read sees one configuration. */
  private readonly statePath: string
  private readonly patchLayerPath: string

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'marketplace')
    const harnessHome = config.harnessHome ?? resolveDshHome()
    this.statePath = config.statePath ?? join(harnessHome, 'marketplace', 'state.json')
    this.patchLayerPath = config.patchLayerPath ?? join(harnessHome, PROFILE_PATCH_FILENAME)
  }

  /**
   * Read the current marketplace status: registrations plus installed plugins.
   *
   * Every plugin's `state` is resolved from the patch layer at call time rather
   * than stored, so what the browser shows is what enablement currently says.
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
      return {
        plugin: entry.plugin,
        marketplace: entry.marketplace,
        ...(entry.sha !== undefined ? { sha: entry.sha } : {}),
        installPath: entry.installPath,
        capabilities: [...entry.capabilities],
        rowIds,
        state: this.stateOf(rowIds, layer.patches),
      }
    })

    // Resolved rather than `async`, because this read has nothing to await:
    // an async signature here would be a Promise wrapper around no suspension
    // point, which is what the lint rule objects to.
    return Promise.resolve({
      marketplaces: state.marketplaces.map(({ name, url }) => ({ name, url })),
      installed,
    })
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
   * Classify one entry against the patch layer.
   *
   * `no-rows` is a real outcome, not a failure: a skills-only plugin mounts no
   * loader row because skills are discovered from the filesystem. Calling that
   * `disabled` would tell the user their live plugin is off.
   *
   * @param rowIds - the rows the entry owns.
   * @param patches - the parsed patch layer's rows, the sole enablement source.
   * @returns the state a panel shows for this plugin.
   */
  private stateOf(rowIds: readonly string[], patches: PatchRows): InstalledStateView {
    if (rowIds.length === 0) return 'no-rows'
    const states = rowIds.map(id => readEnabled(patches, id))
    if (states.some(state => state === undefined)) return 'not-mounted'
    return states.every(state => state === false) ? 'disabled' : 'enabled'
  }
}

export default MarketplaceGateway
