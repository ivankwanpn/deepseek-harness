/**
 * The pin opt-in turns an unpinned source into a recorded commit.
 *
 * Refusing an unpinned source is the default, and the opt-in replaces that
 * refusal with one specific revision: the declared ref is resolved, the fetch is
 * pinned to the commit it named, and that commit is what the state file records.
 * The two network steps — the ref resolution and the clone — are the only stubs;
 * the pin rule, the staging move, the state write and the reconcile are the real
 * ones, so what this pins is the install's own handling of a resolved commit.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPlugin, type InstallOptions } from '../src/install.ts'
import type { PluginSource } from '../src/parse.ts'
import { emptyState, loadState, upsertMarketplace } from '../src/state.ts'
import type { SyncOptions } from '../src/sync.ts'

/** The commit the stubbed resolution names for the entry's ref. */
const RESOLVED_SHA = 'c'.repeat(40)
const URL = 'https://example.test/loose.git'
const REF = 'v1.2.3'
const MANIFEST = 'https://example.test/marketplace.json'

const resolveRefSha = vi.hoisted(() => vi.fn<(url: string, ref?: string) => Promise<string>>())

vi.mock('../src/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.ts')>()
  return {
    ...actual,
    fetchPlugin: async (source: PluginSource, destination: string) => {
      mkdirSync(join(destination, 'commands'), { recursive: true })
      return {
        root: destination,
        capabilities: actual.detectCapabilities(destination),
        // What a real fetch of a pinned commit reports: the commit it checked out.
        resolvedSha: source.kind === 'git' ? (source.sha ?? '') : '',
      }
    },
    resolveRefSha,
  }
})

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-install-unpinned-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  resolveRefSha.mockReset()
  rmSync(scratch, { recursive: true, force: true })
})

/** The scratch state file the install reads and writes. */
function statePath(): string {
  return join(scratch, 'marketplace', 'state.json')
}

/** Install options for one call against the scratch harness home. */
function installOptions(): InstallOptions {
  const sync: SyncOptions = {
    patchLayerPath: join(scratch, 'cordis.patch.yml'),
    materialize: { harnessHome: scratch },
    statePath: statePath(),
  }
  return { state: upsertMarketplace(emptyState(), 'test', MANIFEST), statePath: statePath(), sync }
}

/** Serve one marketplace manifest to every fetch. */
function serveMarketplace(plugins: readonly object[]): void {
  vi.stubGlobal('fetch', async () => new Response(
    JSON.stringify({ name: 'test', plugins }),
    { status: 200 },
  ))
}

describe('the unpinned install opt-in', () => {
  it('resolves the declared ref, installs that commit, and records it', async () => {
    serveMarketplace([{ name: 'loose', source: { source: 'git', url: URL, ref: REF } }])

    // The default arm refuses before it asks any remote anything.
    await expect(installPlugin('loose', installOptions())).rejects.toMatchObject({ reason: 'unpinned' })
    expect(resolveRefSha).not.toHaveBeenCalled()
    expect(existsSync(statePath())).toBe(false)

    resolveRefSha.mockResolvedValue(RESOLVED_SHA)
    const result = await installPlugin('loose', { ...installOptions(), allowUnpinned: true })

    // The entry declares a ref rather than a commit, so that ref is what was
    // resolved; the commit that came back is what the install recorded, both on
    // the result and in the durable state the panel reads back.
    expect(resolveRefSha).toHaveBeenCalledWith(URL, REF)
    expect(result.entry).toMatchObject({
      plugin: 'loose',
      sha: RESOLVED_SHA,
      sourceUrl: URL,
      capabilities: ['commands'],
    })
    expect(existsSync(result.entry.installPath)).toBe(true)
    expect(loadState(statePath()).installed[0]).toMatchObject({ plugin: 'loose', sha: RESOLVED_SHA })
  })
})
