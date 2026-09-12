# Marketplace Catalog and Install Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the marketplace settings panel browse what a registered marketplace offers and install from it, without the CLI becoming a second implementation of either operation.

**Architecture:** One `catalog()` operation reads every registered marketplace and returns rows carrying the Host's own installability verdict; the CLI's `search` and a new `marketplace.catalog` Remote method both call it. A new `marketplace.install` Remote method calls the existing `installPlugin`, returns the post-install status the panel renders, and maps each refusal to a stable code through a new structural `reason` on `InstallError`. The panel gains a third section that loads the catalog on request, filters it in the browser, and gates an unpinned entry behind an acknowledgement checkbox.

**Tech Stack:** TypeScript (strict, ESM, `.ts` on relative imports), Cordis plugin services and effects, Typert `@Remote` generated client face, React 18 + CSS Modules, Vitest (node environment, `// @vitest-environment jsdom` pragma per file where needed).

**Spec:** [`.agents/notes/proposed/feature/2026-09-12-marketplace-catalog-and-install.md`](.agents/notes/proposed/feature/2026-09-12-marketplace-catalog-and-install.md)

## Global Constraints

- **One implementation per operation.** The CLI and the Remote face both call `catalog()` and `installPlugin()`. Neither gets its own copy of the traversal or of a refusal rule.
- **`src/types.ts` is the wire contract's only home.** `gateway.ts` must NOT re-export it: the gateway's module graph is Node-only (`node:path`), and a re-export drags that into the browser compilation face.
- **Client copy is locale-owned.** Every new string goes into `src/client/locales.ts` under both `zh` and `en`; `pnpm run verify-client-ui-i18n` rejects hardcoded product text.
- **Components receive data through the four props shares.** No `ctx` in a `.tsx`, no service import, no `useSyncExternalStore`, no manual subscription.
- **Per-file 100% coverage** on `packages/*/*/src`; `packages/*/*/src/types.ts` is excluded as types-only. `pnpm run test:coverage` is the gate, `pnpm run test` is not.
- **Both compiler aggregates must pass:** `npx tsc -b tsconfig.host.json` and `npx tsc -b tsconfig.client.json`. A per-package `tsc -b` does NOT prove a declaration reaches consumers.
- **`pnpm run test:gui`** after every panel change.
- **Bilingual pairs.** Editing a README or Agent Note updates its `.zh.md` and re-records with `npx tsx scripts/verify-translation-pairing.ts --write <english path>`.
- **Commit after each task**, naming the operation rather than the file.
- **Never run `pnpm run build` as part of a task.** It rebuilds every artifact and kills a running `dsh web`; the aggregates above are the type check this work needs.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/host/plugin-marketplace/src/catalog.ts` (create) | The one catalog operation: visit every registration, normalize rows, contain per-marketplace failures |
| `packages/host/plugin-marketplace/src/install.ts` (modify) | Each refusal carries a structural `reason` |
| `packages/host/plugin-marketplace/src/marketplace-command.ts` (modify) | `search` prints what `catalog()` returned |
| `packages/host/plugin-marketplace/src/types.ts` (modify) | Wire types and the three new failure codes |
| `packages/host/plugin-marketplace/src/gateway.ts` (modify) | `catalog` and `install` Remote methods, plus the refusal mapping |
| `packages/host/plugin-marketplace/src/index.ts` (modify) | Export the catalog operation alongside the rest of the public API |
| `packages/host/plugin-marketplace/tests/install-reasons.spec.ts` (create) | What each refusal reports |
| `packages/host/plugin-marketplace/tests/catalog.spec.ts` (create) | The catalog operation's own contract |
| `packages/host/plugin-marketplace/tests/search-command.spec.ts` (create) | The CLI's search output and its containment |
| `packages/host/plugin-marketplace/tests/gateway.spec.ts` (modify) | The two new Remote methods |
| `packages/api/remotes/src/client/index.ts` (modify) | Re-export the new view types to business packages |
| `packages/client/ui-settings-marketplace/src/client/CatalogSection.tsx` (create) | The available-plugins section |
| `packages/client/ui-settings-marketplace/src/client/MarketplaceSettingsTab.tsx` (modify) | Mount the section and own its state |
| `packages/client/ui-settings-marketplace/src/client/index.ts` (modify) | Inject face gains `catalog` and `install` |
| `packages/client/ui-settings-marketplace/src/client/locales.ts` (modify) | New copy in both languages |
| `packages/client/ui-settings-marketplace/src/client/MarketplaceSettingsTab.module.css` (modify) | Section styles |
| `packages/client/ui-settings-marketplace/tests/components.client.spec.tsx` (modify) | Section behavior |

---

### Task 1: A refusal that names its own reason

Today `InstallError` is a bare `Error` subclass, so the only way to tell an unpinned refusal from a missing plugin is to read English. This task gives each refusal a structural fact.

**Files:**
- Modify: `packages/host/plugin-marketplace/src/install.ts` (class at 45, throws at 111, 139, 158, 207)
- Test: `packages/host/plugin-marketplace/tests/install-reasons.spec.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export type InstallRefusal = 'name-unusable' | 'no-marketplace' | 'not-found' | 'unpinned'`
  - `export class InstallError extends Error { readonly reason: InstallRefusal; constructor(reason: InstallRefusal, message: string) }`

- [ ] **Step 1: Write the failing test**

Create `packages/host/plugin-marketplace/tests/install-reasons.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/host/plugin-marketplace/tests/install-reasons.spec.ts`
Expected: FAIL — `error.reason` is `undefined` on every case, and the file does not type-check because `InstallError` takes one argument.

- [ ] **Step 3: Write the minimal implementation**

In `packages/host/plugin-marketplace/src/install.ts`, replace the class at line 45 with:

```ts
/**
 * Why an install was refused.
 *
 * Structural rather than textual: the Remote face maps this to a wire code, so
 * a reworded message must not be able to change what a client is told.
 */
export type InstallRefusal = 'name-unusable' | 'no-marketplace' | 'not-found' | 'unpinned'

/** Raised when an install or a resolution is refused. */
export class InstallError extends Error {
  /** Which refusal this is. */
  readonly reason: InstallRefusal

  /**
   * @param reason - which refusal this is.
   * @param message - the human-readable explanation.
   */
  constructor(reason: InstallRefusal, message: string) {
    super(message)
    this.name = 'InstallError'
    this.reason = reason
  }
}
```

Then update the four throw sites:

```ts
// line 111
if (safe === '') throw new InstallError('name-unusable', `plugin name ${JSON.stringify(plugin)} has no usable characters`)

// line 139
throw new InstallError('no-marketplace', 'no marketplaces registered; run `dsh plugin marketplace add <repo>` first')

// line 158
throw new InstallError('not-found', `no marketplace lists a plugin named ${JSON.stringify(plugin)}`)

// line 207
throw new InstallError(
  'unpinned',
  `refusing to install ${plugin}: its source has no sha pin, so the content is not reproducible`
  + ' (pass allowUnpinned / --allow-unpinned to record the commit the ref names now)',
)
```

Update the four `@throws {InstallError}` JSDoc lines on `pluginInstallPath`, `resolveEntry`, and `installPlugin` to name the reasons they raise, for example `@throws {InstallError} with reason \`name-unusable\` when sanitizing leaves no usable characters.`

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/host/plugin-marketplace/tests/install-reasons.spec.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Verify nothing else regressed**

Run: `npx vitest run packages/host/plugin-marketplace && npx tsc -b packages/host/plugin-marketplace`
Expected: all specs pass, `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/host/plugin-marketplace/src/install.ts packages/host/plugin-marketplace/tests/install-reasons.spec.ts
git commit -m "feat(marketplace): give each install refusal a structural reason"
```

---

### Task 2: The catalog operation

One operation that reads every registered marketplace and returns rows the panel and the CLI both render.

**Files:**
- Create: `packages/host/plugin-marketplace/src/catalog.ts`
- Modify: `packages/host/plugin-marketplace/src/index.ts` (add the exports)
- Test: `packages/host/plugin-marketplace/tests/catalog.spec.ts` (create)

**Interfaces:**
- Consumes: `fetchMarketplace` and `FetchOptions` from `./fetch.ts`; `isPinned`, `MarketplaceEntry` from `./parse.ts`; `findInstalled`, `rowIdFor`, `MarketplaceState` from `./state.ts`.
- Produces:
  - `export interface CatalogRow { plugin: string; marketplace: string; description?: string; category?: string; version?: string; tags: string[]; installable: boolean; installed: boolean; warnings: string[] }`
  - `export interface MarketplaceFailure { marketplace: string; reason: string }`
  - `export interface CatalogResult { rows: CatalogRow[]; failed: MarketplaceFailure[] }`
  - `export async function catalog(state: MarketplaceState, options: { fetch?: FetchOptions } = {}): Promise<CatalogResult>`

- [ ] **Step 1: Write the failing test**

Create `packages/host/plugin-marketplace/tests/catalog.spec.ts`:

```ts
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
    // The unreachable registration comes FIRST. With `break` instead of
    // `continue`, the readable registration after it would never be visited and
    // `rows` would be empty, so this order is the assertion's whole
    // discriminating power — the other order passes under either behaviour.
    const result = await catalog(registrations(['extra', EXTRA], ['official', OFFICIAL]))

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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/host/plugin-marketplace/tests/catalog.spec.ts`
Expected: FAIL — `Cannot find module '../src/catalog.ts'`.

- [ ] **Step 3: Write the minimal implementation**

Create `packages/host/plugin-marketplace/src/catalog.ts`:

```ts
/**
 * The catalog read: what the registered marketplaces offer right now.
 *
 * One operation serves both faces. The CLI prints these rows and the Web panel
 * renders them, so the traversal, the installability verdict, and the
 * containment rule exist once rather than once per caller.
 *
 * A registration that cannot be read is reported rather than thrown. The loop
 * this replaced awaited every marketplace in turn and let the first failure
 * abort the command, so one unreachable registration hid every result from the
 * ones that answered.
 *
 * This deliberately does NOT share its traversal with `resolveEntry`, which
 * resolves one name and stops at the first marketplace listing it. A catalog
 * must visit every registration, and merging the two would make every install
 * pay for the read path's completeness.
 *
 * @module @deepseek-ai/dsh-host-plugin-marketplace/catalog
 */

import { fetchMarketplace, type FetchOptions } from './fetch.ts'
import { isPinned, type MarketplaceEntry } from './parse.ts'
import { findInstalled, rowIdFor, type MarketplaceState } from './state.ts'

/** One installable entry, as a list row. */
export interface CatalogRow {
  /** Plugin name as its marketplace declares it. */
  plugin: string
  /** Marketplace this entry came from. */
  marketplace: string
  /** One-line summary the marketplace published. */
  description?: string
  /** Category the marketplace filed it under. */
  category?: string
  /** Version the marketplace declared, not the pin. */
  version?: string
  /** Free-form tags the marketplace published. */
  tags: string[]
  /** Whether our own pin rule accepts the source. Decided here, never by a caller. */
  installable: boolean
  /** Whether an installed record already exists for this name. */
  installed: boolean
  /** Diagnostics the entry carried, including a missing pin. */
  warnings: string[]
}

/** One registration that could not be read. */
export interface MarketplaceFailure {
  /** Marketplace that failed, by its registration name. */
  marketplace: string
  /** Why it failed, as the fetch layer reported it. */
  reason: string
}

/** What one catalog read produced. */
export interface CatalogResult {
  /** Every entry from every readable registration, in registration order. */
  rows: CatalogRow[]
  /** Registrations that could not be read. Their entries are simply absent. */
  failed: MarketplaceFailure[]
}

/**
 * Read every registered marketplace and normalize its entries into rows.
 *
 * @param state - the registered marketplaces, read in stored order.
 * @param options - fetch budget and cancellation passed to every read.
 * @returns the rows and the registrations that could not be read.
 */
export async function catalog(
  state: MarketplaceState,
  options: { fetch?: FetchOptions } = {},
): Promise<CatalogResult> {
  const rows: CatalogRow[] = []
  const failed: MarketplaceFailure[] = []

  for (const registration of state.marketplaces) {
    let entries: readonly MarketplaceEntry[]
    let marketplace: string
    try {
      const market = await fetchMarketplace(registration.url, options.fetch ?? {})
      entries = market.plugins
      marketplace = market.name
    } catch (error) {
      failed.push({
        marketplace: registration.name,
        /* v8 ignore next -- fetchMarketplace throws only Error instances; the String arm only satisfies the unknown narrowing. */
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    for (const entry of entries) {
      rows.push({
        plugin: entry.name,
        marketplace,
        ...(entry.description !== undefined ? { description: entry.description } : {}),
        ...(entry.category !== undefined ? { category: entry.category } : {}),
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        tags: [...entry.tags],
        installable: isPinned(entry),
        installed: findInstalled(state, rowIdFor(entry.name)) !== undefined,
        warnings: [...entry.warnings],
      })
    }
  }

  return { rows, failed }
}
```

In `packages/host/plugin-marketplace/src/index.ts`, add next to the existing `export { isPinned, ... }` block:

```ts
export { catalog } from './catalog.ts'
export type { CatalogResult, CatalogRow, MarketplaceFailure } from './catalog.ts'
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/host/plugin-marketplace/tests/catalog.spec.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/host/plugin-marketplace/src/catalog.ts packages/host/plugin-marketplace/src/index.ts packages/host/plugin-marketplace/tests/catalog.spec.ts
git commit -m "feat(marketplace): add the catalog read shared by the CLI and the panel"
```

---

### Task 3: The CLI prints the catalog

`search` stops owning a traversal and starts owning formatting only.

**Files:**
- Modify: `packages/host/plugin-marketplace/src/marketplace-command.ts` (the `case 'search':` block at 150-172)
- Test: `packages/host/plugin-marketplace/tests/search-command.spec.ts` (create)

**Interfaces:**
- Consumes: `catalog` from `./catalog.ts` (Task 2).
- Produces: no new exported name; `runMarketplace(['search', ...])` keeps its exit codes and output format.

- [ ] **Step 1: Write the failing test**

Create `packages/host/plugin-marketplace/tests/search-command.spec.ts`:

```ts
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
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
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
    vi.stubGlobal('fetch', async (input: string | URL) => {
      if (String(input) === EXTRA) throw new TypeError('connection refused')
      return new Response(JSON.stringify({
        name: 'official',
        plugins: [{ name: 'deploy', description: 'deploy flow', source: PINNED }],
      }), { status: 200 })
    })
    await runMarketplace(['add', OFFICIAL])
    await runMarketplace(['add', EXTRA])

    expect(await runMarketplace(['search', ''])).toBe(0)
    const output = stdout.read()
    expect(output).toContain('deploy')
    expect(output).toContain('connection refused')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/host/plugin-marketplace/tests/search-command.spec.ts`
Expected: FAIL on the second case — the command currently rethrows the fetch failure, so `runMarketplace` rejects and the assertion never sees output. The first case passes already, which is correct: this task must not change the format.

- [ ] **Step 3: Write the minimal implementation**

Replace the `case 'search':` block in `packages/host/plugin-marketplace/src/marketplace-command.ts`:

```ts
    case 'search': {
      const query = rest.join(' ').trim().toLowerCase()
      if (ctx.state.marketplaces.length === 0) {
        process.stderr.write(`${NAME}: no marketplaces registered; run \`dsh plugin marketplace add official\`\n`)
        return 1
      }
      const { rows, failed } = await catalog(ctx.state)
      // A registration that could not be read is reported on stderr and does
      // not stop the rows the readable ones supplied. Silence here would read
      // as "this marketplace lists nothing", which is a different fact.
      for (const failure of failed) {
        process.stderr.write(`${NAME}: ${failure.marketplace}: ${failure.reason}\n`)
      }
      let matches = 0
      for (const row of rows) {
        const haystack = `${row.plugin} ${row.description ?? ''} ${row.category ?? ''} ${row.tags.join(' ')}`.toLowerCase()
        if (query !== '' && !haystack.includes(query)) continue
        matches++
        process.stdout.write(`${row.plugin}${row.installed ? ' [installed]' : ''}\n`)
        if (row.description !== undefined) {
          process.stdout.write(`    ${row.description.slice(0, 140)}\n`)
        }
      }
      if (matches === 0) process.stdout.write(`no plugin matched ${JSON.stringify(query)}\n`)
      return 0
    }
```

Add `catalog` to the imports from `./catalog.ts` at the top of the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/host/plugin-marketplace/tests/search-command.spec.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/host/plugin-marketplace/src/marketplace-command.ts packages/host/plugin-marketplace/tests/search-command.spec.ts
git commit -m "refactor(marketplace): print the catalog read from the search command"
```

---

### Task 4: The two Remote methods

**Files:**
- Modify: `packages/host/plugin-marketplace/src/types.ts` (append the wire types; extend `RemoteErrorDetailsMap` at 25-38)
- Modify: `packages/host/plugin-marketplace/src/gateway.ts` (add two `@Remote` methods after `uninstall` at 239)
- Test: `packages/host/plugin-marketplace/tests/gateway.spec.ts` (modify)

**Interfaces:**
- Consumes: `catalog` (Task 2), `InstallError` and `InstallRefusal` (Task 1), `installPlugin` (`./install.ts`).
- Produces:
  - `export interface CatalogRowView` — the `CatalogRow` fields, restated as the wire contract.
  - `export interface MarketplaceFailureView { marketplace: string; reason: string }`
  - `export interface MarketplaceCatalogView { rows: CatalogRowView[]; failed: MarketplaceFailureView[] }`
  - `export interface PluginInstallRequest { plugin: string; allowUnpinned?: boolean }`
  - `export interface PluginInstallResultView { plugin: string; sha?: string; warnings: string[]; status: MarketplaceStatusView }`
  - `MarketplaceGateway.catalog(): Promise<MarketplaceCatalogView>`
  - `MarketplaceGateway.install(request: PluginInstallRequest): Promise<PluginInstallResultView>`

- [ ] **Step 1: Write the failing test**

Append to `packages/host/plugin-marketplace/tests/gateway.spec.ts`. First add `vi` to the vitest import and `installPlugin`-adjacent imports, then the block:

```ts
const PINNED = { source: 'git', url: 'https://example.test/pinned.git', sha: 'a'.repeat(40) }
const LOOSE = { source: 'git', url: 'https://example.test/loose.git' }
const MANIFEST = 'https://example.test/marketplace.json'

/** Register one marketplace in the scratch state and serve its manifest. */
async function withMarketplace(plugins: readonly object[]): Promise<void> {
  mkdirSync(join(scratch, 'marketplace'), { recursive: true })
  const state = upsertMarketplace(emptyState(), 'test', MANIFEST)
  saveState(join(scratch, 'marketplace', 'state.json'), state)
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ name: 'test', plugins }), { status: 200 }))
}

describe('marketplace.catalog', () => {
  it('answers on a read-only deployment, because browsing is a read', async () => {
    const { gateway } = await harness({ allowMutations: false })
    await withMarketplace([{ name: 'pinned', source: PINNED }])
    const view = await gateway.catalog()
    expect(view.rows.map(row => row.plugin)).toEqual(['pinned'])
  })

  it('restates the catalog rows as the wire contract', async () => {
    const { gateway } = await harness()
    await withMarketplace([{ name: 'loose', source: LOOSE }])
    const view = await gateway.catalog()
    expect(view.rows[0]).toMatchObject({ plugin: 'loose', installable: false, installed: false })
    expect(view.failed).toEqual([])
  })
})

describe('marketplace.install', () => {
  it('refuses on a read-only deployment', async () => {
    const { gateway } = await harness({ allowMutations: false })
    await withMarketplace([{ name: 'pinned', source: PINNED }])
    await expect(gateway.install({ plugin: 'pinned' })).rejects.toMatchObject({ code: 'marketplace/read-only' })
  })

  it('refuses a name no marketplace lists', async () => {
    const { gateway } = await harness()
    await withMarketplace([{ name: 'pinned', source: PINNED }])
    await expect(gateway.install({ plugin: 'absent' })).rejects.toMatchObject({ code: 'marketplace/not-found' })
  })

  it('refuses an unpinned entry, and installs it when the request opts in', async () => {
    const { gateway } = await harness()
    await withMarketplace([{ name: 'loose', source: LOOSE }])
    await expect(gateway.install({ plugin: 'loose' })).rejects.toMatchObject({ code: 'marketplace/unpinned' })
  })
})
```

Also add `vi` to the existing `import { afterEach, beforeEach, describe, expect, it } from 'vitest'` line, and add `vi.unstubAllGlobals()` to the existing `afterEach`.

The opt-in half needs a real git remote, so it belongs to Task 8's manual check rather than a unit test; the refusal half is what this task pins.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/host/plugin-marketplace/tests/gateway.spec.ts`
Expected: FAIL — `gateway.catalog is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `packages/host/plugin-marketplace/src/types.ts`:

```ts
/** One catalog row, as the panel renders it. */
export interface CatalogRowView {
  /** Plugin name as its marketplace declares it. */
  plugin: string
  /** Marketplace this entry came from. */
  marketplace: string
  /** One-line summary the marketplace published. */
  description?: string
  /** Category the marketplace filed it under. */
  category?: string
  /** Version the marketplace declared, not the pin. */
  version?: string
  /** Free-form tags the marketplace published. */
  tags: string[]
  /** Whether the Host's pin rule accepts the source. Decided by the Host, never by the panel. */
  installable: boolean
  /** Whether an installed record already exists for this name. */
  installed: boolean
  /** Diagnostics the entry carried, including a missing pin. */
  warnings: string[]
}

/** One registration the Host could not read. */
export interface MarketplaceFailureView {
  /** Marketplace that failed, by its registration name. */
  marketplace: string
  /** Why it failed, as the fetch layer reported it. */
  reason: string
}

/**
 * Everything the panel's available-plugins section renders from one read.
 *
 * `failed` is reported rather than thrown: one unreachable registration must
 * not blank the rows the readable ones supplied.
 */
export interface MarketplaceCatalogView {
  /** Every entry from every readable registration, in registration order. */
  rows: CatalogRowView[]
  /** Registrations that could not be read. */
  failed: MarketplaceFailureView[]
}

/** One plugin to install. */
export interface PluginInstallRequest {
  /** Plugin name as its marketplace declares it. */
  plugin: string
  /**
   * Accept a source that declares no `sha`, recording the commit its ref
   * resolves to now.
   *
   * Absent means refuse. The panel sets it only after the user acknowledges
   * the entry's missing pin.
   */
  allowUnpinned?: boolean
}

/** What one install produced. */
export interface PluginInstallResultView {
  /** Plugin the call addressed. */
  plugin: string
  /** Commit the install recorded; absent only for a local source. */
  sha?: string
  /** What the install wants to tell the user, verbatim from the Host. */
  warnings: string[]
  /** The status after the install, so the panel needs no second round trip. */
  status: MarketplaceStatusView
}
```

Extend the `RemoteErrorDetailsMap` block:

```ts
    /** The named plugin has no installed record, so there is nothing to toggle or remove. */
    'marketplace/not-installed': { readonly plugin: string }
    /** No registered marketplace lists the requested plugin. */
    'marketplace/not-found': { readonly plugin: string }
    /** The entry's source declares no `sha` and the request did not accept one. */
    'marketplace/unpinned': { readonly plugin: string }
    /** The install failed after it was admitted: a fetch or filesystem fault. */
    'marketplace/install-failed': { readonly plugin: string; readonly reason: string }
```

In `packages/host/plugin-marketplace/src/gateway.ts`, add the imports and the two methods after `uninstall`:

```ts
import { catalog } from './catalog.ts'
import { InstallError, installPlugin, type InstallRefusal } from './install.ts'
```

```ts
  /**
   * Read what the registered marketplaces offer.
   *
   * A read, so a read-only deployment is served: browsing is not a mutation.
   * It is the only method here that reaches the network, which is why the
   * panel asks for it on request rather than when its tab opens.
   *
   * @returns every entry from every readable registration, plus the
   *   registrations that could not be read.
   */
  @Remote('catalog')
  async catalog(): Promise<MarketplaceCatalogView> {
    const result = await catalog(this.readState())
    return {
      rows: result.rows.map(row => ({ ...row, tags: [...row.tags], warnings: [...row.warnings] })),
      failed: result.failed.map(failure => ({ ...failure })),
    }
  }

  /**
   * Install one plugin and reconcile it, returning the status that produced.
   *
   * @param request - the plugin name and whether an unpinned source is accepted.
   * @returns what the install recorded and the resulting status.
   * @throws {RemoteError} `marketplace/read-only` when this deployment refuses
   *   writes, or the mapped refusal when the install was not admitted.
   */
  @Remote('install')
  async install(request: PluginInstallRequest): Promise<PluginInstallResultView> {
    this.requireMutations()
    const plugin = requirePluginName(request.plugin, 'install')
    let result: Awaited<ReturnType<typeof installPlugin>>
    try {
      result = await installPlugin(plugin, {
        state: this.readState(),
        statePath: this.statePath,
        sync: this.writeTarget(),
        ...(request.allowUnpinned === true ? { allowUnpinned: true } : {}),
      })
    } catch (error) {
      if (error instanceof InstallError) throw new RemoteError(INSTALL_REFUSAL_CODE[error.reason], error.message, { plugin })
      throw new RemoteError('marketplace/install-failed', error instanceof Error ? error.message : String(error), {
        plugin,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
    return {
      plugin: result.entry.plugin,
      ...(result.entry.sha !== undefined ? { sha: result.entry.sha } : {}),
      warnings: [...result.warnings],
      status: await this.status(),
    }
  }
```

Add the mapping table near the file's other module-level constants:

```ts
/** Wire code for each refusal an install can raise. */
const INSTALL_REFUSAL_CODE: Record<InstallRefusal, RemoteErrorCode> = {
  'name-unusable': 'gateway/bad-request',
  'no-marketplace': 'marketplace/not-found',
  'not-found': 'marketplace/not-found',
  'unpinned': 'marketplace/unpinned',
}
```

Import `RemoteErrorCode` as a type from `@deepseek-ai/dsh-typert-protocol`, and add the new view types to the `./types.ts` type import list. `RemoteError`'s constructor is `(code, message, details, options?)`, so the details object above is required and those calls are complete as written.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/host/plugin-marketplace/tests/gateway.spec.ts`
Expected: PASS, with the five new cases green and the existing cases unchanged.

- [ ] **Step 5: Verify the whole package and the host aggregate**

Run: `npx vitest run packages/host/plugin-marketplace && npx tsc -b tsconfig.host.json`
Expected: specs pass; `tsc` exits 0. The aggregate is required because the generated Remote declaration is consumed outside this package.

- [ ] **Step 6: Commit**

```bash
git add packages/host/plugin-marketplace/src/types.ts packages/host/plugin-marketplace/src/gateway.ts packages/host/plugin-marketplace/tests/gateway.spec.ts
git commit -m "feat(marketplace): serve catalog and install over the Remote face"
```

---

### Task 5: Publish the new wire types to business packages

**Files:**
- Modify: `packages/api/remotes/src/client/index.ts` (the `export type { ... } from '@deepseek-ai/dsh-host-plugin-marketplace/types'` block at 24-32)

**Interfaces:**
- Consumes: the view types from Task 4.
- Produces: those names re-exported from `@deepseek-ai/dsh-api-remotes/client`.

- [ ] **Step 1: Add the names**

In the existing export block, add them in alphabetical position:

```ts
export type {
  CatalogRowView,
  InstalledPluginView,
  InstalledStateView,
  MarketplaceCatalogView,
  MarketplaceFailureView,
  MarketplaceRegistrationView,
  MarketplaceStatusView,
  PluginEnablementView,
  PluginInstallRequest,
  PluginInstallResultView,
  PluginRemovalView,
  SkillsStateView,
} from '@deepseek-ai/dsh-host-plugin-marketplace/types'
```

- [ ] **Step 2: Verify**

Run: `npx tsc -b tsconfig.client.json`
Expected: exits 0. There is no runtime behavior to test; the assertion is that the names resolve in the client compilation face.

- [ ] **Step 3: Commit**

```bash
git add packages/api/remotes/src/client/index.ts
git commit -m "feat(api-remotes): publish the marketplace catalog wire types"
```

---

### Task 6: The available-plugins section

The panel gains a third section that loads on request and filters in the browser.

**Files:**
- Create: `packages/client/ui-settings-marketplace/src/client/CatalogSection.tsx`
- Modify: `packages/client/ui-settings-marketplace/src/client/MarketplaceSettingsTab.tsx`
- Modify: `packages/client/ui-settings-marketplace/src/client/index.ts` (inject face at 69-73 and the register call at 82)
- Modify: `packages/client/ui-settings-marketplace/src/client/locales.ts`
- Modify: `packages/client/ui-settings-marketplace/src/client/MarketplaceSettingsTab.module.css`
- Test: `packages/client/ui-settings-marketplace/tests/components.client.spec.tsx`

**Interfaces:**
- Consumes: `MarketplaceCatalogView` and `CatalogRowView` from `@deepseek-ai/dsh-api-remotes/client` (Task 5).
- Produces:
  - `MarketplaceSettingsTabInjected` gains `catalog: () => Promise<MarketplaceCatalogView>`.
  - `CatalogSectionProps` = `{ t: Translate; view: MarketplaceCatalogView | undefined; loading: boolean; failed: boolean; query: string; onLoad: () => void; onQuery: (next: string) => void; onRefresh: () => void }`.

- [ ] **Step 1: Add the locale keys**

In `packages/client/ui-settings-marketplace/src/client/locales.ts`, add to the `en` dictionary (and the matching `zh` entries):

```ts
  'catalogTitle': 'Available plugins',
  'catalogLoad': 'Browse available plugins',
  'catalogLoading': 'Reading the marketplaces…',
  'catalogRefresh': 'Refresh',
  'catalogSearchPlaceholder': 'Filter by name, description, category or tag',
  'catalogEmpty': 'Every registered marketplace is empty.',
  'catalogNoMatch': 'No available plugin matches that filter.',
  'catalogFailed': 'Could not read the registered marketplaces.',
  'catalogMarketplaceFailed': 'Could not read',
  'catalogInstalled': 'installed',
  'catalogInstall': 'Install',
  'catalogUnpinned': 'no pin',
```

Chinese:

```ts
  'catalogTitle': '可安裝的插件',
  'catalogLoad': '瀏覽可安裝的插件',
  'catalogLoading': '正在讀取插件市場…',
  'catalogRefresh': '重新整理',
  'catalogSearchPlaceholder': '依名稱、說明、分類或標籤過濾',
  'catalogEmpty': '已註冊的插件市場都是空的。',
  'catalogNoMatch': '沒有可安裝的插件符合這個過濾條件。',
  'catalogFailed': '無法讀取已註冊的插件市場。',
  'catalogMarketplaceFailed': '無法讀取',
  'catalogInstalled': '已安裝',
  'catalogInstall': '安裝',
  'catalogUnpinned': '未釘選',
```

- [ ] **Step 2: Write the failing test**

Append to `packages/client/ui-settings-marketplace/tests/components.client.spec.tsx`:

```tsx
describe('available plugins', () => {
  it('stays unloaded until asked, then renders rows and filters locally', async () => {
    const catalog = vi.fn(async () => ({
      rows: [
        { plugin: 'commit-helper', marketplace: 'official', description: 'commit flow', tags: [], installable: true, installed: false, warnings: [] },
        { plugin: 'deploy', marketplace: 'official', description: 'deploy flow', category: 'ops', tags: [], installable: true, installed: false, warnings: [] },
      ],
      failed: [],
    }))
    render(<MarketplaceSettingsTab {...props({ catalog })} />)
    await screen.findByText('superpowers')

    // Nothing is read until the user asks: the tab must not depend on the network.
    expect(catalog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    expect(await screen.findByText('commit-helper')).toBeTruthy()
    expect(catalog).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByPlaceholderText('Filter by name, description, category or tag'), { target: { value: 'ops' } })
    expect(screen.queryByText('commit-helper')).toBeNull()
    expect(screen.getByText('deploy')).toBeTruthy()
    // Filtering is local: one read for the whole interaction.
    expect(catalog).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed catalog read inside its own section', async () => {
    const catalog = vi.fn(async () => { throw new Error('gateway/internal: boom') })
    render(<MarketplaceSettingsTab {...props({ catalog })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))

    expect(await screen.findByText('Could not read the registered marketplaces.')).toBeTruthy()
    // The sections that read local state still render.
    expect(screen.getByText('superpowers')).toBeTruthy()
  })
})
```

`props({ catalog })` extends the file's existing props helper; add `catalog` to that helper's injected face so every existing test keeps compiling.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/client/ui-settings-marketplace`
Expected: FAIL — no button with that accessible name exists.

- [ ] **Step 4: Write the implementation**

Create `packages/client/ui-settings-marketplace/src/client/CatalogSection.tsx`:

```tsx
/**
 * The available-plugins section: what the registered marketplaces offer.
 *
 * It reads on REQUEST rather than on mount. Every other read in this tab is
 * local, so the tab cannot be blanked by a network fault; loading a catalog
 * when the tab opens would make opening a settings page wait on a git fetch.
 *
 * Filtering happens here, over rows the Host already returned, so a keystroke
 * costs nothing. The predicate is character-for-character the one the CLI
 * applies on the Host: one substring test over the same four fields.
 */
import type { ReactNode } from 'react'
import type { MarketplaceCatalogView } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplaceSettingsTabProps } from './MarketplaceSettingsTab.tsx'
import css from './MarketplaceSettingsTab.module.css'

/** Whether one row matches a filter, by the same fields the CLI searches. */
export function matchesQuery(row: MarketplaceCatalogView['rows'][number], query: string): boolean {
  if (query === '') return true
  const haystack = `${row.plugin} ${row.description ?? ''} ${row.category ?? ''} ${row.tags.join(' ')}`.toLowerCase()
  return haystack.includes(query.toLowerCase())
}

/** The section's props, threaded from the tab's owner site. */
export interface CatalogSectionProps {
  /** Bound translate for this plugin's namespace. */
  readonly t: MarketplaceSettingsTabProps['t']
  /** The loaded catalog, absent until the user asks for it. */
  readonly view: MarketplaceCatalogView | undefined
  /** Whether a read is in flight. */
  readonly loading: boolean
  /** Whether the last read failed. */
  readonly failed: boolean
  /** Current filter text. */
  readonly query: string
  /** Read the catalog for the first time. */
  readonly onLoad: () => void
  /** Read it again. */
  readonly onRefresh: () => void
  /** Replace the filter text. */
  readonly onQuery: (next: string) => void
}

/** Render the section. */
export function CatalogSection({ t, view, loading, failed, query, onLoad, onRefresh, onQuery }: CatalogSectionProps): ReactNode {
  if (view === undefined) {
    return (
      <section className={css.section}>
        <h3 className={css.sectionTitle}>{t('catalogTitle')}</h3>
        <Button variant="outline" disabled={loading} onClick={onLoad}>{t('catalogLoad')}</Button>
        {loading ? <p className={css.muted}>{t('catalogLoading')}</p> : null}
        {failed ? <p className={css.actionError}>{t('catalogFailed')}</p> : null}
      </section>
    )
  }

  const rows = view.rows.filter(row => matchesQuery(row, query))
  return (
    <section className={css.section}>
      <h3 className={css.sectionTitle}>{t('catalogTitle')}</h3>
      <input
        className={css.filter}
        type="search"
        value={query}
        placeholder={t('catalogSearchPlaceholder')}
        aria-label={t('catalogSearchPlaceholder')}
        onChange={(event) => { onQuery(event.target.value) }}
      />
      <Button variant="outline" disabled={loading} onClick={onRefresh}>{t('catalogRefresh')}</Button>
      {loading ? <p className={css.muted}>{t('catalogLoading')}</p> : null}
      {failed ? <p className={css.actionError}>{t('catalogFailed')}</p> : null}
      {view.failed.map(failure => (
        <p key={failure.marketplace} className={css.actionError}>
          {`${t('catalogMarketplaceFailed')} ${failure.marketplace}: ${failure.reason}`}
        </p>
      ))}
      {rows.length === 0
        ? <p className={css.muted}>{view.rows.length === 0 ? t('catalogEmpty') : t('catalogNoMatch')}</p>
        : (
          <ul className={css.list}>
            {rows.map(row => (
              <li key={`${row.marketplace}/${row.plugin}`} className={css.card}>
                <div className={css.cardHead}>
                  <span className={css.cardTitle}>{row.plugin}</span>
                  {row.installed ? <Tag tone="info">{t('catalogInstalled')}</Tag> : null}
                  {row.installable ? null : <Tag tone="warning">{t('catalogUnpinned')}</Tag>}
                </div>
                {row.description !== undefined ? <p className={css.detail}>{row.description}</p> : null}
                {row.warnings.map(warning => <p key={warning} className={css.detail}>{warning}</p>)}
              </li>
            ))}
          </ul>
        )}
    </section>
  )
}
```

In `MarketplaceSettingsTab.tsx`, add `catalog` to the injected interface, thread the section state, and render `<CatalogSection ... />` after the installed section:

```tsx
  /** Read the catalog of installable plugins from the registered marketplaces. */
  catalog: () => Promise<MarketplaceCatalogView>
```

```tsx
  const [catalogState, setCatalogState] = useState<CatalogState>({ status: 'unloaded' })
  const [query, setQuery] = useState('')

  const loadCatalog = useCallback(async (): Promise<void> => {
    setCatalogState(current => ({ status: 'loading', view: 'view' in current ? current.view : undefined }))
    try {
      setCatalogState({ status: 'ready', view: await catalog() })
    } catch {
      setCatalogState(current => ({ status: 'failed', view: 'view' in current ? current.view : undefined }))
    }
  }, [catalog])
```

with, beside the existing `ViewState`:

```tsx
type CatalogState =
  | { readonly status: 'unloaded' }
  | { readonly status: 'loading'; readonly view?: MarketplaceCatalogView }
  | { readonly status: 'ready'; readonly view: MarketplaceCatalogView }
  | { readonly status: 'failed'; readonly view?: MarketplaceCatalogView }
```

and the owner site:

```tsx
      <CatalogSection
        t={t}
        view={catalogState.view}
        loading={catalogState.status === 'loading'}
        failed={catalogState.status === 'failed'}
        query={query}
        onLoad={() => { void loadCatalog() }}
        onRefresh={() => { void loadCatalog() }}
        onQuery={setQuery}
      />
```

Add to `MarketplaceSettingsTab.module.css`:

```css
.filter {
  width: 100%;
  margin-bottom: 0.5rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--dsw-color-border);
  border-radius: 4px;
  background: var(--dsw-color-surface);
  color: inherit;
  font: inherit;
}
```

In `src/client/index.ts`, add the wrapper and extend the inject face:

```ts
  const catalog = (): Promise<MarketplaceCatalogView> => unwrap(() => ctx.remote.marketplace.catalog())
```

```ts
    inject: (): MarketplaceSettingsTabInjected => ({ status, setEnabled, uninstall, catalog }),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/client/ui-settings-marketplace`
Expected: PASS, all existing cases plus the two new ones.

- [ ] **Step 6: Run the GUI suite and the i18n gate**

Run: `pnpm run test:gui && pnpm run verify-client-ui-i18n`
Expected: suites pass; the i18n gate reports no hardcoded copy. Its known environment failures (`present-open.host.spec` symlinks, `pdf-license-bundle.client.spec` needing `tar`) are unrelated to this task; report them, do not "fix" them.

- [ ] **Step 7: Commit**

```bash
git add packages/client/ui-settings-marketplace
git commit -m "feat(ui-settings-marketplace): browse the available plugins"
```

---

### Task 7: Unpinned acknowledgement and install

**Files:**
- Modify: `packages/client/ui-settings-marketplace/src/client/CatalogSection.tsx`
- Modify: `packages/client/ui-settings-marketplace/src/client/MarketplaceSettingsTab.tsx`
- Modify: `packages/client/ui-settings-marketplace/src/client/index.ts`
- Modify: `packages/client/ui-settings-marketplace/src/client/locales.ts`
- Test: `packages/client/ui-settings-marketplace/tests/components.client.spec.tsx`

**Interfaces:**
- Consumes: `PluginInstallResultView` from `@deepseek-ai/dsh-api-remotes/client` (Task 5).
- Produces:
  - `MarketplaceSettingsTabInjected` gains `install: (plugin: string, allowUnpinned: boolean) => Promise<PluginInstallResultView>`.
  - `CatalogSectionProps` gains `editable: boolean`, `onInstall: (row: CatalogRowView) => void`, `busy: string | undefined`, `failedFor: Readonly<Record<string, string>>`.

- [ ] **Step 1: Add the locale keys**

```ts
  'catalogInstallUnpinnedTitle': 'This entry has no pin',
  'catalogInstallUnpinnedDescription': 'The marketplace declares no commit for this plugin, so the code that arrives is whatever its branch points at today. It cannot be checked later against what you reviewed.',
  'catalogInstallUnpinnedAcknowledge': 'I understand this entry is unpinned',
  'catalogInstallUnpinnedConfirm': 'Install anyway',
  'catalogInstallUnpinnedCancel': 'Cancel',
  'catalogInstallFailed': 'Install failed: ',
```

```ts
  'catalogInstallUnpinnedTitle': '這個條目沒有釘選',
  'catalogInstallUnpinnedDescription': '插件市場沒有為這個插件宣告 commit，因此取得的程式碼就是它的分支今天所指的內容。日後無法拿它與你當時檢視的版本核對。',
  'catalogInstallUnpinnedAcknowledge': '我了解這個條目未釘選',
  'catalogInstallUnpinnedConfirm': '仍要安裝',
  'catalogInstallUnpinnedCancel': '取消',
  'catalogInstallFailed': '安裝失敗：',
```

- [ ] **Step 2: Write the failing test**

```tsx
describe('installing from the catalog', () => {
  const rows = [
    { plugin: 'commit-helper', marketplace: 'official', description: 'commit flow', tags: [], installable: true, installed: false, warnings: [] },
    { plugin: 'loose', marketplace: 'official', description: 'loose flow', tags: [], installable: false, installed: false, warnings: ['source "x" has no sha pin'] },
  ]

  it('installs a pinned entry in one call', async () => {
    const install = vi.fn(async () => ({ plugin: 'commit-helper', sha: 'a'.repeat(40), warnings: [], status: STATUS }))
    render(<MarketplaceSettingsTab {...props({ catalog: vi.fn(async () => ({ rows, failed: [] })), install })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    await screen.findByText('commit-helper')

    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]!)
    await vi.waitFor(() => { expect(install).toHaveBeenCalledWith('commit-helper', false) })
  })

  it('will not install an unpinned entry until it is acknowledged', async () => {
    const install = vi.fn(async () => ({ plugin: 'loose', sha: 'b'.repeat(40), warnings: [], status: STATUS }))
    render(<MarketplaceSettingsTab {...props({ catalog: vi.fn(async () => ({ rows, failed: [] })), install })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    await screen.findByText('loose')

    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[1]!)
    const confirm = await screen.findByRole('button', { name: 'Install anyway' })
    // Unavailable until the box is set: the permission IS the checkbox.
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand this entry is unpinned' }))
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirm)
    await vi.waitFor(() => { expect(install).toHaveBeenCalledWith('loose', true) })
  })

  it('shows a refusal against its own row', async () => {
    const install = vi.fn(async () => { throw new Error('marketplace/unpinned: refused') })
    render(<MarketplaceSettingsTab {...props({ catalog: vi.fn(async () => ({ rows, failed: [] })), install })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    await screen.findByText('commit-helper')
    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]!)
    expect(await screen.findByText('Install failed: marketplace/unpinned: refused')).toBeTruthy()
  })
})
```

Remove the now-duplicated first case from Task 6's block if the suite runs both, so each behavior is pinned once.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/client/ui-settings-marketplace`
Expected: FAIL — no `Install` button exists.

- [ ] **Step 4: Write the implementation**

In `CatalogSection.tsx`, extend the props with `editable`, `onInstall`, `busy`, `failedFor`, and add the control to each row:

```tsx
              {editable
                ? (
                  <div className={css.controls}>
                    <Button
                      variant="outline"
                      disabled={busy !== undefined || row.installed}
                      onClick={() => { onInstall(row) }}
                    >
                      {t('catalogInstall')}
                    </Button>
                    {busy === row.plugin ? <span className={css.muted}>{t('catalogInstalling')}</span> : null}
                  </div>
                )
                : null}
              {failedFor[row.plugin] !== undefined
                ? <p className={css.actionError}>{`${t('catalogInstallFailed')}${failedFor[row.plugin] ?? ''}`}</p>
                : null}
```

and add `'catalogInstalling': 'Installing…'` / `'catalogInstalling': '安裝中…'` to the dictionaries.

In `MarketplaceSettingsTab.tsx`, add the acknowledgement state and the install writer, reusing the `RiskConfirmation` pattern the uninstall control established:

```tsx
  const [confirming, setConfirming] = useState<string | undefined>(undefined)
  const [acknowledged, setAcknowledged] = useState(false)
  const [installing, setInstalling] = useState<string | undefined>(undefined)
  const [installFailures, setInstallFailures] = useState<Readonly<Record<string, string>>>({})

  /** Run one install, then render the status it returned. */
  const runInstall = useCallback(async (plugin: string, allowUnpinned: boolean): Promise<void> => {
    setInstalling(plugin)
    setInstallFailures(current => ({ ...current, [plugin]: '' }))
    try {
      const result = await install(plugin, allowUnpinned)
      setState({ status: 'ready', view: result.status })
      await loadCatalog()
    } catch (error) {
      setInstallFailures(current => ({ ...current, [plugin]: error instanceof Error ? error.message : String(error) }))
    } finally {
      setInstalling(undefined)
    }
  }, [install, loadCatalog])
```

`onInstall` opens the acknowledgement for a row whose `installable` is false and installs directly otherwise:

```tsx
        onInstall={(row) => {
          if (row.installable) { void runInstall(row.plugin, false); return }
          setAcknowledged(false)
          setConfirming(row.plugin)
        }}
        busy={installing}
        failedFor={installFailures}
        editable={allowMutations}
```

and a second `RiskConfirmation` bound to `confirming`:

```tsx
      <RiskConfirmation
        open={confirming !== undefined}
        title={confirming === undefined ? t('catalogInstallUnpinnedTitle') : `${t('catalogInstallUnpinnedTitle')} · ${confirming}`}
        description={t('catalogInstallUnpinnedDescription')}
        acknowledgeLabel={t('catalogInstallUnpinnedAcknowledge')}
        cancelLabel={t('catalogInstallUnpinnedCancel')}
        closeLabel={t('catalogInstallUnpinnedCancel')}
        confirmLabel={t('catalogInstallUnpinnedConfirm')}
        acknowledged={acknowledged}
        disabled={installing !== undefined}
        onAcknowledgedChange={setAcknowledged}
        onCancel={() => { setAcknowledged(false); setConfirming(undefined) }}
        onConfirm={() => {
          const plugin = confirming
          setAcknowledged(false)
          setConfirming(undefined)
          if (plugin === undefined) return
          void runInstall(plugin, true)
        }}
      />
```

In `src/client/index.ts`:

```ts
  const install = (plugin: string, allowUnpinned: boolean): Promise<PluginInstallResultView> =>
    unwrap(() => ctx.remote.marketplace.install({ plugin, allowUnpinned }))
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run packages/client/ui-settings-marketplace`
Expected: PASS.

- [ ] **Step 6: Run the GUI suite**

Run: `pnpm run test:gui`
Expected: passes apart from the two known environment failures.

- [ ] **Step 7: Commit**

```bash
git add packages/client/ui-settings-marketplace
git commit -m "feat(ui-settings-marketplace): install from the catalog behind an unpinned acknowledgement"
```

---

### Task 8: REAL-composition coverage through the Loader

`packages/AGENTS.md` requires a non-unit REAL-composition test for a product-visible plugin, and a hand-built `ctx.plugin(...)` suite does not satisfy it. This package has none, so the requirement is currently unpaid. This task boots a test-only `cordis.yml` through the vendored Loader and asserts against the Remote surface of the service the Loader actually composed. The template is [`packages/host/webserver/tests/webserver.spec.ts`](packages/host/webserver/tests/webserver.spec.ts) lines 30-69; [`packages/host/plugin-inventory/tests/inventory.spec.ts`](packages/host/plugin-inventory/tests/inventory.spec.ts) is the sibling that asserts the Remote method list the same way.

**Files:**
- Create: `packages/host/plugin-marketplace/tests/loader-composition.spec.ts`
- Modify: `packages/host/plugin-marketplace/package.json` (add `@deepseek-ai/cordis-plugin-include` and `@deepseek-ai/cordis-plugin-loader` to `devDependencies`)

**Interfaces:**
- Consumes: `MarketplaceGateway` and its `catalog`, `install`, `status` methods (Task 4).
- Produces: no source change.

- [ ] **Step 1: Write the failing test**

Create `packages/host/plugin-marketplace/tests/loader-composition.spec.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/host/plugin-marketplace/tests/loader-composition.spec.ts`
Expected: FAIL — `Cannot find package '@deepseek-ai/cordis-plugin-include'` until Step 3 adds it. Once it resolves, the first case fails on the two methods Task 4 adds until they exist.

- [ ] **Step 3: Add the two dev dependencies**

```bash
pnpm add -D --filter @deepseek-ai/dsh-host-plugin-marketplace @deepseek-ai/cordis-plugin-include@workspace:^ @deepseek-ai/cordis-plugin-loader@workspace:^
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/host/plugin-marketplace/tests/loader-composition.spec.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/host/plugin-marketplace/tests/loader-composition.spec.ts packages/host/plugin-marketplace/package.json pnpm-lock.yaml
git commit -m "test(marketplace): boot the marketplace row through the real Loader"
```

---

### Task 9: Docs, the note's lifecycle, and the generated artifacts

**Files:**
- Modify: `packages/host/plugin-marketplace/README.md`, `README.zh.md`, `README.i18n.yaml`
- Modify: `packages/client/ui-settings-marketplace/README.md`, `README.zh.md`, `README.i18n.yaml`
- Move: `.agents/notes/proposed/feature/2026-09-12-marketplace-catalog-and-install.{md,zh.md,i18n.yaml}` → `.agents/notes/implemented/feature/`
- Regenerate: whichever generated catalogs report stale

**Interfaces:**
- Consumes: everything above.
- Produces: no code.

- [ ] **Step 1: Update both package READMEs**

In the host README, document the catalog operation, the two Remote methods, the three failure codes, and why browsing is served on a read-only deployment while installing is not. In the client README, replace the sentence describing a two-section panel with the three-section description and the load-on-request rule.

- [ ] **Step 2: Re-record both pairs**

Run: `npx tsx scripts/verify-translation-pairing.ts --write packages/host/plugin-marketplace/README.md packages/client/ui-settings-marketplace/README.md`
Expected: two records written.

- [ ] **Step 3: Move the Agent Note to `implemented/`**

Move the triplet, then rewrite it for its new lifecycle per `.agents/notes/README.md` § Moving between lifecycles:

- `Status: proposed` → `Status: implemented`
- `## Proposal` → `## Decision`, present tense
- Fold `## Acceptance criteria` and `## Risks` into `## Consequences` and a present-tense `## Testing`
- Correct every claim against what actually shipped, including anything this plan got wrong

- [ ] **Step 4: Re-record the moved pair and check the links into it**

Run: `npx tsx scripts/verify-translation-pairing.ts --write .agents/notes/implemented/feature/2026-09-12-marketplace-catalog-and-install.md && pnpm run verify-md-links`
Expected: record written; no broken links. Any note or README that linked to the proposed path is updated in this step.

- [ ] **Step 5: Regenerate any stale generated artifact**

Run: `pnpm run test:docs && pnpm run verify-cordis-catalog && pnpm run verify-client-catalog && pnpm run verify-doc-graphs`
Expected: all pass. For each failure, run its `gen-` counterpart, inspect the diff for plausibility, and commit it. Do not hand-edit a generated English source.

- [ ] **Step 6: Run the standing gates for this surface**

Run: `npx tsc -b tsconfig.host.json && npx tsc -b tsconfig.client.json && pnpm run lint && pnpm run verify-package-dependencies && pnpm run verify-export-jsdoc`
Expected: all exit 0.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs(marketplace): record the catalog and install surface"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: the catalog operation → Task 2; the CLI rewrite and its containment → Task 3; the Remote face, the wire types, and the three failure codes → Task 4; publishing the types → Task 5; the load-on-request section, local filtering, and failure containment → Task 6; the unpinned acknowledgement, the read-only gate, and the post-install render → Task 7; the README pairs and the note lifecycle → Task 9. Both spec alternatives that survived into code (no host-side filtering, no streamed stages) are honored by Tasks 2 and 4. Task 8 carries a repository requirement the spec does not mention — the REAL-composition test `packages/AGENTS.md` demands of a product-visible plugin.

**Placeholder scan.** No step says "handle errors" or "write tests for the above" without the code. One step deliberately defers verification to a later task: Task 4's `allowUnpinned` success path needs a real git remote, so Task 4 pins the refusal and Task 8's manual check covers the opt-in. That is a stated coverage gap, not a placeholder.

**Type consistency.** `CatalogRow` (Task 2) and `CatalogRowView` (Task 4) carry the same field names deliberately: the wire type is a restatement, not a second vocabulary, and the gateway's spread copies between them field-for-field. `MarketplaceFailure`/`MarketplaceFailureView` agree on `marketplace` and `reason`. `install()` returns `PluginInstallResultView.status` as a `MarketplaceStatusView`, the same type `status()` returns, so the panel's existing `ViewState` accepts it unchanged. `InstallRefusal` (Task 1) is the exact key set of `INSTALL_REFUSAL_CODE` (Task 4); adding a refusal without a code fails the type check rather than falling through.

**Coverage the plan does not reach.** Task 8 adds the REAL-composition test this package was missing. It asserts composition and the Remote surface; it does not drive the browser, so the panel's own wiring stays covered by the component suite in Tasks 6 and 7 plus the ssh-free `test:gui` rung. If a reviewer requires an assembled-browser case, that is the `DSH_SNAPSHOT=replay pnpm run test:web` rung, which rebuilds every artifact and is deliberately left to the human partner.
