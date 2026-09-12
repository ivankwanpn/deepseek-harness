/**
 * Each install refusal names itself structurally.
 *
 * The reason exists so the Remote face can map a refusal to a stable code
 * without reading English. These tests are therefore about the FIELD, not the
 * message: a reworded message must not be able to change a wire-visible code.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstallError, installPlugin, pluginInstallPath } from '../src/install.ts'
import { emptyState, upsertMarketplace } from '../src/state.ts'
import type { SyncOptions } from '../src/sync.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-install-reasons-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  rmSync(scratch, { recursive: true, force: true })
})

/** The sync configuration an install reconciles with, pointed at the scratch home. */
function syncOptions(): SyncOptions {
  return {
    patchLayerPath: join(scratch, 'cordis.patch.yml'),
    materialize: { harnessHome: scratch },
    statePath: join(scratch, 'marketplace', 'state.json'),
  }
}

/** Run one call that must refuse, returning the refusal. */
async function refusalOf(run: () => Promise<unknown>): Promise<InstallError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof InstallError) return error
    throw error
  }
  throw new Error('expected the call to refuse, but it resolved')
}

/** Serve one marketplace manifest to every fetch. */
function serveMarketplace(plugins: readonly object[]): void {
  vi.stubGlobal('fetch', async () => new Response(
    JSON.stringify({ name: 'test', plugins }),
    { status: 200 },
  ))
}

describe('install refusals carry a structural reason', () => {
  it('names a plugin name with no usable characters', () => {
    let caught: unknown
    try {
      pluginInstallPath(scratch, '...')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(InstallError)
    expect((caught as InstallError).reason).toBe('name-unusable')
  })

  it('names an empty registry', async () => {
    const error = await refusalOf(() => installPlugin('anything', {
      state: emptyState(),
      statePath: join(scratch, 'marketplace', 'state.json'),
      sync: syncOptions(),
    }))
    expect(error.reason).toBe('no-marketplace')
  })

  it('names a plugin no registered marketplace lists', async () => {
    serveMarketplace([{ name: 'present', source: { source: 'git', url: 'https://example.test/a.git', sha: 'a'.repeat(40) } }])
    const state = upsertMarketplace(emptyState(), 'test', 'https://example.test/marketplace.json')
    const error = await refusalOf(() => installPlugin('absent', {
      state,
      statePath: join(scratch, 'marketplace', 'state.json'),
      sync: syncOptions(),
    }))
    expect(error.reason).toBe('not-found')
  })

  it('names an unpinned git source', async () => {
    serveMarketplace([{ name: 'loose', source: { source: 'git', url: 'https://example.test/loose.git' } }])
    const state = upsertMarketplace(emptyState(), 'test', 'https://example.test/marketplace.json')
    const error = await refusalOf(() => installPlugin('loose', {
      state,
      statePath: join(scratch, 'marketplace', 'state.json'),
      sync: syncOptions(),
    }))
    expect(error.reason).toBe('unpinned')
  })
})
