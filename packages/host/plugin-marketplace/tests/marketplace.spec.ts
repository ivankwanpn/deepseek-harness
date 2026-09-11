/**
 * Regression cover for the marketplace's two identity rules.
 *
 * Both tests exist because the bug they pin shipped and was invisible: the
 * command surface reported success while writing nothing, and a whole class of
 * registry entries failed with a message that named the wrong cause. Each
 * assertion is written against the OUTCOME (what the patch layer holds, what
 * the resolved source can address) rather than against the implementation, so a
 * refactor that keeps the contract keeps the test green.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { marketplaceRepoRoot, resolveLocalSource } from '../src/fetch.ts'
import { materializeEntry } from '../src/materialize.ts'
import { parsePatchLayer, readEnabled, setEnabled } from '../src/patch-layer.ts'
import { emptyState, upsertInstalled, rowIdFor, type InstalledEntry } from '../src/state.ts'
import { sync } from '../src/sync.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-test-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** A plugin directory whose `.mcp.json` declares one stdio server. */
function pluginWithServer(serverName: string): string {
  const root = join(scratch, 'plugin')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, '.mcp.json'),
    JSON.stringify({ mcpServers: { [serverName]: { command: 'npx', args: ['-y', 'thing'] } } }),
    'utf8',
  )
  return root
}

/** An installed record for that directory, with no row ids recorded yet. */
function entryFor(plugin: string, installPath: string): InstalledEntry {
  return {
    id: rowIdFor(plugin),
    marketplace: 'test',
    plugin,
    sourceUrl: 'https://example.test/plugin.git',
    installPath,
    capabilities: ['mcp'],
    installedAt: new Date(0).toISOString(),
  }
}

describe('row identity', () => {
  it('an MCP row is keyed on the sanitized server name, not the plugin name', () => {
    const installPath = pluginWithServer('My Server!')
    const result = materializeEntry(entryFor('some-plugin', installPath), { harnessHome: scratch })

    // The whole point: a caller cannot derive this from `some-plugin`.
    expect(result.rowIds).toEqual(['marketplace:mcp:My-Server-'])
    expect(result.rowIds).not.toContain(rowIdFor('some-plugin'))
  })

  it('sync records the resolved row ids so enablement can address them', () => {
    const installPath = pluginWithServer('aikido-mcp')
    const patchLayerPath = join(scratch, 'cordis.patch.yml')
    const statePath = join(scratch, 'state.json')
    const state = upsertInstalled(emptyState(), entryFor('aikido', installPath))

    const first = sync(state, { patchLayerPath, materialize: { harnessHome: scratch }, statePath })
    expect(first.rows.map(row => row.id)).toEqual(['marketplace:mcp:aikido-mcp'])
    expect(first.wroteState).toBe(true)

    // The recorded ids are what the command surface reads back.
    const recorded = JSON.parse(readFileSync(statePath, 'utf8')) as { installed: InstalledEntry[] }
    expect(recorded.installed[0]?.rowIds).toEqual(['marketplace:mcp:aikido-mcp'])
  })

  it('toggling the recorded id actually moves the row, and a recomputed id does not', () => {
    const installPath = pluginWithServer('aikido-mcp')
    const patchLayerPath = join(scratch, 'cordis.patch.yml')
    const statePath = join(scratch, 'state.json')
    const state = upsertInstalled(emptyState(), entryFor('aikido', installPath))
    sync(state, { patchLayerPath, materialize: { harnessHome: scratch }, statePath })
    const composed = sync(state, { patchLayerPath, materialize: { harnessHome: scratch }, statePath })

    // This is the bug, kept as a live assertion: the id a caller would compute
    // from the plugin name matches no row, so the toggle is a silent no-op.
    expect(setEnabled(patchLayerPath, rowIdFor('aikido'), false)).toBe(false)
    expect(readEnabled(parsePatchLayer(patchLayerPath).patches, 'marketplace:mcp:aikido-mcp')).toBe(true)

    // The recorded id addresses the row.
    const ownId = composed.rows[0]!.id
    expect(setEnabled(patchLayerPath, ownId, false)).toBe(true)
    expect(readEnabled(parsePatchLayer(patchLayerPath).patches, ownId)).toBe(false)

    expect(setEnabled(patchLayerPath, ownId, true)).toBe(true)
    expect(readEnabled(parsePatchLayer(patchLayerPath).patches, ownId)).toBe(true)
  })

  it('a re-sync leaves state alone once the ids are recorded', () => {
    const installPath = pluginWithServer('aikido-mcp')
    const patchLayerPath = join(scratch, 'cordis.patch.yml')
    const statePath = join(scratch, 'state.json')
    const state = upsertInstalled(emptyState(), entryFor('aikido', installPath))

    expect(sync(state, { patchLayerPath, materialize: { harnessHome: scratch }, statePath }).wroteState).toBe(true)
    const recorded = JSON.parse(readFileSync(statePath, 'utf8')) as { installed: InstalledEntry[] }
    // Syncing the ANNOTATED state must not rewrite it again, or every command
    // would re-serialize the file.
    const second = sync(
      { ...state, installed: recorded.installed },
      { patchLayerPath, materialize: { harnessHome: scratch }, statePath },
    )
    expect(second.wroteState).toBe(false)
  })

  it('a state entry with no recorded ids is materialized rather than guessed', () => {
    // The unannotated shape (state written by an older build): sync fills it in.
    const installPath = pluginWithServer('legacy-mcp')
    const patchLayerPath = join(scratch, 'cordis.patch.yml')
    const statePath = join(scratch, 'state.json')
    const state = upsertInstalled(emptyState(), entryFor('legacy', installPath))
    expect(state.installed[0]?.rowIds).toBeUndefined()

    const result = sync(state, { patchLayerPath, materialize: { harnessHome: scratch }, statePath })
    expect(result.rows.map(row => row.id)).toEqual(['marketplace:mcp:legacy-mcp'])
    expect(existsSync(patchLayerPath)).toBe(true)
  })
})

describe('capability reporting', () => {
  it('does not call an unmaterialized `commands/` directory a changed capability', () => {
    // `commands/` is detected but never materialized, so it contributes no row.
    // It was also missing from the on-disk comparison, which made every plugin
    // shipping one announce a change on every sync.
    const installPath = join(scratch, 'commands-plugin')
    mkdirSync(join(installPath, 'commands'), { recursive: true })
    const entry: InstalledEntry = { ...entryFor('cmd-plugin', installPath), capabilities: ['commands'] }

    const result = materializeEntry(entry, { harnessHome: scratch })
    expect(result.warnings).toEqual([])
    expect(result.rowIds).toEqual([])
  })

  it('still reports a capability that genuinely disappeared', () => {
    // The guard above must not be bought by weakening the real check.
    const installPath = join(scratch, 'gone-plugin')
    mkdirSync(installPath, { recursive: true })
    const entry: InstalledEntry = { ...entryFor('gone-plugin', installPath), capabilities: ['skills'] }

    const result = materializeEntry(entry, { harnessHome: scratch })
    expect(result.warnings.join(' ')).toContain('capabilities changed on disk since install')
  })
})

describe('marketplace-relative sources', () => {
  const officialManifest = 'https://github.com/anthropics/claude-plugins-official/raw/main/.claude-plugin/marketplace.json'

  it('derives a clone url from a manifest url, not a raw-content path', () => {
    // A raw url is not a repository, so appending `.git` would produce
    // `.../raw/main.git` — a host that does not exist.
    expect(marketplaceRepoRoot(officialManifest)).toBe('https://github.com/anthropics/claude-plugins-official.git')
    expect(marketplaceRepoRoot('https://github.com/obra/superpowers/raw/main/marketplace.json'))
      .toBe('https://github.com/obra/superpowers.git')
    expect(marketplaceRepoRoot('https://raw.githubusercontent.com/obra/superpowers/main/.claude-plugin/marketplace.json'))
      .toBe('https://github.com/obra/superpowers.git')
  })

  it('resolves a relative local source against the marketplace root', () => {
    // Measured: 52 of the 294 official entries use this form.
    expect(resolveLocalSource('./plugins/commit-commands', marketplaceRepoRoot(officialManifest))).toEqual({
      kind: 'git',
      url: 'https://github.com/anthropics/claude-plugins-official.git',
      subdirectory: 'plugins/commit-commands',
    })
  })

  it('refuses to resolve rather than guessing', () => {
    // No derivable root, an escaping path, and a host with no rule: each must
    // return undefined instead of naming a repository that might be unrelated.
    expect(marketplaceRepoRoot('https://example.test/some/thing.json')).toBeUndefined()
    expect(resolveLocalSource('./plugins/x', undefined)).toBeUndefined()
    expect(resolveLocalSource('../../etc', 'https://github.com/o/r.git')).toBeUndefined()
  })
})
