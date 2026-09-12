/**
 * Tests for the marketplace Remote face.
 *
 * Both tests exist to pin a contract the panel depends on: that the snapshot
 * joins the state file with the LIVE patch layer, and that reading it never
 * mutates the disk. The second is the one that would be easiest to regress by
 * "simplifying" the read to reuse the materializer.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import MarketplaceGateway from '../src/gateway.ts'
import { disabledSkillsDir, materializeEntry, skillsRootDir } from '../src/materialize.ts'
import type { PluginSource } from '../src/parse.ts'
import { serializePatchLayer } from '../src/patch-layer.ts'
import { emptyState, rowIdFor, saveState, upsertMarketplace, type InstalledEntry } from '../src/state.ts'
import type { MarketplaceStatusView } from '../src/types.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-gateway-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  resolveRefSha.mockReset()
  rmSync(scratch, { recursive: true, force: true })
})

/** A plugin directory whose `.mcp.json` declares one stdio server. */
function pluginWithServer(name: string, serverName: string): string {
  const root = join(scratch, 'plugins', name)
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { [serverName]: { command: 'npx', args: ['-y', 'thing'] } } }),
    'utf8',
  )
  return root
}

/** Mount the gateway against the scratch harness home. */
async function harness(config: { allowMutations?: boolean } = {}): Promise<{ ctx: Context; gateway: MarketplaceGateway }> {
  const ctx = new Context()
  const gateway = new MarketplaceGateway(ctx, {
    harnessHome: scratch,
    statePath: join(scratch, 'marketplace', 'state.json'),
    patchLayerPath: join(scratch, 'cordis.patch.yml'),
    ...config,
  })
  return { ctx, gateway }
}

/** Read the snapshot, failing loudly instead of returning a failure union. */
async function statusOf(gateway: MarketplaceGateway): Promise<MarketplaceStatusView> {
  return gateway.status()
}

/**
 * Every path under a root, with file contents — a whole-tree fingerprint.
 *
 * Sorted, so the comparison catches a write without depending on directory
 * iteration order.
 *
 * @param root - the directory to walk.
 * @returns one `relative:bytes` line per file, sorted.
 */
function snapshotTree(root: string): string[] {
  const lines: string[] = []
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name)
      if (item.isDirectory()) walk(full)
      else lines.push(`${full.slice(root.length)}:${readFileSync(full, 'utf8')}`)
    }
  }
  walk(root)
  return lines.sort()
}

describe('marketplace Remote face', () => {
  it('publishes the two reads and the three write verbs under the marketplace namespace', async () => {
    const { gateway } = await harness()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'marketplace',
      namespace: 'marketplace',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'setEnabled', invocation: { kind: 'direct' } },
      { method: 'uninstall', invocation: { kind: 'direct' } },
      { method: 'catalog', invocation: { kind: 'direct' } },
      { method: 'install', invocation: { kind: 'direct' } },
    ])
    // The generated client face is what the panel compiles against.
    const remote = gateway.typertRemote as unknown as { methods?: unknown }
    expect(remote).toBeDefined()
  })

  it('reports an empty marketplace when no state file exists yet', async () => {
    const { gateway } = await harness()
    await expect(statusOf(gateway)).resolves.toEqual({ marketplaces: [], installed: [], allowMutations: true })
  })

  it('joins the state record with the live patch layer for enablement', async () => {
    const { gateway } = await harness()
    const installPath = pluginWithServer('aikido', 'aikido-mcp')
    const entry: InstalledEntry = {
      id: rowIdFor('aikido'),
      marketplace: 'official',
      plugin: 'aikido',
      sourceUrl: 'https://example.test/aikido.git',
      sha: 'a'.repeat(40),
      installPath,
      rowIds: ['marketplace:mcp:aikido-mcp'],
      capabilities: ['mcp'],
      installedAt: new Date(0).toISOString(),
    }
    saveState(join(scratch, 'marketplace', 'state.json'), {
      ...emptyState(),
      marketplaces: [{ name: 'official', url: 'https://example.test/marketplace.json' }],
      installed: [entry],
    })

    // Row present but enabled: `readEnabled` treats an absent `disabled` as on.
    writeFileSync(
      join(scratch, 'cordis.patch.yml'),
      serializePatchLayer([{ insert: [{ id: 'marketplace:mcp:aikido-mcp', name: '@deepseek-ai/dsh-mcp-client' }] }]),
      'utf8',
    )
    const enabled = await statusOf(gateway)
    expect(enabled.marketplaces).toEqual([{ name: 'official', url: 'https://example.test/marketplace.json' }])
    expect(enabled.installed[0]).toMatchObject({
      plugin: 'aikido',
      marketplace: 'official',
      sha: 'a'.repeat(40),
      rowIds: ['marketplace:mcp:aikido-mcp'],
      state: 'enabled',
    })

    // Flipping the flag in the patch layer is visible on the NEXT read, with no
    // state write: enablement has exactly one home, and this read honours it.
    writeFileSync(
      join(scratch, 'cordis.patch.yml'),
      serializePatchLayer([
        { insert: [{ id: 'marketplace:mcp:aikido-mcp', name: '@deepseek-ai/dsh-mcp-client', disabled: true }] },
      ]),
      'utf8',
    )
    expect((await statusOf(gateway)).installed[0]?.state).toBe('disabled')
  })

  it('calls a plugin that mounts no loader row `no-rows`, not `disabled`', async () => {
    const { gateway } = await harness()
    const installPath = join(scratch, 'plugins', 'commit-commands')
    mkdirSync(join(installPath, 'commands'), { recursive: true })
    saveState(join(scratch, 'marketplace', 'state.json'), {
      ...emptyState(),
      installed: [{
        id: rowIdFor('commit-commands'),
        marketplace: 'official',
        plugin: 'commit-commands',
        sourceUrl: 'https://example.test/official.git',
        sha: 'b'.repeat(40),
        installPath,
        capabilities: ['commands'],
        installedAt: new Date(0).toISOString(),
      }],
    })

    const view = await statusOf(gateway)
    expect(view.installed[0]?.rowIds).toEqual([])
    expect(view.installed[0]?.state).toBe('no-rows')
  })

  it('derives row ids from .mcp.json for a record that predates the field', async () => {
    const { gateway } = await harness()
    // No `rowIds`: the unannotated shape an older build wrote.
    const installPath = pluginWithServer('legacy', 'Legacy Server')
    saveState(join(scratch, 'marketplace', 'state.json'), {
      ...emptyState(),
      installed: [{
        id: rowIdFor('legacy'),
        marketplace: 'official',
        plugin: 'legacy',
        sourceUrl: 'https://example.test/legacy.git',
        installPath,
        capabilities: ['mcp'],
        installedAt: new Date(0).toISOString(),
      }],
    })

    const view = await statusOf(gateway)
    // The coerced server name, matching what the writer would have recorded.
    expect(view.installed[0]?.rowIds).toEqual(['marketplace:mcp:Legacy-Server'])
    expect(view.installed[0]?.state).toBe('not-mounted')
  })

  it('reads without mutating the plugin directory', async () => {
    // The regression this guards: reusing `materializeEntry` here would copy
    // skills and could park them under `.disabled` merely because a settings
    // tab was opened. Every path is compared rather than one guessed skills
    // root, so a write anywhere under the harness home fails the test.
    const { gateway } = await harness()
    const installPath = join(scratch, 'plugins', 'skillful')
    mkdirSync(join(installPath, 'skills', 'demo'), { recursive: true })
    writeFileSync(join(installPath, 'skills', 'demo', 'SKILL.md'), '# demo\n', 'utf8')
    saveState(join(scratch, 'marketplace', 'state.json'), {
      ...emptyState(),
      installed: [{
        id: rowIdFor('skillful'),
        marketplace: 'official',
        plugin: 'skillful',
        sourceUrl: 'https://example.test/skillful.git',
        installPath,
        capabilities: ['skills'],
        installedAt: new Date(0).toISOString(),
      }],
    })

    const before = snapshotTree(scratch)
    await statusOf(gateway)
    expect(snapshotTree(scratch)).toEqual(before)
  })

  it('marks rows absent from the patch layer as not-mounted', async () => {
    const { gateway } = await harness()
    const installPath = pluginWithServer('aikido', 'aikido-mcp')
    saveState(join(scratch, 'marketplace', 'state.json'), {
      ...emptyState(),
      installed: [{
        id: rowIdFor('aikido'),
        marketplace: 'official',
        plugin: 'aikido',
        sourceUrl: 'https://example.test/aikido.git',
        installPath,
        rowIds: ['marketplace:mcp:aikido-mcp'],
        capabilities: ['mcp'],
        installedAt: new Date(0).toISOString(),
      }],
    })

    // State exists but nothing composed a row for it: the next CLI sync repairs
    // this, and the panel must not claim it is enabled.
    expect((await statusOf(gateway)).installed[0]?.state).toBe('not-mounted')
  })
})

describe('marketplace write face', () => {
  /**
   * Install one skills-only plugin the way an install does: content on disk,
   * entries materialized into the discovery root, ownership recorded.
   *
   * @param plugin - plugin and directory name.
   * @param skill - the single skill it ships.
   * @returns the installed record that was saved.
   */
  function installSkillsPlugin(plugin: string, skill: string): InstalledEntry {
    const installPath = join(scratch, 'plugins', plugin)
    mkdirSync(join(installPath, 'skills', skill), { recursive: true })
    writeFileSync(
      join(installPath, 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: Fixture.\n---\n\nBody.\n`,
      'utf8',
    )
    const entry: InstalledEntry = {
      id: rowIdFor(plugin),
      marketplace: 'official',
      plugin,
      sourceUrl: 'https://example.test/plugin.git',
      installPath,
      skillIds: [skill],
      capabilities: ['skills'],
      installedAt: new Date(0).toISOString(),
    }
    materializeEntry(entry, { harnessHome: scratch })
    saveState(join(scratch, 'marketplace', 'state.json'), { ...emptyState(), installed: [entry] })
    return entry
  }

  it('reports where a skills-only plugin\u2019s entries are, then parks and restores them', async () => {
    const { gateway } = await harness()
    installSkillsPlugin('superpowers', 'brainstorming')
    expect((await statusOf(gateway)).installed[0]).toMatchObject({
      plugin: 'superpowers',
      state: 'no-rows',
      skillIds: ['brainstorming'],
      skills: 'live',
    })

    const disabled = await gateway.setEnabled({ plugin: 'superpowers', enabled: false })
    expect(disabled).toMatchObject({ plugin: 'superpowers', rowsChanged: 0, skillsMoved: true, alreadyInState: false })
    expect(disabled.status.installed[0]?.skills).toBe('parked')
    expect(existsSync(join(skillsRootDir({ harnessHome: scratch }), 'brainstorming'))).toBe(false)
    expect(existsSync(join(disabledSkillsDir({ harnessHome: scratch }, 'superpowers'), 'brainstorming'))).toBe(true)

    // Enabling back moves them without a re-fetch, and the returned status says
    // so: the panel never has to guess what the write did.
    const enabled = await gateway.setEnabled({ plugin: 'superpowers', enabled: true })
    expect(enabled.skillsMoved).toBe(true)
    expect(enabled.status.installed[0]?.skills).toBe('live')
    expect(existsSync(join(skillsRootDir({ harnessHome: scratch }), 'brainstorming'))).toBe(true)
  })

  it('reports a plugin that mounts nothing instead of pretending a toggle applied', async () => {
    const { gateway } = await harness()
    const installPath = join(scratch, 'plugins', 'inert')
    mkdirSync(join(installPath, 'commands'), { recursive: true })
    saveState(join(scratch, 'marketplace', 'state.json'), {
      ...emptyState(),
      installed: [{
        id: rowIdFor('inert'),
        marketplace: 'official',
        plugin: 'inert',
        sourceUrl: 'https://example.test/inert.git',
        installPath,
        capabilities: ['commands'],
        installedAt: new Date(0).toISOString(),
      }],
    })

    await expect(gateway.setEnabled({ plugin: 'inert', enabled: false })).resolves.toMatchObject({
      mountsNothing: true,
      alreadyInState: true,
      rowsChanged: 0,
      skillsMoved: false,
    })
  })

  it('uninstalls content, materialized skills and the record in one call', async () => {
    const { gateway } = await harness()
    const entry = installSkillsPlugin('removable', 'solo')

    const result = await gateway.uninstall({ plugin: 'removable' })

    expect(result.removed).toBe(true)
    expect(result.status.installed).toEqual([])
    expect(existsSync(entry.installPath)).toBe(false)
    // Skills live in the shared root, not under installPath: leaving them there
    // is how a removed plugin keeps being offered to the model.
    expect(existsSync(join(skillsRootDir({ harnessHome: scratch }), 'solo'))).toBe(false)
    await expect(gateway.uninstall({ plugin: 'removed' })).resolves.toMatchObject({ removed: false })
  })

  it('refuses every write when the deployment serves the panel read-only', async () => {
    const { gateway } = await harness({ allowMutations: false })
    installSkillsPlugin('superpowers', 'brainstorming')

    // The read still reports the fact, so the panel can explain itself; the
    // check itself lives in the write path, not in the panel.
    expect((await statusOf(gateway)).allowMutations).toBe(false)
    await expect(gateway.setEnabled({ plugin: 'superpowers', enabled: false }))
      .rejects.toThrow(/read-only/u)
    await expect(gateway.uninstall({ plugin: 'superpowers' })).rejects.toThrow(/read-only/u)
    expect(existsSync(join(skillsRootDir({ harnessHome: scratch }), 'brainstorming'))).toBe(true)
  })

  it('refuses an unknown plugin and a malformed request', async () => {
    const { gateway } = await harness()

    await expect(gateway.setEnabled({ plugin: 'ghost', enabled: true })).rejects.toThrow(/not installed/u)
    await expect(gateway.setEnabled({ plugin: '  ', enabled: true })).rejects.toThrow(/non-blank plugin name/u)
    await expect(gateway.setEnabled({ plugin: 'ghost', enabled: 'yes' as never })).rejects.toThrow(/boolean enabled/u)
    await expect(gateway.uninstall({ plugin: '' })).rejects.toThrow(/non-blank plugin name/u)
  })
})

const PINNED = { source: 'git', url: 'https://example.test/pinned.git', sha: 'a'.repeat(40) }
const LOOSE = { source: 'git', url: 'https://example.test/loose.git' }
const MANIFEST = 'https://example.test/marketplace.json'

/**
 * The commit the stubbed ref resolution names for an unpinned source.
 *
 * `resolveRefSha` asks a remote what a ref points at, which is the one install
 * step the pin opt-in adds, so the resolution is stubbed and everything the
 * install does with the commit it returns stays real.
 */
const resolveRefSha = vi.hoisted(() => vi.fn<(url: string, ref?: string) => Promise<string>>())
const RESOLVED_SHA = 'c'.repeat(40)

/**
 * Stand in for the two steps an install cannot take without a network: the
 * clone, and the ref resolution the pin opt-in performs.
 *
 * `fetchPlugin` shells out to git, so a pinned git source is the half no unit
 * test here can reach; everything install does with what the fetch hands back is
 * the same either way, and that is what the success case pins. The stub reports
 * the source's sha as the commit it checked out, which is what a real fetch of a
 * resolved commit returns. Every other export stays real, so capabilities and
 * warnings are still read from the tree the fetch left on disk.
 */
vi.mock('../src/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.ts')>()
  return {
    ...actual,
    fetchPlugin: async (source: PluginSource, destination: string) => {
      mkdirSync(join(destination, 'commands'), { recursive: true })
      return {
        root: destination,
        capabilities: actual.detectCapabilities(destination),
        resolvedSha: source.kind === 'git' ? (source.sha ?? '') : '',
      }
    },
    resolveRefSha,
  }
})

/** Register one marketplace in the scratch state and serve its manifest. */
async function withMarketplace(plugins: readonly object[]): Promise<void> {
  mkdirSync(join(scratch, 'marketplace'), { recursive: true })
  const state = upsertMarketplace(emptyState(), 'test', MANIFEST)
  saveState(join(scratch, 'marketplace', 'state.json'), state)
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ name: 'test', plugins }), { status: 200 }))
}

describe('marketplace.catalog', () => {
  it('answers on a read-only deployment, because browsing is a read', async () => {
    const { gateway } = await harness({ allowMutations: false })
    await withMarketplace([{ name: 'pinned', source: PINNED }])
    const view = await gateway.catalog()
    expect(view.rows.map(row => row.plugin)).toEqual(['pinned'])
  })

  it('restates the catalog rows as the wire contract', async () => {
    const { gateway } = await harness()
    await withMarketplace([{ name: 'loose', source: LOOSE }])
    const view = await gateway.catalog()
    expect(view.rows[0]).toMatchObject({ plugin: 'loose', installable: false, installed: false })
    expect(view.failed).toEqual([])
  })

  it('reports a registration it could not read without dropping the readable rows', async () => {
    const { gateway } = await harness()
    mkdirSync(join(scratch, 'marketplace'), { recursive: true })
    // The unreachable registration is FIRST, so a non-empty `rows` can only mean
    // the read continued past it.
    saveState(
      join(scratch, 'marketplace', 'state.json'),
      upsertMarketplace(upsertMarketplace(emptyState(), 'down', 'https://example.test/down.json'), 'test', MANIFEST),
    )
    vi.stubGlobal('fetch', async (url: string) => {
      if (url !== MANIFEST) throw new TypeError('connection refused')
      return new Response(JSON.stringify({ name: 'test', plugins: [{ name: 'pinned', source: PINNED }] }), { status: 200 })
    })

    const view = await gateway.catalog()
    expect(view.failed).toEqual([
      { marketplace: 'down', reason: expect.stringContaining('connection refused') as string },
    ])
    expect(view.rows.map(row => row.plugin)).toEqual(['pinned'])
  })
})

describe('marketplace.install', () => {
  it('refuses on a read-only deployment', async () => {
    const { gateway } = await harness({ allowMutations: false })
    await withMarketplace([{ name: 'pinned', source: PINNED }])
    await expect(gateway.install({ plugin: 'pinned' })).rejects.toMatchObject({ code: 'marketplace/read-only' })
  })

  it('refuses a name no marketplace lists', async () => {
    const { gateway } = await harness()
    await withMarketplace([{ name: 'pinned', source: PINNED }])
    await expect(gateway.install({ plugin: 'absent' })).rejects.toMatchObject({ code: 'marketplace/not-found' })
  })

  it('refuses an unpinned entry', async () => {
    const { gateway } = await harness()
    await withMarketplace([{ name: 'loose', source: LOOSE }])
    await expect(gateway.install({ plugin: 'loose' })).rejects.toMatchObject({ code: 'marketplace/unpinned' })
  })

  it('installs an unpinned entry when the request accepts the pin it resolves', async () => {
    const { gateway } = await harness()
    await withMarketplace([{ name: 'loose', source: LOOSE }])

    // The refusal above and the install below are the same request; only the
    // flag differs, so accepting a moving ref is the caller's decision rather
    // than a property of the entry.
    resolveRefSha.mockResolvedValue(RESOLVED_SHA)
    const result = await gateway.install({ plugin: 'loose', allowUnpinned: true })

    // The entry declares no ref, so the remote's HEAD is what was resolved.
    expect(resolveRefSha).toHaveBeenCalledWith(LOOSE.url, 'HEAD')
    // That commit is the install's pin, on the returned result and in the state
    // the panel reads back.
    expect(result).toMatchObject({ plugin: 'loose', sha: RESOLVED_SHA })
    expect(result.status.installed[0]).toMatchObject({ plugin: 'loose', sha: RESOLVED_SHA })
  })

  it('returns what the install recorded and the status that produced', async () => {
    const { gateway } = await harness()
    await withMarketplace([{ name: 'pinned', source: PINNED }])

    const result = await gateway.install({ plugin: 'pinned' })

    expect(result).toMatchObject({ plugin: 'pinned', sha: PINNED.sha, warnings: [] })
    // The status is the post-write one, so the panel needs no second round trip.
    expect(result.status.installed[0]).toMatchObject({
      plugin: 'pinned',
      sha: PINNED.sha,
      capabilities: ['commands'],
    })
  })

  it('reports a fault after admission as install-failed', async () => {
    const { gateway } = await harness()
    mkdirSync(join(scratch, 'marketplace'), { recursive: true })
    saveState(join(scratch, 'marketplace', 'state.json'), upsertMarketplace(emptyState(), 'test', MANIFEST))
    vi.stubGlobal('fetch', async () => { throw new TypeError('connection refused') })

    await expect(gateway.install({ plugin: 'pinned' })).rejects.toMatchObject({
      code: 'marketplace/install-failed',
      details: { plugin: 'pinned', reason: expect.stringContaining('connection refused') as string },
    })
  })

  it('reports an unregistered marketplace as not-found', async () => {
    const { gateway } = await harness()
    await expect(gateway.install({ plugin: 'anything' })).rejects.toMatchObject({ code: 'marketplace/not-found' })
  })

  it('reports a name with no usable characters as a bad request, not a marketplace code', async () => {
    const { gateway } = await harness()
    await withMarketplace([{ name: '...', source: PINNED }])
    await expect(gateway.install({ plugin: '...' })).rejects.toMatchObject({ code: 'gateway/bad-request' })
  })
})
