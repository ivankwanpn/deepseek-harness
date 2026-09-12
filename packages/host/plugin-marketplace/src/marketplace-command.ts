/**
 * `dsh plugin marketplace …` — the marketplace's CLI face.
 *
 * Kept out of `plugin.ts` on purpose: that module's contract is "forward the
 * remaining arguments to pnpm inside the profile directory", and a subcommand
 * parsed there would be a pnpm argument the moment it were misspelled. This is a
 * separate mode with its own usage.
 *
 * Every write this command makes goes through the same two seams the library
 * exposes — the state file and the patch layer — so the CLI cannot invent a
 * third place where "installed" or "enabled" is recorded.
 */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import { addMarketplace, installPlugin, uninstallPlugin } from './install.ts'
import { catalog } from './catalog.ts'
// `add` takes a repo-or-url and must resolve it; every later command reads a url
// that `add` already resolved to a manifest.
import { fetchMarketplaceFrom } from './fetch.ts'
import { parsePatchLayer, readEnabled } from './patch-layer.ts'
import {
  defaultStatePath,
  emptyState,
  findInstalled,
  loadState,
  rowIdFor,
  saveState,
  type MarketplaceState,
} from './state.ts'
import type { SyncOptions } from './sync.ts'
import { defaultAgentsSkillsDir } from './materialize.ts'
import { ownedBy, setPluginEnabled } from './operations.ts'

const NAME = 'dsh'

/** Convenience alias so the common registry needs no url. */
const OFFICIAL_REGISTRY: Record<string, string> = {
  official: 'https://github.com/anthropics/claude-plugins-official',
  anthropic: 'https://github.com/anthropics/claude-plugins-official',
}

/** The `dsh plugin marketplace` usage block, shared by help and error output. */
export const MARKETPLACE_USAGE = [
  'usage: dsh plugin marketplace <command> [options]',
  '',
  '  add <repo|url|official>     register a marketplace',
  '  list                        registered marketplaces',
  '  search <query>              search plugin names, descriptions and categories',
  '  install <plugin>            fetch (at the pinned sha), record, and mount',
  '  uninstall <plugin>          remove content, record, and rows',
  '  installed                   what this marketplace installed',
  '  enable <plugin>             unmount without uninstalling',
  '  disable <plugin>            keep the content, remove the mount',
  '',
  'options for install:',
  '  --allow-unpinned            accept a source that declares no sha by',
  '                              recording the commit its ref names now',
].join('\n')

interface Context {
  state: MarketplaceState
  statePath: string
  sync: SyncOptions
}

/**
 * Where things live.
 *
 * The patch layer is the PER-USER one (`<harness home>/cordis.patch.yml`), not a
 * profile's: an install is a machine-wide statement, and DSH watches that file
 * through Cordis HMR, so rows take effect without a restart. Per-profile
 * scoping would silently make the same plugin installed-but-absent depending on
 * which profile booted.
 */
function context(): Context {
  const harnessHome = resolveDshHome()
  const statePath = defaultStatePath(harnessHome)
  return {
    state: loadState(statePath),
    statePath,
    sync: {
      // join(), not string concatenation: a literal '/' here would produce a
      // mixed-separator path on Windows that readFileSync still accepts but
      // string comparisons elsewhere need not.
      patchLayerPath: join(harnessHome, PROFILE_PATCH_FILENAME),
      materialize: {
        harnessHome,
        agentsSkillsDir: defaultAgentsSkillsDir(harnessHome),
      },
    },
  }
}

function registryUrl(spec: string): string {
  return OFFICIAL_REGISTRY[spec.toLowerCase()] ?? spec
}

/** `owner/repo` shorthand, so `add obra/superpowers` works. */
function normalizeUrl(spec: string): string {
  if (/^https?:\/\//.test(spec) || spec.startsWith('git@')) return spec
  if (/^[\w.-]+\/[\w.-]+$/.test(spec)) return `https://github.com/${spec}`
  return spec
}

/**
 * Run one marketplace invocation.
 *
 * @param args - the subcommand and its operands, already stripped of the
 * leading `plugin marketplace` words; an absent subcommand prints usage.
 * @returns the process exit code: 0 on success, 1 on any refusal.
 */
export async function runMarketplace(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${MARKETPLACE_USAGE}\n`)
    return command === undefined ? 1 : 0
  }

  const ctx = context()

  switch (command) {
    case 'add': {
      const spec = rest[0]
      if (spec === undefined) {
        process.stderr.write(`${NAME}: marketplace add requires a repository or url\n`)
        return 1
      }
      const url = normalizeUrl(registryUrl(spec))
      // Fetch before registering: a url that does not answer would otherwise sit
      // in the state file and fail every later command with a different error.
      // A repo url is resolved to its manifest; the resolved manifest url is
      // what gets stored, so later commands never re-guess a location.
      const { marketplace: market, manifestUrl } = await fetchMarketplaceFrom(url)
      const next = addMarketplace(ctx.state, market.name, manifestUrl)
      saveState(ctx.statePath, next)
      process.stdout.write(`registered ${market.name} (${String(market.plugins.length)} plugins)\n`)
      process.stdout.write(`  from ${manifestUrl}\n`)
      return 0
    }

    case 'list': {
      if (ctx.state.marketplaces.length === 0) {
        process.stdout.write('no marketplaces registered\n')
        return 0
      }
      for (const m of ctx.state.marketplaces) process.stdout.write(`${m.name}\t${m.url}\n`)
      return 0
    }

    case 'search': {
      const query = rest.join(' ').trim().toLowerCase()
      if (ctx.state.marketplaces.length === 0) {
        process.stderr.write(`${NAME}: no marketplaces registered; run \`dsh plugin marketplace add official\`\n`)
        return 1
      }
      const { rows, failed } = await catalog(ctx.state)
      // A registration that could not be read is reported on stderr and does
      // not stop the rows the readable ones supplied. Silence here would read
      // as "this marketplace lists nothing", which is a different fact.
      for (const failure of failed) {
        process.stderr.write(`${NAME}: ${failure.marketplace}: ${failure.reason}\n`)
      }
      let matches = 0
      for (const row of rows) {
        const haystack = `${row.plugin} ${row.description ?? ''} ${row.category ?? ''} ${row.tags.join(' ')}`.toLowerCase()
        if (query !== '' && !haystack.includes(query)) continue
        matches++
        process.stdout.write(`${row.plugin}${row.installed ? ' [installed]' : ''}\n`)
        if (row.description !== undefined) {
          process.stdout.write(`    ${row.description.slice(0, 140)}\n`)
        }
      }
      if (matches === 0) process.stdout.write(`no plugin matched ${JSON.stringify(query)}\n`)
      return 0
    }

    case 'install': {
      // A flag may appear on either side of the name, so the operands are
      // separated rather than read positionally.
      const operands = rest.filter(arg => !arg.startsWith('-'))
      const flags = new Set(rest.filter(arg => arg.startsWith('-')))
      const unknown = [...flags].filter(f => f !== '--allow-unpinned')
      if (unknown.length > 0) {
        process.stderr.write(`${NAME}: unknown marketplace install option ${unknown.join(', ')}\n${MARKETPLACE_USAGE}\n`)
        return 1
      }
      const plugin = operands[0]
      if (plugin === undefined) {
        process.stderr.write(`${NAME}: marketplace install requires a plugin name\n`)
        return 1
      }
      let result: Awaited<ReturnType<typeof installPlugin>>
      try {
        result = await installPlugin(plugin, {
          state: ctx.state,
          statePath: ctx.statePath,
          sync: ctx.sync,
          ...(flags.has('--allow-unpinned') ? { allowUnpinned: true } : {}),
        })
      } catch (error) {
        // A refusal is a diagnosis, not a crash: the refusal path is reached by
        // ordinary registry content (a marketplace-relative source with no sha
        // pin), so an uncaught throw would greet the user with a stack trace.
        // Fetch and filesystem faults keep their own message and cause.
        process.stderr.write(`${NAME}: ${error instanceof Error ? error.message : String(error)}\n`)
        return 1
      }
      const { entry, synced } = result
      process.stdout.write(`installed ${entry.plugin} from ${entry.marketplace}\n`)
      process.stdout.write(`  content     ${entry.installPath}\n`)
      process.stdout.write(`  pinned      ${entry.sha ?? '(local source)'}\n`)
      process.stdout.write(`  carries     ${entry.capabilities.length > 0 ? entry.capabilities.join(', ') : 'nothing mountable'}\n`)
      // Rows are reported for THIS plugin only. `synced.rows` is the whole
      // composed layer, so filtering here keeps a second install from appearing
      // to have mounted the first plugin's rows.
      /* v8 ignore next -- install syncs the plugin it just installed, so this lookup always finds it. */
      const own = synced.materialized.find(m => m.plugin === entry.plugin)?.result.rows ?? []
      if (own.length > 0) {
        process.stdout.write(`  mounted     ${String(own.length)} row(s)\n`)
        for (const row of own) process.stdout.write(`    ${row.id}\n`)
      } else {
        process.stdout.write('  mounted     no loader rows (skills are discovered from the filesystem)\n')
      }
      for (const w of result.warnings) process.stderr.write(`${NAME}: ${w}\n`)
      return 0
    }

    case 'uninstall': {
      const plugin = rest[0]
      if (plugin === undefined) {
        process.stderr.write(`${NAME}: marketplace uninstall requires a plugin name\n`)
        return 1
      }
      const { removed } = uninstallPlugin(ctx.state, plugin, { statePath: ctx.statePath, sync: ctx.sync })
      process.stdout.write(removed ? `uninstalled ${plugin}\n` : `${plugin} is not installed\n`)
      return removed ? 0 : 1
    }

    case 'installed': {
      if (ctx.state.installed.length === 0) {
        process.stdout.write('nothing installed from a marketplace\n')
        return 0
      }
      // Read the patch layer once: enablement lives there, never in state.
      const layer = parsePatchLayer(ctx.sync.patchLayerPath)
      for (const entry of ctx.state.installed) {
        const rowIds = ownedBy(entry, ctx.sync.materialize).rowIds
        const states = rowIds.map(id => readEnabled(layer.patches, id))
        const mount = states.length === 0
          ? 'no-rows'
          : states.every(s => s === false)
            ? 'disabled'
            : states.some(s => s === undefined)
              ? 'not-mounted'
              : 'enabled'
        process.stdout.write(`${entry.plugin}\t${mount}\t${entry.capabilities.join(',') || '-'}\n`)
        process.stdout.write(`    ${entry.marketplace} @ ${entry.sha ?? '(local source)'}\n`)
      }
      return 0
    }

    case 'enable':
    case 'disable': {
      const plugin = rest[0]
      if (plugin === undefined) {
        process.stderr.write(`${NAME}: marketplace ${command} requires a plugin name\n`)
        return 1
      }
      const entry = findInstalled(ctx.state, rowIdFor(plugin))
      if (entry === undefined) {
        process.stderr.write(`${NAME}: ${plugin} is not installed\n`)
        return 1
      }
      const want = command === 'enable'

      // Two mechanisms, one verb, and ONE implementation of it: the same call
      // the Web panel makes, so a plugin toggled from either face ends up in the
      // same state. See operations.ts for why neither face resolves ownership
      // itself.
      const result = setPluginEnabled(entry, want, {
        patchLayerPath: ctx.sync.patchLayerPath,
        materialize: ctx.sync.materialize,
      })
      if (result.mountsNothing) {
        process.stderr.write(`${NAME}: ${plugin} mounts nothing (no runtime row and no skills)\n`)
        return 1
      }
      if (result.alreadyInState) {
        // Already in the requested state; report success rather than an error,
        // because the desired end state holds.
        process.stdout.write(`${plugin} is already ${command === 'enable' ? 'enabled' : 'disabled'}\n`)
        return 0
      }

      const parts: string[] = []
      if (result.rowsChanged > 0) parts.push(`${String(result.rowsChanged)} runtime row(s)`)
      if (result.skillsMoved) parts.push('skills')
      process.stdout.write(`${command === 'enable' ? 'enabled' : 'disabled'} ${plugin} (${parts.join(', ')})\n`)
      return 0
    }

    default:
      process.stderr.write(`${NAME}: unknown marketplace command ${JSON.stringify(command)}\n${MARKETPLACE_USAGE}\n`)
      return 1
  }
}

/**
 * True when these args should be handled here rather than forwarded to pnpm.
 * @param args - the words after `dsh plugin`.
 * @returns true when the first word selects the marketplace subcommand.
 */
export function isMarketplaceInvocation(args: readonly string[]): boolean {
  return args[0] === 'marketplace'
}

/**
 * Exposed for tests: an empty state at the default location.
 * @returns a fresh state with no marketplaces and nothing installed, so a test
 * never reads the developer's real record.
 */
export function emptyStateForTest(): MarketplaceState {
  return emptyState()
}
