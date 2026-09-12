/**
 * The catalog read: one row per entry across every registration.
 *
 * The containment case is the reason this operation exists rather than the CLI
 * loop it replaces — one unreachable registration used to blank the whole
 * result. Every fetch here is stubbed, so the suite never touches the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { catalog } from '../src/catalog.ts'
import { emptyState, rowIdFor, upsertInstalled, upsertMarketplace, type InstalledEntry } from '../src/state.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const PINNED = { source: 'git', url: 'https://example.test/pinned.git', sha: 'a'.repeat(40) }
const LOOSE = { source: 'git', url: 'https://example.test/loose.git' }

/** One registered marketplace whose manifest is served from a map by url. */
function registrations(...specs: readonly (readonly [string, string])[]) {
  let state = emptyState()
  for (const [name, url] of specs) state = upsertMarketplace(state, name, url)
  return state
}

/** Route fetch by url; a url absent from the map fails the way an outage does. */
function serve(byUrl: Readonly<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input)
    const body = byUrl[url]
    if (body === undefined) throw new TypeError('connection refused')
    return new Response(JSON.stringify(body), { status: 200 })
  })
}

const OFFICIAL = 'https://example.test/official/marketplace.json'
const EXTRA = 'https://example.test/extra/marketplace.json'

describe('catalog', () => {
  it('returns one row per entry, with installability decided here', async () => {
    serve({
      [OFFICIAL]: {
        name: 'official',
        plugins: [
          { name: 'pinned', description: 'pinned one', category: 'tools', version: '1.2.3', tags: ['a', 'b'], source: PINNED },
          { name: 'loose', description: 'loose one', source: LOOSE },
        ],
      },
    })
    const result = await catalog(registrations(['official', OFFICIAL]))

    expect(result.failed).toEqual([])
    expect(result.rows).toEqual([
      {
        plugin: 'pinned',
        marketplace: 'official',
        description: 'pinned one',
        category: 'tools',
        version: '1.2.3',
        tags: ['a', 'b'],
        installable: true,
        installed: false,
        warnings: [],
      },
      {
        plugin: 'loose',
        marketplace: 'official',
        description: 'loose one',
        tags: [],
        installable: false,
        installed: false,
        warnings: ['git source has no sha pin'],
      },
    ])
  })

  it('marks an entry that already has an installed record', async () => {
    serve({ [OFFICIAL]: { name: 'official', plugins: [{ name: 'pinned', source: PINNED }] } })
    const entry: InstalledEntry = {
      id: rowIdFor('pinned'),
      marketplace: 'official',
      plugin: 'pinned',
      sourceUrl: 'https://example.test/pinned.git',
      installPath: '/tmp/pinned',
      capabilities: [],
      installedAt: new Date(0).toISOString(),
    }
    const state = upsertInstalled(registrations(['official', OFFICIAL]), entry)

    const result = await catalog(state)
    expect(result.rows[0]?.installed).toBe(true)
  })

  it('contains one unreachable registration instead of failing the read', async () => {
    serve({ [OFFICIAL]: { name: 'official', plugins: [{ name: 'pinned', source: PINNED }] } })
    const result = await catalog(registrations(['official', OFFICIAL], ['extra', EXTRA]))

    expect(result.rows.map(row => row.plugin)).toEqual(['pinned'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.marketplace).toBe('extra')
    expect(result.failed[0]?.reason).toContain('connection refused')
  })

  it('resolves empty for a deployment with no registration', async () => {
    await expect(catalog(emptyState())).resolves.toEqual({ rows: [], failed: [] })
  })

  it('keeps registration order across marketplaces', async () => {
    serve({
      [OFFICIAL]: { name: 'official', plugins: [{ name: 'one', source: PINNED }] },
      [EXTRA]: { name: 'extra', plugins: [{ name: 'two', source: PINNED }] },
    })
    const result = await catalog(registrations(['official', OFFICIAL], ['extra', EXTRA]))
    expect(result.rows.map(row => `${row.marketplace}/${row.plugin}`)).toEqual(['official/one', 'extra/two'])
  })
})
