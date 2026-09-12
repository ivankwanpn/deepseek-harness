/**
 * The CLI search command, driven through `runMarketplace`.
 *
 * Its output format is what a user reads, and its containment is the defect
 * this change fixes: one unreachable registration used to abort the whole
 * command and hide every result from the registrations that answered.
 *
 * DSH_HOME is redirected for every case. `runMarketplace` resolves the real
 * harness home, so without this the suite would register marketplaces in the
 * user's own `~/.dsh/marketplace/state.json`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMarketplace } from '../src/marketplace-command.ts'

const PINNED = { source: 'git', url: 'https://example.test/pinned.git', sha: 'a'.repeat(40) }
const OFFICIAL = 'https://example.test/official/marketplace.json'
const EXTRA = 'https://example.test/extra/marketplace.json'

let scratch: string
let previousHome: string | undefined
let stderr: string[]

/** Capture everything the command writes to stdout. */
function captureStdout(): { read: () => string } {
  const chunks: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    chunks.push(String(chunk))
    return true
  })
  return { read: () => chunks.join('') }
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-search-'))
  previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = scratch
  // Collected rather than discarded: a registration the command cannot read is
  // reported on stderr, and that report is what the containment case reads. The
  // collection also keeps the suite from writing to the real stderr.
  stderr = []
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk))
    return true
  })
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  rmSync(scratch, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('marketplace search', () => {
  it('moves the filtering and the formatting onto the catalog rows', async () => {
    const stdout = captureStdout()
    // The stub goes in BEFORE the first command: `add` fetches the manifest
    // itself, so stubbing afterwards would send `add` to the real network,
    // fail, register nothing, and make `search` report an empty registry.
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({
      name: 'official',
      plugins: [
        { name: 'commit-helper', description: 'commit flow', source: PINNED },
        { name: 'deploy', description: 'deploy flow', source: PINNED },
      ],
    }), { status: 200 }))
    await runMarketplace(['add', OFFICIAL])

    expect(await runMarketplace(['search', 'deploy'])).toBe(0)
    const output = stdout.read()
    expect(output).toContain('deploy')
    expect(output).toContain('    deploy flow')
    expect(output).not.toContain('commit-helper')
  })

  it('reports what one unreachable registration cost instead of hiding the rest', async () => {
    const stdout = captureStdout()
    // An unreachable url cannot be registered at all — `add` fetches a manifest
    // before it records one — so the extra marketplace answers here and goes
    // unreachable afterwards, which is how a registered marketplace actually
    // becomes unreadable.
    let extraReachable = true
    vi.stubGlobal('fetch', async (input: string | URL) => {
      if (String(input) === EXTRA) {
        if (!extraReachable) throw new TypeError('connection refused')
        // Named `extra`, not `official`: `add` keys a registration by the
        // manifest's own name, so a second manifest named `official` would
        // re-point the first registration instead of adding one.
        return new Response(JSON.stringify({ name: 'extra', plugins: [] }), { status: 200 })
      }
      return new Response(JSON.stringify({
        name: 'official',
        plugins: [{ name: 'deploy', description: 'deploy flow', source: PINNED }],
      }), { status: 200 })
    })
    // EXTRA is registered FIRST so the unreachable registration is visited
    // first: with the readable one first, an implementation that printed what it
    // already had and then stopped at the failure would stay green.
    await runMarketplace(['add', EXTRA])
    await runMarketplace(['add', OFFICIAL])
    extraReachable = false

    expect(await runMarketplace(['search', ''])).toBe(0)
    const output = stdout.read()
    expect(output).toContain('deploy')
    expect(stderr.join('')).toContain('connection refused')
  })
})
