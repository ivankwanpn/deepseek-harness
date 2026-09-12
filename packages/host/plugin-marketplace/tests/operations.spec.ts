/**
 * Behavioural cover for the write operations both faces call.
 *
 * `setPluginEnabled` is one verb over two mechanisms, and the failures it exists
 * to prevent are all "reported success while writing nothing" ones: a caller
 * that recomputed `marketplace:<plugin>` instead of reading the recorded ids
 * would address no row, and one that moved the plugin's NAME instead of the
 * recorded skill entries would move nothing. So these tests run the real
 * sequence — sync to record ownership, then toggle — and assert the patch-layer
 * bytes and the discovery root, not the returned flags alone. `ownedBy` is
 * pinned the same way: the record wins when it has one, and the plugin
 * directory is only read when the record cannot answer.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { disabledSkillsDir, type MaterializeOptions } from '../src/materialize.ts'
import { ownedBy, setPluginEnabled } from '../src/operations.ts'
import { parsePatchLayer, readEnabled } from '../src/patch-layer.ts'
import { emptyState, loadState, rowIdFor, upsertInstalled, type InstalledEntry } from '../src/state.ts'
import { sync } from '../src/sync.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-operations-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The skills root these tests write into, pinned so nothing escapes them. */
function options(): MaterializeOptions {
  return { harnessHome: scratch, agentsSkillsDir: join(scratch, '.agents', 'skills') }
}

/** The discovery root `options()` names. */
function root(): string {
  return join(scratch, '.agents', 'skills')
}

/**
 * A plugin directory carrying the capabilities named.
 *
 * @param plugin - directory name under the scratch install root.
 * @param skills - skill directory name to frontmatter description.
 * @param servers - MCP server name to command.
 * @returns the plugin's directory.
 */
function pluginDir(plugin: string, skills: Record<string, string>, servers: Record<string, string>): string {
  const installPath = join(scratch, 'plugins', plugin)
  mkdirSync(installPath, { recursive: true })
  for (const [name, description] of Object.entries(skills)) {
    mkdirSync(join(installPath, 'skills', name), { recursive: true })
    writeFileSync(join(installPath, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`, 'utf8')
  }
  if (Object.keys(servers).length > 0) {
    writeFileSync(
      join(installPath, '.mcp.json'),
      JSON.stringify({ mcpServers: Object.fromEntries(Object.entries(servers).map(([name, command]) => [name, { command }])) }),
      'utf8',
    )
  }
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

/** The patch layer, state file and skills root one scenario uses. */
function scenario(plugin: string, installPath: string, capabilities: InstalledEntry['capabilities']): {
  entry: InstalledEntry
  enablement: { patchLayerPath: string; materialize: MaterializeOptions }
  statePath: string
} {
  const patchLayerPath = join(scratch, 'cordis.patch.yml')
  const statePath = join(scratch, 'state.json')
  const materialize = options()
  const state = upsertInstalled(emptyState(), entryFor(plugin, installPath, capabilities))
  sync(state, { patchLayerPath, materialize, statePath })
  const entry = loadState(statePath).installed[0]
  if (entry === undefined) throw new Error('sync recorded no entry')
  return { entry, enablement: { patchLayerPath, materialize }, statePath }
}

describe('ownedBy', () => {
  it('answers from the record when it carries both sets of ids', () => {
    const installPath = pluginDir('recorded', {}, { recorded: 'srv' })
    const entry: InstalledEntry = {
      ...entryFor('recorded', installPath, ['mcp']),
      rowIds: ['marketplace:mcp:recorded'],
      skillIds: ['from-the-record'],
    }

    expect(ownedBy(entry, options())).toEqual({
      rowIds: ['marketplace:mcp:recorded'],
      skillIds: ['from-the-record'],
    })

    // Proof it did not re-read the directory: the recorded ids survive even
    // though the plugin ships neither of them any more.
    rmSync(installPath, { recursive: true, force: true })
    expect(ownedBy(entry, options())).toEqual({
      rowIds: ['marketplace:mcp:recorded'],
      skillIds: ['from-the-record'],
    })
  })

  it('materializes the plugin directory for a record an older build wrote', () => {
    const installPath = pluginDir('legacy', { solo: 'Recovered from disk.' }, { legacy: 'npx' })
    const entry = entryFor('legacy', installPath, ['skills', 'mcp'])

    expect(ownedBy(entry, options())).toEqual({
      rowIds: ['marketplace:mcp:legacy'],
      skillIds: ['solo'],
    })
  })

  it('fills in only the half the record is missing', () => {
    const installPath = pluginDir('half', { solo: 'From disk.' }, { half: 'npx' })
    const entry: InstalledEntry = { ...entryFor('half', installPath, ['skills', 'mcp']), rowIds: ['marketplace:mcp:half'] }

    // The recorded row ids are kept as recorded; only the missing skill entries
    // are recovered from the directory.
    expect(ownedBy(entry, options())).toEqual({
      rowIds: ['marketplace:mcp:half'],
      skillIds: ['solo'],
    })
  })

  it('names nothing when the plugin directory cannot be materialized', () => {
    const installPath = pluginDir('broken', { solo: 'Cannot land.' }, {})
    // A regular file where the discovery root would be created: materializing
    // fails, and the operation must still be able to run and report.
    const blocker = join(scratch, 'blocker')
    writeFileSync(blocker, 'not a directory', 'utf8')

    const result = ownedBy(entryFor('broken', installPath, ['skills']), {
      harnessHome: scratch,
      agentsSkillsDir: join(blocker, 'skills'),
    })

    expect(result).toEqual({ rowIds: [], skillIds: [] })
    expect(existsSync(join(blocker, 'skills'))).toBe(false)
  })
})

describe('setPluginEnabled', () => {
  it('takes both mechanisms away and reports what moved', () => {
    const installPath = pluginDir('toggle', { 'skill-one': 'Discovered.' }, { 'toggle-mcp': 'npx' })
    const { entry, enablement } = scenario('toggle', installPath, ['skills', 'mcp'])
    expect(entry.rowIds).toEqual(['marketplace:mcp:toggle-mcp'])
    expect(entry.skillIds).toEqual(['skill-one'])

    const off = setPluginEnabled(entry, false, enablement)

    expect(off).toEqual({ rowsChanged: 1, skillsMoved: true, alreadyInState: false, mountsNothing: false })
    // Both surfaces, read back from disk: the row is flagged and the skill left
    // discovery rather than being deleted.
    expect(readEnabled(parsePatchLayer(enablement.patchLayerPath).patches, 'marketplace:mcp:toggle-mcp')).toBe(false)
    expect(existsSync(join(root(), 'skill-one'))).toBe(false)
    expect(readFileSync(join(disabledSkillsDir(enablement.materialize, 'toggle'), 'skill-one', 'SKILL.md'), 'utf8'))
      .toContain('Discovered.')

    // Standing in the requested state is reported as such, not as a write.
    expect(setPluginEnabled(entry, false, enablement))
      .toEqual({ rowsChanged: 0, skillsMoved: false, alreadyInState: true, mountsNothing: false })

    const on = setPluginEnabled(entry, true, enablement)
    expect(on).toEqual({ rowsChanged: 1, skillsMoved: true, alreadyInState: false, mountsNothing: false })
    expect(readEnabled(parsePatchLayer(enablement.patchLayerPath).patches, 'marketplace:mcp:toggle-mcp')).toBe(true)
    expect(readFileSync(join(root(), 'skill-one', 'SKILL.md'), 'utf8')).toContain('Discovered.')
  })

  it('separates "mounts nothing" from "already off"', () => {
    const installPath = pluginDir('nothing', {}, {})
    const enablement = { patchLayerPath: join(scratch, 'cordis.patch.yml'), materialize: options() }

    // Nothing to toggle is a different answer from "it was already off", and
    // only the record can tell them apart.
    expect(setPluginEnabled(entryFor('nothing', installPath, []), false, enablement))
      .toEqual({ rowsChanged: 0, skillsMoved: false, alreadyInState: true, mountsNothing: true })
    expect(existsSync(enablement.patchLayerPath)).toBe(false)
  })

  it('addresses the recorded row ids rather than a name derived from the plugin', () => {
    const installPath = pluginDir('namespaced', {}, { 'server-name': 'npx' })
    const { entry, enablement } = scenario('namespaced', installPath, ['mcp'])

    // The id a caller would recompute from the plugin name matches no row, so
    // the toggle would write nothing and still report success.
    expect(setPluginEnabled(entry, false, enablement).rowsChanged).toBe(1)
    expect(readEnabled(parsePatchLayer(enablement.patchLayerPath).patches, 'marketplace:mcp:server-name')).toBe(false)
    expect(readEnabled(parsePatchLayer(enablement.patchLayerPath).patches, rowIdFor('namespaced'))).toBeUndefined()
  })
})
