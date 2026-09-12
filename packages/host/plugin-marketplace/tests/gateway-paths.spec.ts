/**
 * Gateway paths the Remote-surface tests do not reach: the resolved defaults, a
 * state file that cannot be trusted, a fault that is not an `Error`, and an
 * install that recorded no commit.
 *
 * Each case pins a fact the Web settings panel depends on. A row that configures
 * nothing must read and write exactly where `dsh plugin marketplace` does,
 * because the CLI and the panel share one harness home; a corrupt record must
 * fail the read rather than answer "nothing is installed"; a fault from below
 * must reach the client as a wire code with a reason, never as a dropped
 * connection; and the install result must OMIT `sha` for a source that has none,
 * so a client switching on field presence is not given an empty string.
 *
 * The first case boots a real `cordis.yml` row through the Loader (the
 * sanctioned composition evidence for this package) with NO config at all, so
 * the config schema's defaults — not a hand-passed object — are what decide
 * every path.
 *
 * `../src/git.ts` is stubbed for the two steps that need a network or a clone;
 * the manifest read, the pin rule, the state record, the patch layer and the
 * status read are the real implementation.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import MarketplaceGateway from '../src/gateway.ts'
import { parsePatchLayer, readEnabled, serializePatchLayer } from '../src/patch-layer.ts'
import type { PluginSource } from '../src/parse.ts'
import { emptyState, loadState, rowIdFor, saveState, upsertMarketplace } from '../src/state.ts'

const SPECIFIER = '@deepseek-ai/dsh-host-plugin-marketplace/gateway'
const MANIFEST = 'https://example.test/marketplace.json'
const PINNED = { source: 'git', url: 'https://example.test/pinned.git', sha: 'a'.repeat(40) }

/** What a fetch of one source leaves behind, keyed by that source's identity. */
const recipes = vi.hoisted(() => new Map<string, (destination: string) => void>())

vi.mock('../src/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.ts')>()
  return {
    ...actual,
    fetchPlugin: async (source: PluginSource, destination: string) => {
      const key = source.kind === 'git' ? source.url : source.path
      const recipe = recipes.get(key)
      if (recipe === undefined) throw new actual.PluginFetchError(`no fetch recipe registered for ${key}`)
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
let context: Context | undefined
let previousHome: string | undefined
let previousAgentsHome: string | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-gateway-paths-'))
  recipes.clear()
  // An unconfigured gateway resolves DSH_HOME, so this suite points that at the
  // scratch home instead of the developer's own.
  previousHome = process.env.DSH_HOME
  previousAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = scratch
  delete process.env.DSH_AGENTS_HOME
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = previousAgentsHome
  recipes.clear()
  await context?.fiber.dispose()
  context = undefined
  vi.unstubAllGlobals()
  rmSync(scratch, { recursive: true, force: true })
})

/** The state file both the CLI and an unconfigured gateway use. */
function statePath(): string {
  return join(scratch, 'marketplace', 'state.json')
}

/** The per-user patch layer both faces compose into. */
function patchLayerPath(): string {
  return join(scratch, 'cordis.patch.yml')
}

/** Route every fetch by url; a url with no entry fails the way an outage does. */
function serve(byUrl: Readonly<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const body = byUrl[String(input)]
    if (body === undefined) throw new TypeError('connection refused')
    return new Response(JSON.stringify(body), { status: 200 })
  })
}

/**
 * Boot a test-only `cordis.yml` through the real Loader with a row that sets no
 * config, so the schema defaults decide every path.
 *
 * @returns the composed gateway service.
 */
async function bootComposed(): Promise<MarketplaceGateway> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-gateway-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, `- name: '${SPECIFIER}'\n`)

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([[SPECIFIER, MarketplaceGateway]])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>

  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  // The composition file is scratch for this boot only; the harness home it
  // resolves is the one this suite redirects DSH_HOME to.
  rmSync(root, { recursive: true, force: true })
  return context.get('marketplace') as MarketplaceGateway
}

describe('a row that configures nothing', () => {
  it('reads and writes exactly where the CLI does', async () => {
    const gateway = await bootComposed()
    serve({
      [MANIFEST]: {
        name: 'official',
        plugins: [{ name: 'pinned', source: PINNED }],
      },
    })
    recipes.set(PINNED.url, (destination) => {
      mkdirSync(destination, { recursive: true })
      writeFileSync(
        join(destination, '.mcp.json'),
        JSON.stringify({ mcpServers: { 'pinned-mcp': { command: 'npx', args: ['-y', 'thing'] } } }),
        'utf8',
      )
    })
    saveState(statePath(), upsertMarketplace(emptyState(), 'official', MANIFEST))

    const result = await gateway.install({ plugin: 'pinned' })
    expect(result.sha).toBe(PINNED.sha)

    // The default state path is the record the CLI maintains.
    expect(loadState(statePath()).installed[0]).toMatchObject({ plugin: 'pinned', sha: PINNED.sha })

    // The default patch layer is the per-user one, and the toggle reaches it.
    const off = await gateway.setEnabled({ plugin: 'pinned', enabled: false })
    expect(off.rowsChanged).toBe(1)
    expect(readEnabled(parsePatchLayer(patchLayerPath()).patches, 'marketplace:mcp:pinned-mcp')).toBe(false)

    // Reading back proves BOTH defaults were used, not just the write.
    await expect(gateway.status()).resolves.toMatchObject({
      installed: [{ plugin: 'pinned', state: 'disabled', rowIds: ['marketplace:mcp:pinned-mcp'] }],
    })
  })
})

describe('a state file that cannot be trusted', () => {
  it('fails the read instead of answering that nothing is installed', async () => {
    const gateway = new MarketplaceGateway(new Context(), { harnessHome: scratch })
    mkdirSync(join(scratch, 'marketplace'), { recursive: true })
    writeFileSync(statePath(), '{ this is not json', 'utf8')

    // The read is synchronous up to the trust check, so it throws rather than
    // returning a rejected promise; either way the Remote layer turns it into a
    // failed result for the panel instead of an empty list.
    expect(() => gateway.status()).toThrow(/not valid JSON/u)
  })

  it('treats an absent state file as a fresh harness', async () => {
    // The real `loadState` already turns ENOENT into an empty state, so this arm
    // is reachable only if that changes. The fault is injected to pin the
    // fallback this read owns: a first-run harness has no record yet, and a
    // panel that errored on that would report a missing file the user has no
    // reason to have.
    vi.resetModules()
    vi.doMock('../src/state.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/state.ts')>()
      return {
        ...actual,
        loadState: () => {
          const error = new Error(`ENOENT: no such file or directory, open '${statePath()}'`) as NodeJS.ErrnoException
          error.code = 'ENOENT'
          throw error
        },
      }
    })

    try {
      const { default: FreshGateway } = await import('../src/gateway.ts')
      const { Context: FreshContext } = await import('@deepseek-ai/cordis')
      const gateway = new FreshGateway(new FreshContext(), { harnessHome: scratch })

      await expect(gateway.status()).resolves.toMatchObject({ marketplaces: [], installed: [] })
    } finally {
      vi.doUnmock('../src/state.ts')
      vi.resetModules()
    }
  })
})

describe('an install fault', () => {
  it('carries a fault that is not an Error onto the wire as install-failed', async () => {
    const gateway = new MarketplaceGateway(new Context(), { harnessHome: scratch })
    serve({ [MANIFEST]: { name: 'official', plugins: [{ name: 'broken', source: PINNED }] } })
    saveState(statePath(), upsertMarketplace(emptyState(), 'official', MANIFEST))
    const fault: unknown = 'disk exploded'
    recipes.set(PINNED.url, () => {
      throw fault
    })

    await expect(gateway.install({ plugin: 'broken' })).rejects.toMatchObject({
      code: 'marketplace/install-failed',
      details: { plugin: 'broken', reason: 'disk exploded' },
    })
  })

  it('omits the sha for a source that has no commit to name', async () => {
    const gateway = new MarketplaceGateway(new Context(), { harnessHome: scratch })
    serve({ [MANIFEST]: { name: 'official', plugins: [{ name: 'localish', source: './plugins/localish' }] } })
    saveState(statePath(), upsertMarketplace(emptyState(), 'official', MANIFEST))
    recipes.set('./plugins/localish', (destination) => {
      mkdirSync(join(destination, 'commands'), { recursive: true })
    })

    const result = await gateway.install({ plugin: 'localish' })

    expect(result.plugin).toBe('localish')
    // Absent, not empty: the panel branches on the field, and an empty string
    // would render as a commit nobody can look up.
    expect('sha' in result).toBe(false)
    expect(result.status.installed[0]?.sha).toBeUndefined()
    expect(result.status.installed[0]?.plugin).toBe('localish')
  })
})

describe('the status read', () => {
  it('resolves a plugin with no recorded row ids from its own .mcp.json', async () => {
    const gateway = new MarketplaceGateway(new Context(), { harnessHome: scratch })
    const installPath = join(scratch, 'marketplace', 'plugins', 'legacy')
    mkdirSync(installPath, { recursive: true })
    writeFileSync(
      join(installPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'Legacy Server': { command: 'npx', args: ['-y', 'thing'] } } }),
      'utf8',
    )
    // A record written before `rowIds` existed, with the row already mounted.
    saveState(statePath(), {
      ...emptyState(),
      installed: [{
        id: rowIdFor('legacy'),
        marketplace: 'official',
        plugin: 'legacy',
        sourceUrl: PINNED.url,
        installPath,
        capabilities: ['mcp'],
        installedAt: new Date(0).toISOString(),
      }],
    })
    writeFileSync(
      patchLayerPath(),
      serializePatchLayer([{ insert: [{ id: 'marketplace:mcp:Legacy-Server', name: '@deepseek-ai/dsh-mcp-client' }] }]),
      'utf8',
    )

    const view = await gateway.status()

    // The coerced server name, matching the id the writer recorded.
    expect(view.installed[0]?.rowIds).toEqual(['marketplace:mcp:Legacy-Server'])
    expect(view.installed[0]?.state).toBe('enabled')
  })
})
