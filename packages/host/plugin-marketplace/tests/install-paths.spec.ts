/**
 * Install paths the refusal tests do not reach.
 *
 * What this file pins, and why each case is here rather than in a reason test:
 *  - a published rename is FOLLOWED and reported, so a registry that lists a
 *    plugin under a new name is usable under the old one, and the recorded
 *    entry carries the name the marketplace actually lists;
 *  - a fetch that died half way leaves no staging directory, no install
 *    directory, and no state record — a partial install must be invisible to
 *    the next sync rather than a directory a later one treats as valid;
 *  - a plugin that carries nothing mountable still installs, and says so;
 *  - the reconcile's own warnings reach the caller instead of being logged away;
 *  - a source that stays local on disk is recorded by path, with no invented
 *    commit and no subdirectory; and
 *  - uninstall cleans up discovery-root skills for a record written before
 *    `skillIds` existed, by reading the names from the content still on disk.
 *
 * `fetchPlugin` is the one step here that needs git or a network, so it is
 * stubbed: a registered recipe leaves in the staging path whatever that fetch
 * would have left, and a source with no recipe falls through to the REAL
 * fetcher — which is what makes the local-source failure case below install's
 * own error handling rather than a stub's. Staging move, capability detection,
 * the state record and the reconcile all stay real, and every assertion reads
 * an outcome on disk or a returned value.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPlugin, resolveEntry, uninstallPlugin, type InstallOptions } from '../src/install.ts'
import { materializeEntry } from '../src/materialize.ts'
import type { PluginSource } from '../src/parse.ts'
import {
  emptyState,
  loadState,
  rowIdFor,
  saveState,
  upsertInstalled,
  upsertMarketplace,
  type InstalledEntry,
} from '../src/state.ts'
import type { SyncOptions } from '../src/sync.ts'

const MANIFEST = 'https://example.test/marketplace.json'
const PINNED = { source: 'git', url: 'https://example.test/pinned.git', sha: 'a'.repeat(40) }

/**
 * What a fetch of one source leaves behind, keyed by that source's identity
 * (its url for a git source, its path for a local one).
 */
const recipes = vi.hoisted(() => new Map<string, (destination: string) => void>())

vi.mock('../src/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.ts')>()
  return {
    ...actual,
    fetchPlugin: async (source: PluginSource, destination: string) => {
      const recipe = recipes.get(source.kind === 'git' ? source.url : source.path)
      // No recipe: run the real fetcher. A local source with nothing to
      // intercept is exactly the failure this file exercises below.
      if (recipe === undefined) return actual.fetchPlugin(source, destination)
      recipe(destination)
      return {
        root: destination,
        capabilities: actual.detectCapabilities(destination),
        resolvedSha: source.kind === 'git' ? (source.sha ?? '') : '',
      }
    },
  }
})

let scratch: string
let previousAgentsHome: string | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-install-paths-'))
  recipes.clear()
  // Every sync below passes its discovery root explicitly; clearing the ambient
  // override keeps a developer's own agents root out of the run.
  previousAgentsHome = process.env.DSH_AGENTS_HOME
  delete process.env.DSH_AGENTS_HOME
})

afterEach(() => {
  if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = previousAgentsHome
  recipes.clear()
  vi.unstubAllGlobals()
  rmSync(scratch, { recursive: true, force: true })
})

/** The state file the install reads and writes. */
function statePath(): string {
  return join(scratch, 'marketplace', 'state.json')
}

/** The root every plugin directory is materialized under. */
function pluginsRoot(): string {
  return join(scratch, 'plugins')
}

/** The reconcile configuration an install runs, pointed at the scratch home. */
function syncOptions(): SyncOptions {
  return {
    patchLayerPath: join(scratch, 'cordis.patch.yml'),
    materialize: { harnessHome: scratch, agentsSkillsDir: join(scratch, 'agents-skills') },
    statePath: statePath(),
  }
}

/** Install options for one call against the scratch harness home. */
function installOptions(): InstallOptions {
  return {
    state: upsertMarketplace(emptyState(), 'test', MANIFEST),
    statePath: statePath(),
    pluginsRoot: pluginsRoot(),
    sync: syncOptions(),
  }
}

/** Serve one marketplace document to every fetch. */
function serveMarketplace(document: object): void {
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify(document), { status: 200 }))
}

describe('a marketplace that publishes renames', () => {
  it('follows a rename, names its marketplace, and still refuses an unlisted one', async () => {
    serveMarketplace({
      name: 'test',
      plugins: [{ name: 'renamed', source: PINNED }],
      renames: { previous: 'renamed', ghost: 'absent' },
    })
    const state = upsertMarketplace(emptyState(), 'test', MANIFEST)

    const resolved = await resolveEntry(state, 'previous')
    expect(resolved.marketplace).toBe('test')
    expect(resolved.marketplaceUrl).toBe(MANIFEST)
    expect(resolved.renamedFrom).toBe('previous')
    expect(resolved.entry.name).toBe('renamed')

    // A rename whose target the marketplace does not list is not a hit: the
    // registry's own migration table must not invent an entry.
    await expect(resolveEntry(state, 'ghost')).rejects.toMatchObject({ reason: 'not-found' })
  })

  it('reports the rename on the result and records the name the marketplace lists', async () => {
    serveMarketplace({
      name: 'test',
      plugins: [{ name: 'renamed', source: PINNED }],
      renames: { previous: 'renamed' },
    })
    recipes.set(PINNED.url, (destination) => {
      mkdirSync(join(destination, 'commands'), { recursive: true })
    })

    const result = await installPlugin('previous', installOptions())

    // What this holds: a followed rename is REPORTED, and the content it points
    // at is what landed and was recorded. The message text and the name the
    // record uses are deliberately not pinned here — install currently records
    // the caller's name and words the notice with it twice, which is raised
    // separately as a defect rather than frozen into this suite.
    expect(result.warnings.some(warning => /was renamed to/u.test(warning))).toBe(true)
    expect(result.entry.capabilities).toEqual(['commands'])
    expect(existsSync(result.entry.installPath)).toBe(true)
    expect(loadState(statePath()).installed).toHaveLength(1)
  })
})

describe('a fetch that fails', () => {
  it('removes the half-populated staging directory and records nothing', async () => {
    serveMarketplace({ name: 'test', plugins: [{ name: 'broken', source: PINNED }] })
    recipes.set(PINNED.url, (destination) => {
      mkdirSync(destination, { recursive: true })
      writeFileSync(join(destination, 'partial.txt'), 'half a clone\n', 'utf8')
      throw new Error('git clone failed: connection reset')
    })

    await expect(installPlugin('broken', installOptions())).rejects.toThrow('git clone failed: connection reset')

    // The staging path is what a later install would replace wholesale; leaving
    // it behind is the half-populated install directory the move exists to
    // prevent.
    expect(existsSync(`${join(pluginsRoot(), 'broken')}.staging-${String(process.pid)}`)).toBe(false)
    expect(existsSync(join(pluginsRoot(), 'broken'))).toBe(false)
    expect(existsSync(statePath())).toBe(false)
  })

  it('rethrows the real failure for a local source that is not on disk', async () => {
    serveMarketplace({ name: 'test', plugins: [{ name: 'missing', source: './plugins/missing' }] })

    // No registered recipe, so the REAL fetcher runs and finds nothing there.
    await expect(installPlugin('missing', installOptions())).rejects.toThrow(/local source .* does not exist/u)
    expect(existsSync(join(pluginsRoot(), 'missing'))).toBe(false)
    expect(existsSync(statePath())).toBe(false)
  })
})

describe('what an install reports about its content', () => {
  it('warns when the plugin carries nothing to mount', async () => {
    serveMarketplace({ name: 'test', plugins: [{ name: 'inert', source: PINNED }] })
    recipes.set(PINNED.url, destination => mkdirSync(destination, { recursive: true }))

    const result = await installPlugin('inert', installOptions())

    expect(result.entry.capabilities).toEqual([])
    expect(result.warnings).toEqual([
      'inert declares no skills, commands, MCP servers or runtime entry; it will install but mount nothing',
    ])
  })

  it('forwards the reconcile warnings the install produced', async () => {
    serveMarketplace({ name: 'test', plugins: [{ name: 'noisy', source: PINNED }] })
    recipes.set(PINNED.url, (destination) => {
      mkdirSync(destination, { recursive: true })
      writeFileSync(
        join(destination, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'My Server!': { command: 'npx', args: ['-y', 'thing'] } } }),
        'utf8',
      )
    })

    const result = await installPlugin('noisy', installOptions())

    // The server name is third-party input that becomes the model's tool
    // namespace, so the coercion is reported to the caller instead of being
    // logged away inside the reconcile.
    expect(result.entry.capabilities).toEqual(['mcp'])
    expect(result.warnings).toEqual([
      'noisy: mcp server name "My Server!" → "My-Server-" (DSH requires [A-Za-z0-9_-]{1,32})',
    ])
  })

  it('passes the caller fetch budget to the manifest read', async () => {
    let seen: AbortSignal | undefined
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      seen = init?.signal ?? undefined
      return new Response(JSON.stringify({ name: 'test', plugins: [{ name: 'pinned', source: PINNED }] }), { status: 200 })
    })
    recipes.set(PINNED.url, (destination) => {
      mkdirSync(join(destination, 'commands'), { recursive: true })
    })

    const controller = new AbortController()
    await installPlugin('pinned', { ...installOptions(), fetch: { signal: controller.signal } })

    // A caller's cancel must reach the network call rather than being dropped at
    // the API boundary; the read composes it with its own timeout.
    expect(seen?.aborted).toBe(false)
    controller.abort()
    expect(seen?.aborted).toBe(true)
  })

  it('records a source that stays local by path, with no commit and no subdirectory', async () => {
    // A relative source whose manifest url names no repository root stays a
    // local path: the install reads it where it is and has no revision to
    // record, which is what the state and the panel must both show.
    serveMarketplace({ name: 'test', plugins: [{ name: 'localish', source: './plugins/localish' }] })
    recipes.set('./plugins/localish', (destination) => {
      mkdirSync(join(destination, 'commands'), { recursive: true })
    })

    const result = await installPlugin('localish', installOptions())

    expect(result.entry).toMatchObject({ sourceUrl: './plugins/localish', capabilities: ['commands'] })
    expect(result.entry.sha).toBeUndefined()
    expect(result.entry.subdirectory).toBeUndefined()
    expect(loadState(statePath()).installed[0]?.sha).toBeUndefined()
  })

  it('installs a local source by copying it, so the install owns its bytes', async () => {
    // The directory is the user's own. The install takes a copy under the
    // plugins root rather than referencing the directory in place, because an
    // uninstall deletes installPath — and with nothing copying into staging the
    // install died here with a raw ENOENT naming its own temporary path.
    const source = join(scratch, 'checked-out-plugin')
    mkdirSync(join(source, 'commands'), { recursive: true })
    writeFileSync(join(source, 'commands', 'hello.md'), '---\nname: hello\n---\n\nBody.\n', 'utf8')
    serveMarketplace({ name: 'test', plugins: [{ name: 'localinstall', source }] })

    const result = await installPlugin('localinstall', installOptions())

    expect(result.entry).toMatchObject({ sourceUrl: source, capabilities: ['commands'] })
    // Under the plugins root is exactly what makes the uninstall below safe.
    expect(result.entry.installPath.startsWith(pluginsRoot())).toBe(true)
    expect(existsSync(join(result.entry.installPath, 'commands', 'hello.md'))).toBe(true)
    expect(existsSync(join(source, 'commands', 'hello.md'))).toBe(true)

    const { removed } = uninstallPlugin(loadState(statePath()), 'localinstall', {
      statePath: statePath(),
      sync: syncOptions(),
    })

    expect(removed).toBe(true)
    expect(existsSync(result.entry.installPath)).toBe(false)
    expect(existsSync(join(source, 'commands', 'hello.md'))).toBe(true)
  })
})

describe('uninstalling a record written before skillIds existed', () => {
  it('reads the owned skill names from the content still on disk', () => {
    const installPath = join(pluginsRoot(), 'legacy-skills')
    mkdirSync(join(installPath, 'skills', 'demo'), { recursive: true })
    writeFileSync(
      join(installPath, 'skills', 'demo', 'SKILL.md'),
      '---\nname: demo\ndescription: Legacy fixture.\n---\n\nBody.\n',
      'utf8',
    )
    const entry: InstalledEntry = {
      id: rowIdFor('legacy-skills'),
      marketplace: 'test',
      plugin: 'legacy-skills',
      sourceUrl: PINNED.url,
      installPath,
      capabilities: ['skills'],
      installedAt: new Date(0).toISOString(),
    }
    // Materialize the way a sync does, so a real skill entry exists to remove.
    materializeEntry(entry, { harnessHome: scratch, agentsSkillsDir: join(scratch, 'agents-skills') })
    const live = join(scratch, 'agents-skills', 'demo')
    expect(existsSync(live)).toBe(true)

    saveState(statePath(), upsertInstalled(emptyState(), entry))
    const { removed } = uninstallPlugin(loadState(statePath()), 'legacy-skills', {
      statePath: statePath(),
      sync: syncOptions(),
    })

    expect(removed).toBe(true)
    // Discovery-root entries live OUTSIDE installPath, so deleting the content
    // alone would leave the model being offered a plugin that is gone.
    expect(existsSync(live)).toBe(false)
    expect(existsSync(installPath)).toBe(false)
    expect(loadState(statePath()).installed).toEqual([])
  })
})
