/**
 * The on-disk marketplace state record: load, save, and the four updaters.
 *
 * Pins the read path's central promise — a missing file is a normal first run
 * while an unreadable or untrustworthy one throws — because degrading a corrupt
 * record to an empty state would orphan every patch-layer row the marketplace
 * owns. The updaters are pinned as pure copies in stored order: re-installing
 * rewrites one record in place, and removing an id that is not there is a no-op
 * rather than an error. Each case writes and re-reads real bytes under a private
 * temp root.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  defaultStatePath,
  emptyState,
  findInstalled,
  loadState,
  MARKETPLACE_STATE_VERSION,
  MarketplaceStateError,
  removeInstalled,
  rowIdFor,
  saveState,
  upsertInstalled,
  upsertMarketplace,
  type InstalledEntry,
  type MarketplaceState,
} from '../src/state.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-state-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The state file this case reads and writes. */
function statePath(): string {
  return join(scratch, 'marketplace', 'state.json')
}

/**
 * Write a raw document to a path, creating its parent directory.
 *
 * @param path - the file to write.
 * @param content - the exact bytes, so a case can write invalid JSON.
 */
function writeRaw(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

/**
 * Write one document as the state file.
 *
 * @param document - the value to serialize; anything JSON can express, including
 * a value `loadState` must reject.
 */
function writeStateDocument(document: unknown): void {
  writeRaw(statePath(), JSON.stringify(document))
}

/** A complete installed record, with optional fields so a case can trim it. */
function entry(overrides: Partial<InstalledEntry> = {}): InstalledEntry {
  return {
    id: rowIdFor('aikido'),
    marketplace: 'official',
    plugin: 'aikido',
    sourceUrl: 'https://example.test/aikido.git',
    installPath: join(scratch, 'plugins', 'aikido'),
    capabilities: ['skills'],
    installedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('state paths and the empty document', () => {
  it('places the state under the harness home', () => {
    expect(defaultStatePath('C:/dsh/home')).toBe(join('C:/dsh/home', 'marketplace', 'state.json'))
  })

  it('describes a harness that has never installed anything', () => {
    expect(emptyState()).toEqual({ version: MARKETPLACE_STATE_VERSION, marketplaces: [], installed: [] })
  })
})

describe('saveState and loadState round trip', () => {
  it('writes readable JSON and reads every recorded field back', () => {
    const state: MarketplaceState = {
      version: MARKETPLACE_STATE_VERSION,
      marketplaces: [{ name: 'official', url: 'https://example.test/marketplace.json' }],
      installed: [entry({
        sha: 'b'.repeat(40),
        subdirectory: 'plugins/aikido',
        repoUrl: 'https://example.test/registry.git',
        rowIds: ['marketplace:mcp:aikido'],
        skillIds: ['audit'],
        capabilities: ['skills', 'commands', 'mcp'],
      })],
    }

    saveState(statePath(), state)

    // The file on disk is what the next process reads, so assert its bytes: the
    // document is pretty-printed and newline-terminated, and the atomic-write
    // temporary file is gone.
    expect(readFileSync(statePath(), 'utf8')).toBe(`${JSON.stringify(state, null, 2)}\n`)
    expect(readdirSync(join(scratch, 'marketplace'))).toEqual(['state.json'])
    expect(loadState(statePath())).toEqual(state)
  })

  it('creates the parent directories of a state file that does not exist yet', () => {
    saveState(join(scratch, 'deep', 'nested', 'state.json'), emptyState())
    expect(loadState(join(scratch, 'deep', 'nested', 'state.json'))).toEqual(emptyState())
  })

  it('treats a missing file as a first run rather than a failure', () => {
    expect(loadState(statePath())).toEqual(emptyState())
    expect(existsSync(statePath())).toBe(false)
  })

  it('refuses a state path it cannot read instead of reporting nothing installed', () => {
    // A directory is the portable unreadable path: reading it fails on every
    // platform, and it is not the ENOENT that means "first run".
    mkdirSync(statePath(), { recursive: true })
    let thrown: unknown
    try {
      loadState(statePath())
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(MarketplaceStateError)
    expect((thrown as MarketplaceStateError).message).toBe(`cannot read marketplace state ${statePath()}`)
    expect((thrown as MarketplaceStateError).cause).toBeInstanceOf(Error)
  })
})

describe('loadState refuses an untrustworthy document', () => {
  it('refuses a file that is not JSON, naming it', () => {
    writeRaw(statePath(), '{ not json')
    expect(() => loadState(statePath())).toThrow(new MarketplaceStateError(`marketplace state ${statePath()} is not valid JSON`))
  })

  it('refuses a document that is not an object', () => {
    for (const document of [[], 'state', 7, null]) {
      writeStateDocument(document)
      expect(() => loadState(statePath())).toThrow(new MarketplaceStateError(`marketplace state ${statePath()} is not an object`))
    }
  })

  it('refuses a document with no usable version', () => {
    for (const version of [undefined, '1', null]) {
      writeStateDocument({ version, marketplaces: [], installed: [] })
      expect(() => loadState(statePath())).toThrow(new MarketplaceStateError(`marketplace state ${statePath()} has no version`))
    }
  })

  it('refuses a version written by a newer build rather than dropping its fields', () => {
    writeStateDocument({ version: MARKETPLACE_STATE_VERSION + 1, marketplaces: [], installed: [] })
    expect(() => loadState(statePath())).toThrow(new MarketplaceStateError(
      `marketplace state ${statePath()} is version ${MARKETPLACE_STATE_VERSION + 1}, newer than this build understands (${MARKETPLACE_STATE_VERSION})`,
    ))
  })

  it('refuses two installed records claiming the same id', () => {
    writeStateDocument({ version: 1, marketplaces: [], installed: [entry(), entry({ plugin: 'other' })] })
    expect(() => loadState(statePath())).toThrow(new MarketplaceStateError(
      `marketplace state ${statePath()} lists id ${rowIdFor('aikido')} twice`,
    ))
  })

  it('refuses an installed record that is not an object', () => {
    writeStateDocument({ version: 1, marketplaces: [], installed: ['aikido'] })
    expect(() => loadState(statePath())).toThrow(new MarketplaceStateError('installed[0] is not an object'))
  })

  it('names the required field an installed record is missing', () => {
    for (const field of ['id', 'marketplace', 'plugin', 'sourceUrl', 'installPath', 'installedAt']) {
      const broken: Record<string, unknown> = Object.fromEntries(
        Object.entries(entry()).filter(([key]) => key !== field),
      )
      writeStateDocument({ version: 1, marketplaces: [], installed: [broken] })
      expect(() => loadState(statePath())).toThrow(new MarketplaceStateError(`installed[0] is missing ${field}`))

      // An empty string is as unusable as an absent field: it cannot address a
      // patch row or an install directory.
      writeStateDocument({ version: 1, marketplaces: [], installed: [{ ...entry(), [field]: '' }] })
      expect(() => loadState(statePath())).toThrow(new MarketplaceStateError(`installed[0] is missing ${field}`))
    }
  })
})

describe('loadState sanitizes what it accepts', () => {
  it('drops registrations that cannot name a marketplace or a url', () => {
    writeStateDocument({
      version: 1,
      marketplaces: [
        { name: 'official', url: 'https://example.test/marketplace.json' },
        'nope',
        { name: 'no-url' },
        { url: 'https://example.test/other.json' },
        { name: '', url: 'https://example.test/empty.json' },
      ],
      installed: [],
    })
    expect(loadState(statePath()).marketplaces).toEqual([
      { name: 'official', url: 'https://example.test/marketplace.json' },
    ])
  })

  it('reads absent or non-array collections as empty', () => {
    writeStateDocument({ version: 1, marketplaces: 'nope', installed: 'nope' })
    expect(loadState(statePath())).toEqual({ version: 1, marketplaces: [], installed: [] })
    writeStateDocument({ version: 1 })
    expect(loadState(statePath())).toEqual({ version: 1, marketplaces: [], installed: [] })
  })

  it('filters capabilities to the ones this package can mount', () => {
    const withCapabilities = (capabilities: unknown): Record<string, unknown> => ({ ...entry(), capabilities })

    writeStateDocument({ version: 1, marketplaces: [], installed: [withCapabilities(['skills', 'teleport', 7, 'mcp'])] })
    expect(loadState(statePath()).installed[0]?.capabilities).toEqual(['skills', 'mcp'])

    writeStateDocument({ version: 1, marketplaces: [], installed: [withCapabilities('skills')] })
    expect(loadState(statePath()).installed[0]?.capabilities).toEqual([])
  })

  it('drops recorded row and skill ids that cannot address an entry', () => {
    writeStateDocument({
      version: 1,
      marketplaces: [],
      installed: [{
        ...entry(),
        rowIds: ['marketplace:mcp:aikido', '', 7, null],
        skillIds: ['audit', ''],
      }],
    })
    const loaded = loadState(statePath()).installed[0]
    expect(loaded?.rowIds).toEqual(['marketplace:mcp:aikido'])
    expect(loaded?.skillIds).toEqual(['audit'])
  })

  it('keeps empty id lists distinct from absent ones', () => {
    writeStateDocument({
      version: 1,
      marketplaces: [],
      installed: [{ ...entry(), rowIds: [], skillIds: [] }],
    })
    const loaded = loadState(statePath()).installed[0]
    expect(loaded?.rowIds).toEqual([])
    expect(loaded?.skillIds).toEqual([])
  })

  it('omits absent optional fields instead of writing empty strings', () => {
    writeStateDocument({ version: 1, marketplaces: [], installed: [entry()] })
    const loaded = loadState(statePath()).installed[0]
    expect(loaded).toEqual(entry())
    expect(loaded !== undefined && 'sha' in loaded).toBe(false)
    expect(loaded !== undefined && 'subdirectory' in loaded).toBe(false)
    expect(loaded !== undefined && 'repoUrl' in loaded).toBe(false)
    expect(loaded !== undefined && 'rowIds' in loaded).toBe(false)
    expect(loaded !== undefined && 'skillIds' in loaded).toBe(false)
  })
})

describe('the state updaters', () => {
  it('appends a new installed record and replaces an existing one in place', () => {
    const first = entry({ plugin: 'first', id: rowIdFor('first') })
    const second = entry({ plugin: 'second', id: rowIdFor('second') })
    const start: MarketplaceState = { ...emptyState(), installed: [first, second] }

    const appended = upsertInstalled(start, entry({ plugin: 'third', id: rowIdFor('third') }))
    expect(appended.installed.map(item => item.plugin)).toEqual(['first', 'second', 'third'])
    // The argument is a value, not a slot: the caller's state is untouched.
    expect(start.installed.map(item => item.plugin)).toEqual(['first', 'second'])

    const replaced = upsertInstalled(start, entry({ plugin: 'second', id: rowIdFor('second'), sha: 'c'.repeat(40) }))
    expect(replaced.installed.map(item => item.plugin)).toEqual(['first', 'second'])
    expect(replaced.installed[1]?.sha).toBe('c'.repeat(40))
    expect(replaced.version).toBe(start.version)
  })

  it('removes one installed record and ignores an absent id', () => {
    const start: MarketplaceState = { ...emptyState(), installed: [entry({ id: 'a' }), entry({ id: 'b' })] }
    expect(removeInstalled(start, 'a').installed.map(item => item.id)).toEqual(['b'])
    expect(removeInstalled(start, 'missing').installed.map(item => item.id)).toEqual(['a', 'b'])
    expect(start.installed.map(item => item.id)).toEqual(['a', 'b'])
  })

  it('re-points a same-named registration to the end of the list', () => {
    const start = upsertMarketplace(upsertMarketplace(emptyState(), 'official', 'https://one.test/m.json'), 'vendor', 'https://two.test/m.json')
    expect(start.marketplaces.map(m => m.name)).toEqual(['official', 'vendor'])

    const repointed = upsertMarketplace(start, 'official', 'https://three.test/m.json')
    expect(repointed.marketplaces).toEqual([
      { name: 'vendor', url: 'https://two.test/m.json' },
      { name: 'official', url: 'https://three.test/m.json' },
    ])
    expect(start.marketplaces[0]?.url).toBe('https://one.test/m.json')
  })

  it('finds an installed record by id', () => {
    const state: MarketplaceState = { ...emptyState(), installed: [entry({ id: 'a' })] }
    expect(findInstalled(state, 'a')?.id).toBe('a')
    expect(findInstalled(state, 'b')).toBeUndefined()
  })

  it('namespaces the patch-layer row id', () => {
    expect(rowIdFor('aikido')).toBe('marketplace:aikido')
  })
})
