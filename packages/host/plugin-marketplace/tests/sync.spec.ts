/**
 * Behavioural cover for the reconcile: state → materialize → patch layer.
 *
 * Sync is the only function that writes on the marketplace's behalf, and the
 * facts worth pinning are the ones a second writer would get wrong. Runs are
 * idempotent — an unchanged state writes nothing, because a write re-serializes
 * the patch file and a dump cannot keep the user's comments. Two entries that
 * resolve to the same mount are reported instead of being guessed between, and
 * a row the user mounted by hand under a marketplace id survives with its own
 * module. Every assertion reads the file back from disk.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePatchLayer, presentIds } from '../src/patch-layer.ts'
import { emptyState, loadState, rowIdFor, upsertInstalled, type InstalledEntry } from '../src/state.ts'
import { sync } from '../src/sync.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-sync-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** A plugin directory whose `.mcp.json` declares one stdio server. */
function pluginWithServer(plugin: string, serverName: string): string {
  const installPath = join(scratch, 'plugins', plugin)
  mkdirSync(installPath, { recursive: true })
  writeFileSync(
    join(installPath, '.mcp.json'),
    JSON.stringify({ mcpServers: { [serverName]: { command: 'npx', args: ['-y', serverName] } } }),
    'utf8',
  )
  return installPath
}

/** A plugin directory shipping one discoverable skill. */
function pluginWithSkill(plugin: string, skill: string): string {
  const installPath = join(scratch, 'plugins', plugin)
  mkdirSync(join(installPath, 'skills', skill), { recursive: true })
  writeFileSync(
    join(installPath, 'skills', skill, 'SKILL.md'),
    `---\nname: ${skill}\ndescription: Ships with ${plugin}.\n---\n\nBody.\n`,
    'utf8',
  )
  return installPath
}

/** An installed record for that directory, with no ownership recorded yet. */
function entryFor(plugin: string, installPath: string, capabilities: InstalledEntry['capabilities']): InstalledEntry {
  return {
    id: rowIdFor(plugin),
    marketplace: 'test',
    plugin,
    sourceUrl: 'https://example.test/plugin.git',
    installPath,
    capabilities,
    installedAt: new Date(0).toISOString(),
  }
}

/** The options every call in this file uses: everything under the scratch root. */
function options(): { patchLayerPath: string; materialize: { harnessHome: string; agentsSkillsDir: string }; statePath: string } {
  return {
    patchLayerPath: join(scratch, 'cordis.patch.yml'),
    materialize: { harnessHome: scratch, agentsSkillsDir: join(scratch, '.agents', 'skills') },
    statePath: join(scratch, 'state.json'),
  }
}

describe('reconciling an installed plugin', () => {
  it('records the resolved ownership and writes the rows the entries mount', () => {
    const installPath = pluginWithServer('aikido', 'aikido-mcp')
    const opts = options()
    const state = upsertInstalled(emptyState(), entryFor('aikido', installPath, ['mcp']))

    const result = sync(state, opts)

    expect(result.rows.map(row => row.id)).toEqual(['marketplace:mcp:aikido-mcp'])
    expect(result.wrotePatchLayer).toBe(true)
    expect(result.wroteState).toBe(true)
    expect(result.duplicateRowIds).toEqual([])
    expect(result.foreignRowIds).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.materialized.map(m => m.plugin)).toEqual(['aikido'])

    // The recorded ids are what enablement later addresses, so they have to be
    // on disk, not just in the returned value.
    expect(loadState(opts.statePath).installed[0]?.rowIds).toEqual(['marketplace:mcp:aikido-mcp'])
    expect(presentIds(parsePatchLayer(opts.patchLayerPath).patches)).toEqual(new Set(['marketplace:mcp:aikido-mcp']))
  })

  it('writes nothing on a second run with an unchanged state', () => {
    const installPath = pluginWithSkill('steady', 'solo')
    writeFileSync(join(installPath, '.mcp.json'), JSON.stringify({ mcpServers: { steady: { command: 'npx' } } }), 'utf8')
    const opts = options()
    const state = upsertInstalled(emptyState(), entryFor('steady', installPath, ['skills', 'mcp']))
    sync(state, opts)
    const patchBytes = readFileSync(opts.patchLayerPath, 'utf8')
    const stateBytes = readFileSync(opts.statePath, 'utf8')

    const second = sync(loadState(opts.statePath), opts)

    expect(second.wrotePatchLayer).toBe(false)
    expect(second.wroteState).toBe(false)
    expect(readFileSync(opts.patchLayerPath, 'utf8')).toBe(patchBytes)
    expect(readFileSync(opts.statePath, 'utf8')).toBe(stateBytes)
  })

  it('reconciles without writing when no state path is given', () => {
    const installPath = pluginWithSkill('diagnostic', 'solo')
    const opts = options()
    const state = upsertInstalled(emptyState(), entryFor('diagnostic', installPath, ['skills']))

    const result = sync(state, { patchLayerPath: opts.patchLayerPath, materialize: opts.materialize })

    // A purely diagnostic caller reads the same facts but owns no state file, so
    // nothing is re-serialized and no state path is invented.
    expect(result.wroteState).toBe(false)
    expect(result.materialized[0]?.result.skillIds).toEqual(['solo'])
    expect(existsSync(opts.statePath)).toBe(false)
  })
})

describe('two entries and one mount', () => {
  it('mounts neither when two entries resolve to the same row id', () => {
    // `mcp-client` reserves `serverName` per scope and throws on a duplicate, so
    // picking a winner by state order would be a silent, order-dependent choice.
    const state = upsertInstalled(
      upsertInstalled(emptyState(), entryFor('first', pluginWithServer('first', 'shared'), ['mcp'])),
      entryFor('second', pluginWithServer('second', 'shared'), ['mcp']),
    )
    const opts = options()

    const result = sync(state, opts)

    expect(result.duplicateRowIds).toEqual(['marketplace:mcp:shared (claimed by first and second)'])
    expect(result.warnings).toEqual([])
    // The first entry still resolves it for itself; only the patch layer refuses
    // to hold two rows under one id.
    expect(result.materialized.map(m => m.result.rows.length)).toEqual([1, 1])
    expect(result.materialized[1]?.result.rowIds).toEqual(['marketplace:mcp:shared'])
    const rows = parsePatchLayer(opts.patchLayerPath).patches
      .flatMap(patch => Array.isArray(patch.insert) ? patch.insert : [])
    expect(rows.filter(row => row.id === 'marketplace:mcp:shared')).toHaveLength(1)
  })

  it('leaves a row the user mounted under one of our ids, and reports it', () => {
    const opts = options()
    writeFileSync(opts.patchLayerPath, [
      '- insert:',
      '    - id: marketplace:mcp:shared',
      '      name: hand-written-module',
      '',
    ].join('\n'), 'utf8')
    const state = upsertInstalled(emptyState(), entryFor('claimant', pluginWithServer('claimant', 'shared'), ['mcp']))

    const result = sync(state, opts)

    expect(result.foreignRowIds).toEqual([
      'marketplace:mcp:shared is already mounted as hand-written-module; leaving it untouched',
    ])
    expect(result.warnings).toEqual([
      'marketplace:mcp:shared is already mounted as hand-written-module; leaving it untouched',
    ])
    const rows = parsePatchLayer(opts.patchLayerPath).patches
      .flatMap(patch => Array.isArray(patch.insert) ? patch.insert : [])
    expect(rows).toEqual([{ id: 'marketplace:mcp:shared', name: 'hand-written-module' }])
  })
})
