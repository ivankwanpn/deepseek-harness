/**
 * The package entry point (`src/index.ts`) is the surface an out-of-tree
 * consumer compiles against: the README's own example imports from
 * `@deepseek-ai/dsh-host-plugin-marketplace`, so a name that disappears from
 * this barrel is a breaking change even when the module that defines it is
 * intact.
 *
 * Two things are pinned. First the export list itself, because a barrel's whole
 * behaviour is which names it publishes. Second a full cycle driven ONLY through
 * those re-exports — sync, enable, disable, uninstall — against a real harness
 * home, so the entry is proven wired to the implementations rather than to a
 * private copy of them. Nothing here is stubbed: no network, no git, no
 * filesystem fixtures beyond the ordinary temp directory.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as entry from '../src/index.ts'

/** Every runtime export the package entry publishes, in sorted order. */
const EXPECTED_SURFACE = [
  'DISABLED_SKILLS_DIRNAME',
  'DEFAULT_FETCH_TIMEOUT_MS',
  'InstallError',
  'MARKETPLACE_STATE_VERSION',
  'MAX_MANIFEST_BYTES',
  'MCP_CLIENT_MODULE',
  'MarketplaceFetchError',
  'MarketplaceParseError',
  'MarketplaceStateError',
  'PatchLayerError',
  'PluginFetchError',
  'addMarketplace',
  'catalog',
  'candidateManifestUrls',
  'composePatchLayer',
  'defaultAgentsSkillsDir',
  'defaultStatePath',
  'detectCapabilities',
  'disabledSkillsDir',
  'emptyState',
  'fetchMarketplace',
  'fetchMarketplaceFrom',
  'fetchPlugin',
  'findInstalled',
  'installPlugin',
  'installSource',
  'isPinned',
  'loadState',
  'looksLikeManifestUrl',
  'marketplaceRepoRoot',
  'materializeEntry',
  'materializeSkills',
  'normalizeMcpServers',
  'ownedBy',
  'parseEntry',
  'parseMarketplace',
  'parsePatchLayer',
  'parseSource',
  'pluginInstallPath',
  'presentIds',
  'readEnabled',
  'readPluginMcp',
  'removeInstalled',
  'removeMaterializedSkills',
  'removePluginSkills',
  'resolveEntry',
  'resolveLocalSource',
  'resolveRefSha',
  'rowIdFor',
  'sanitizeServerName',
  'saveState',
  'serializePatchLayer',
  'setEnabled',
  'setPluginEnabled',
  'setSkillsEnabled',
  'skillEntryNames',
  'skillsEnabled',
  'skillsRootDir',
  'sync',
  'uninstallPlugin',
  'upsertInstalled',
  'upsertMarketplace',
  'writePatchLayerIfChanged',
].sort()

let scratch: string
let previousAgentsHome: string | undefined

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-plugin-entry-'))
  previousAgentsHome = process.env.DSH_AGENTS_HOME
  delete process.env.DSH_AGENTS_HOME
})

afterEach(() => {
  if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = previousAgentsHome
  rmSync(scratch, { recursive: true, force: true })
})

describe('the package entry', () => {
  it('publishes every documented export, and nothing else', () => {
    expect(Object.keys(entry).sort()).toEqual(EXPECTED_SURFACE)
  })

  it('drives an install, a toggle and an uninstall through its own re-exports', () => {
    const materialize = { harnessHome: scratch, agentsSkillsDir: join(scratch, '.agents', 'skills') }
    const patchLayerPath = join(scratch, 'cordis.patch.yml')
    const statePath = entry.defaultStatePath(scratch)

    // Real content: one discoverable skill and one MCP server.
    const installPath = join(scratch, 'plugins', 'demo')
    mkdirSync(join(installPath, 'skills', 'demo-skill'), { recursive: true })
    writeFileSync(
      join(installPath, 'skills', 'demo-skill', 'SKILL.md'),
      '---\nname: demo-skill\ndescription: Entry fixture.\n---\n\nBody.\n',
      'utf8',
    )
    writeFileSync(
      join(installPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { 'demo-mcp': { command: 'npx', args: ['-y', 'thing'] } } }),
      'utf8',
    )
    entry.saveState(statePath, entry.upsertInstalled(entry.emptyState(), {
      id: entry.rowIdFor('demo'),
      marketplace: 'official',
      plugin: 'demo',
      sourceUrl: 'https://example.test/demo.git',
      installPath,
      capabilities: ['skills', 'mcp'],
      installedAt: new Date(0).toISOString(),
    }))

    const synced = entry.sync(entry.loadState(statePath), { patchLayerPath, materialize, statePath })
    expect(synced.rows.map(row => row.id)).toEqual(['marketplace:mcp:demo-mcp'])
    // The resolved ownership is recorded back, which is what enablement and
    // uninstall address later.
    expect(synced.wroteState).toBe(true)
    const installed = entry.loadState(statePath).installed[0]!
    expect(installed.rowIds).toEqual(['marketplace:mcp:demo-mcp'])
    expect(installed.skillIds).toEqual(['demo-skill'])
    // Skills are materialized FLAT into the discovery root, the only depth the
    // filesystem provider reads.
    expect(readdirSync(materialize.agentsSkillsDir)).toEqual(['demo-skill'])
    expect(entry.readEnabled(entry.parsePatchLayer(patchLayerPath).patches, 'marketplace:mcp:demo-mcp')).toBe(true)

    // One verb, two mechanisms: the row's flag AND the skill's placement.
    const off = entry.setPluginEnabled(installed, false, { patchLayerPath, materialize })
    expect(off).toEqual({ rowsChanged: 1, skillsMoved: true, alreadyInState: false, mountsNothing: false })
    expect(entry.readEnabled(entry.parsePatchLayer(patchLayerPath).patches, 'marketplace:mcp:demo-mcp')).toBe(false)
    expect(existsSync(join(materialize.agentsSkillsDir, 'demo-skill'))).toBe(false)
    expect(existsSync(join(entry.disabledSkillsDir(materialize, 'demo'), 'demo-skill'))).toBe(true)

    const on = entry.setPluginEnabled(entry.loadState(statePath).installed[0]!, true, { patchLayerPath, materialize })
    expect(on).toMatchObject({ rowsChanged: 1, skillsMoved: true })
    expect(existsSync(join(materialize.agentsSkillsDir, 'demo-skill'))).toBe(true)

    const { removed } = entry.uninstallPlugin(entry.loadState(statePath), 'demo', {
      statePath,
      sync: { patchLayerPath, materialize },
    })
    expect(removed).toBe(true)
    expect(entry.loadState(statePath).installed).toEqual([])
    expect(existsSync(installPath)).toBe(false)
    expect(existsSync(join(materialize.agentsSkillsDir, 'demo-skill'))).toBe(false)
    expect(existsSync(entry.disabledSkillsDir(materialize, 'demo'))).toBe(false)
  })
})
