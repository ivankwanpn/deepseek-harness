/**
 * Tests for the marketplace Remote face.
 *
 * Both tests exist to pin a contract the panel depends on: that the snapshot
 * joins the state file with the LIVE patch layer, and that reading it never
 * mutates the disk. The second is the one that would be easiest to regress by
 * "simplifying" the read to reuse the materializer.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import MarketplaceGateway from '../src/gateway.ts'
import { serializePatchLayer } from '../src/patch-layer.ts'
import { emptyState, rowIdFor, saveState, type InstalledEntry } from '../src/state.ts'
import type { MarketplaceStatusView } from '../src/types.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-gateway-'))
})

afterEach(() => {
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
async function harness(): Promise<{ ctx: Context; gateway: MarketplaceGateway }> {
  const ctx = new Context()
  const gateway = new MarketplaceGateway(ctx, {
    harnessHome: scratch,
    statePath: join(scratch, 'marketplace', 'state.json'),
    patchLayerPath: join(scratch, 'cordis.patch.yml'),
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
  it('publishes one direct status method under the marketplace namespace', async () => {
    const { gateway } = await harness()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'marketplace',
      namespace: 'marketplace',
    })
    expect(remoteMethods(gateway)).toEqual([{ method: 'status', invocation: { kind: 'direct' } }])
    // The generated client face is what the panel compiles against.
    const remote = gateway.typertRemote as unknown as { methods?: unknown }
    expect(remote).toBeDefined()
  })

  it('reports an empty marketplace when no state file exists yet', async () => {
    const { gateway } = await harness()
    await expect(statusOf(gateway)).resolves.toEqual({ marketplaces: [], installed: [] })
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

// Referenced so the RemoteResult import documents the shape the panel unwraps.
export type _RemoteResultCheck = RemoteResult<MarketplaceStatusView>
