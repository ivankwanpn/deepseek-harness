/**
 * REAL-composition coverage: a test-only cordis.yml booted through the vendored
 * Loader mounts the marketplace row, and every assertion observes the Remote
 * surface of the service the Loader actually composed — its config schema, its
 * namespace, and the methods it publishes — rather than a hand-built context.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import MarketplaceGateway from '../src/gateway.ts'
import { emptyState, saveState, upsertMarketplace } from '../src/state.ts'

const SPECIFIER = '@deepseek-ai/dsh-host-plugin-marketplace/gateway'
const MANIFEST = 'https://example.test/marketplace.json'
const PINNED = { source: 'git', url: 'https://example.test/pinned.git', sha: 'a'.repeat(40) }

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a cordis.yml with one marketplace row, then boot it through the real Loader. */
async function loadComposition(allowMutations = true): Promise<MarketplaceGateway> {
  root = await mkdtemp(join(tmpdir(), 'dsh-marketplace-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    `- name: '${SPECIFIER}'`,
    '  config:',
    `    harnessHome: ${JSON.stringify(root)}`,
    `    statePath: ${JSON.stringify(join(root, 'marketplace', 'state.json'))}`,
    `    patchLayerPath: ${JSON.stringify(join(root, 'cordis.patch.yml'))}`,
    ...(allowMutations ? [] : ['    allowMutations: false']),
    '',
  ].join('\n'))

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
  return context.get('marketplace') as MarketplaceGateway
}

/** Register one marketplace and serve its manifest. */
async function register(plugins: readonly object[]): Promise<void> {
  await mkdir(join(root!, 'marketplace'), { recursive: true })
  saveState(join(root!, 'marketplace', 'state.json'), upsertMarketplace(emptyState(), 'test', MANIFEST))
  vi.stubGlobal('fetch', async () => new Response(
    JSON.stringify({ name: 'test', plugins }),
    { status: 200 },
  ))
}

describe('marketplace composition through the Loader', () => {
  it('publishes the namespace and the five methods', async () => {
    const gateway = await loadComposition()
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'marketplace', namespace: 'marketplace' })
    // Method NAMES as a set: the property is which operations the composed
    // service publishes. Asserting the whole descriptors would couple this to
    // the invocation kind and the iteration order, neither of which any
    // requirement here depends on.
    expect(remoteMethods(gateway).map(entry => entry.method).sort()).toEqual([
      'catalog',
      'install',
      'setEnabled',
      'status',
      'uninstall',
    ])
  })

  it('reads the state file the row configured, not a default home', async () => {
    const gateway = await loadComposition()
    await register([{ name: 'pinned', description: 'from the composed row', source: PINNED }])

    const view = await gateway.catalog()
    expect(view.rows.map(row => row.plugin)).toEqual(['pinned'])
    // The status read proves the composed config reached the service: nothing
    // was installed, so the installed list is empty but the registration shows.
    await expect(gateway.status()).resolves.toMatchObject({
      marketplaces: [{ name: 'test', url: MANIFEST }],
      installed: [],
    })
  })

  it('refuses a write on the read-only row the config declared', async () => {
    const gateway = await loadComposition(false)
    await register([{ name: 'pinned', source: PINNED }])
    await expect(gateway.install({ plugin: 'pinned' })).rejects.toMatchObject({ code: 'marketplace/read-only' })
    // Browsing is a read, so the same row still answers the catalog.
    await expect(gateway.catalog()).resolves.toMatchObject({ rows: [{ plugin: 'pinned' }] })
  })
})
