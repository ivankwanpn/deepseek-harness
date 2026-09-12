/**
 * `dsh plugin marketplace …` — the command surface a user actually types.
 *
 * Every case here drives `runMarketplace` with real arguments and asserts the
 * EXACT text on stdout and stderr plus the exit code, because that text is the
 * only thing the user sees: a refusal that lands on stdout, or a success that
 * exits non-zero, is a broken command however correct the library underneath is.
 * Repeated calls share one harness home, so each case also reads a real effect —
 * the state file, the patch layer and the discovery root — rather than a return
 * value.
 *
 * `DSH_HOME` is redirected per case (the command resolves the real harness home,
 * so without it these cases would write into the developer's own `~/.dsh`) and a
 * `DSH_AGENTS_HOME` override is cleared so the discovery root is always the
 * scratch home's.
 *
 * `../src/git.ts` is stubbed for the two steps that need a network or a clone:
 * a registered recipe leaves in the staging path what that fetch would have
 * left, and `resolveRefSha` reports a fixed commit. Everything else — the
 * manifest read, the pin rule, the staging move, the state record, the patch
 * layer and the skills root — is the real implementation.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MARKETPLACE_USAGE,
  emptyStateForTest,
  isMarketplaceInvocation,
  runMarketplace,
} from '../src/marketplace-command.ts'
import { MCP_CLIENT_MODULE } from '../src/materialize.ts'
import { parsePatchLayer, readEnabled, serializePatchLayer } from '../src/patch-layer.ts'
import type { PluginSource } from '../src/parse.ts'
import {
  defaultStatePath,
  emptyState,
  loadState,
  rowIdFor,
  saveState,
  upsertInstalled,
  upsertMarketplace,
  type InstalledEntry,
} from '../src/state.ts'

const MANIFEST = 'https://example.test/official/marketplace.json'
const EXTRA = 'https://example.test/extra/marketplace.json'
const REPO = 'https://github.com/example/registry'
const REPO_MANIFEST = `${REPO}/raw/main/.claude-plugin/marketplace.json`
const OFFICIAL_MANIFEST = 'https://github.com/anthropics/claude-plugins-official/raw/main/.claude-plugin/marketplace.json'
const PINNED = { source: 'git', url: 'https://example.test/pinned.git', sha: 'a'.repeat(40) }
const LOOSE = { source: 'git', url: 'https://example.test/loose.git' }
const RESOLVED_SHA = 'c'.repeat(40)

/** What a fetch of one source leaves behind, keyed by that source's identity. */
const recipes = vi.hoisted(() => new Map<string, (destination: string) => void>())
/** The commit the stubbed ref resolution names. */
const resolveRefSha = vi.hoisted(() => vi.fn<(url: string, ref?: string) => Promise<string>>())

vi.mock('../src/git.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/git.ts')>()
  return {
    ...actual,
    fetchPlugin: async (source: PluginSource, destination: string) => {
      const key = source.kind === 'git' ? source.url : source.path
      const recipe = recipes.get(key)
      // Refusing an unknown source keeps this suite off the network: a case that
      // wants a fetch must say what that fetch produces.
      if (recipe === undefined) throw new actual.PluginFetchError(`no fetch recipe registered for ${key}`)
      recipe(destination)
      return {
        root: destination,
        capabilities: actual.detectCapabilities(destination),
        resolvedSha: source.kind === 'git' ? (source.sha ?? '') : '',
      }
    },
    resolveRefSha,
  }
})

let scratch: string
let previousHome: string | undefined
let previousAgentsHome: string | undefined
let out: string[]
let err: string[]

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-cli-'))
  recipes.clear()
  previousHome = process.env.DSH_HOME
  previousAgentsHome = process.env.DSH_AGENTS_HOME
  process.env.DSH_HOME = scratch
  delete process.env.DSH_AGENTS_HOME
  out = []
  err = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err.push(String(chunk))
    return true
  })
})

afterEach(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
  else process.env.DSH_AGENTS_HOME = previousAgentsHome
  recipes.clear()
  resolveRefSha.mockReset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  rmSync(scratch, { recursive: true, force: true })
})

/** Everything the command wrote to stdout. */
function stdout(): string {
  return out.join('')
}

/** Everything the command wrote to stderr. */
function stderr(): string {
  return err.join('')
}

/** Drop what earlier calls in the same case printed. */
function reset(): void {
  out = []
  err = []
}

/** The state file the command reads and writes. */
function statePath(): string {
  return defaultStatePath(scratch)
}

/** The patch layer the command composes into. */
function patchLayerPath(): string {
  return join(scratch, 'cordis.patch.yml')
}

/** The discovery root an isolated harness home resolves to. */
function skillsRoot(): string {
  return join(scratch, 'agents-skills')
}

/** Route every fetch by url; a url with no entry fails the way an outage does. */
function serve(byUrl: Readonly<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const body = byUrl[String(input)]
    if (body === undefined) throw new TypeError('connection refused')
    return new Response(JSON.stringify(body), { status: 200 })
  })
}

/** Seed the state file the command reads, rather than building it through `add`. */
function seedState(
  registrations: readonly (readonly [string, string])[],
  installed: readonly InstalledEntry[] = [],
): void {
  let state = emptyState()
  for (const [name, url] of registrations) state = upsertMarketplace(state, name, url)
  for (const entry of installed) state = upsertInstalled(state, entry)
  saveState(statePath(), state)
}

/** One installed record, as the state file carries it. */
function installedRecord(
  plugin: string,
  overrides: Partial<InstalledEntry> & Pick<InstalledEntry, 'rowIds' | 'skillIds'>,
): InstalledEntry {
  return {
    id: rowIdFor(plugin),
    marketplace: 'official',
    plugin,
    sourceUrl: PINNED.url,
    installPath: join(scratch, 'marketplace', 'plugins', plugin),
    capabilities: [],
    installedAt: new Date(0).toISOString(),
    ...overrides,
  }
}

/** A live discovery-root entry, the placement a sync leaves an enabled skill in. */
function liveSkill(name: string): void {
  mkdirSync(join(skillsRoot(), name), { recursive: true })
  writeFileSync(join(skillsRoot(), name, 'SKILL.md'), `---\nname: ${name}\ndescription: Fixture.\n---\n\nBody.\n`, 'utf8')
}

describe('marketplace usage', () => {
  it('prints the usage block and refuses when no subcommand was given', async () => {
    expect(await runMarketplace([])).toBe(1)
    expect(stdout()).toBe(`${MARKETPLACE_USAGE}\n`)
    expect(stderr()).toBe('')
  })

  it('prints the same block and succeeds for every help word', async () => {
    for (const word of ['help', '--help', '-h']) {
      reset()
      expect(await runMarketplace([word])).toBe(0)
      expect(stdout()).toBe(`${MARKETPLACE_USAGE}\n`)
      expect(stderr()).toBe('')
    }
  })

  it('refuses an unknown subcommand, naming it', async () => {
    expect(await runMarketplace(['frobnicate'])).toBe(1)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`dsh: unknown marketplace command "frobnicate"\n${MARKETPLACE_USAGE}\n`)
  })

  it('selects the marketplace mode only on its own leading word', () => {
    expect(isMarketplaceInvocation(['marketplace', 'list'])).toBe(true)
    expect(isMarketplaceInvocation(['add', 'obra/superpowers'])).toBe(false)
    expect(isMarketplaceInvocation([])).toBe(false)
  })

  it('hands a caller a fresh empty state instead of a shared one', () => {
    const first = emptyStateForTest()
    const second = emptyStateForTest()
    expect(first).toEqual(emptyState())
    expect(first).not.toBe(second)
    expect(first.marketplaces).not.toBe(second.marketplaces)
  })
})

describe('marketplace add', () => {
  it('registers a manifest url and reports what that marketplace lists', async () => {
    serve({
      [MANIFEST]: {
        name: 'official',
        plugins: [{ name: 'one', source: PINNED }, { name: 'two', source: PINNED }],
      },
    })

    expect(await runMarketplace(['add', MANIFEST])).toBe(0)

    expect(stdout()).toBe(`registered official (2 plugins)\n  from ${MANIFEST}\n`)
    expect(stderr()).toBe('')
    expect(loadState(statePath()).marketplaces).toEqual([{ name: 'official', url: MANIFEST }])
  })

  it('resolves the owner/repo shorthand to the conventional manifest location', async () => {
    serve({ [REPO_MANIFEST]: { name: 'registry', plugins: [{ name: 'one', source: PINNED }] } })

    expect(await runMarketplace(['add', 'example/registry'])).toBe(0)

    // What is stored is the url the manifest was READ from, so no later command
    // has to guess a location again.
    expect(stdout()).toBe(`registered registry (1 plugins)\n  from ${REPO_MANIFEST}\n`)
    expect(loadState(statePath()).marketplaces).toEqual([{ name: 'registry', url: REPO_MANIFEST }])
  })

  it('expands the official alias without asking the user for a url', async () => {
    serve({ [OFFICIAL_MANIFEST]: { name: 'official', plugins: [] } })

    expect(await runMarketplace(['add', 'Official'])).toBe(0)

    expect(stdout()).toBe(`registered official (0 plugins)\n  from ${OFFICIAL_MANIFEST}\n`)
  })

  it('refuses add without a repository', async () => {
    expect(await runMarketplace(['add'])).toBe(1)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('dsh: marketplace add requires a repository or url\n')
  })

  it('takes a bare .json spec as a manifest reference and records it verbatim', async () => {
    // Neither a url nor an owner/repo pair, so the spec is passed through
    // unchanged and the fetch layer reads it as the manifest document.
    serve({ 'registry.json': { name: 'local', plugins: [{ name: 'one', source: PINNED }] } })

    expect(await runMarketplace(['add', 'registry.json'])).toBe(0)

    expect(stdout()).toBe('registered local (1 plugins)\n  from registry.json\n')
    expect(loadState(statePath()).marketplaces).toEqual([{ name: 'local', url: 'registry.json' }])
  })

  it('reports an ssh spec it cannot fetch instead of rejecting', async () => {
    // An ssh spec is neither a manifest url nor a GitHub repository the fetch
    // layer can expand, so nothing is registered and nothing is written. The
    // failure is REPORTED the way install reports one: an escaping rejection
    // reaches bin.ts's `process.exit(await …)` as an unhandled rejection rather
    // than as the diagnostic this surface exists to print.
    expect(await runMarketplace(['add', 'git@github.com:example/registry.git'])).toBe(1)
    expect(stderr()).toContain('neither a manifest url')
    expect(existsSync(statePath())).toBe(false)
  })
})

describe('marketplace list', () => {
  it('says when nothing is registered', async () => {
    expect(await runMarketplace(['list'])).toBe(0)
    expect(stdout()).toBe('no marketplaces registered\n')
  })

  it('lists every registration in stored order', async () => {
    seedState([['official', MANIFEST], ['extra', EXTRA]])

    expect(await runMarketplace(['list'])).toBe(0)
    expect(stdout()).toBe(`official\t${MANIFEST}\nextra\t${EXTRA}\n`)
  })
})

describe('marketplace install', () => {
  it('refuses an option it does not know', async () => {
    expect(await runMarketplace(['install', 'demo', '--force'])).toBe(1)
    expect(stdout()).toBe('')
    expect(stderr()).toBe(`dsh: unknown marketplace install option --force\n${MARKETPLACE_USAGE}\n`)
  })

  it('refuses an install with no plugin name', async () => {
    expect(await runMarketplace(['install'])).toBe(1)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('dsh: marketplace install requires a plugin name\n')
  })

  it('reports an installer refusal on stderr and exits non-zero', async () => {
    seedState([['official', MANIFEST]])
    serve({ [MANIFEST]: { name: 'official', plugins: [] } })

    expect(await runMarketplace(['install', 'absent'])).toBe(1)

    expect(stdout()).toBe('')
    expect(stderr()).toBe('dsh: no marketplace lists a plugin named "absent"\n')
  })

  it('installs a pinned plugin and prints what it carries and mounted', async () => {
    seedState([['official', MANIFEST]])
    serve({ [MANIFEST]: { name: 'official', plugins: [{ name: 'pinned', source: PINNED }] } })
    recipes.set(PINNED.url, (destination) => {
      mkdirSync(join(destination, 'commands'), { recursive: true })
    })

    expect(await runMarketplace(['install', 'pinned'])).toBe(0)

    expect(stdout()).toBe([
      'installed pinned from official',
      `  content     ${join(scratch, 'marketplace', 'plugins', 'pinned')}`,
      `  pinned      ${PINNED.sha}`,
      '  carries     commands',
      '  mounted     no loader rows (skills are discovered from the filesystem)',
      '',
    ].join('\n'))
    expect(stderr()).toBe('')
    expect(loadState(statePath()).installed[0]).toMatchObject({ plugin: 'pinned', sha: PINNED.sha })
  })

  it('names the loader rows an MCP server mounted', async () => {
    seedState([['official', MANIFEST]])
    serve({ [MANIFEST]: { name: 'official', plugins: [{ name: 'serverish', source: PINNED }] } })
    recipes.set(PINNED.url, (destination) => {
      mkdirSync(destination, { recursive: true })
      writeFileSync(
        join(destination, '.mcp.json'),
        JSON.stringify({ mcpServers: { srv: { command: 'npx', args: ['-y', 'thing'] } } }),
        'utf8',
      )
    })

    expect(await runMarketplace(['install', 'serverish'])).toBe(0)

    expect(stdout()).toBe([
      'installed serverish from official',
      `  content     ${join(scratch, 'marketplace', 'plugins', 'serverish')}`,
      `  pinned      ${PINNED.sha}`,
      '  carries     mcp',
      '  mounted     1 row(s)',
      '    marketplace:mcp:srv',
      '',
    ].join('\n'))
  })

  it('says a plugin that carries nothing will mount nothing', async () => {
    seedState([['official', MANIFEST]])
    serve({ [MANIFEST]: { name: 'official', plugins: [{ name: 'inert', source: PINNED }] } })
    recipes.set(PINNED.url, destination => mkdirSync(destination, { recursive: true }))

    expect(await runMarketplace(['install', 'inert'])).toBe(0)

    expect(stdout()).toContain('  carries     nothing mountable')
    expect(stdout()).toContain('  mounted     no loader rows (skills are discovered from the filesystem)')
    // The warning is the user's only notice that this install mounts nothing.
    expect(stderr()).toBe(
      'dsh: inert declares no skills, commands, MCP servers or runtime entry; it will install but mount nothing\n',
    )
  })

  it('prints the commit a --allow-unpinned install recorded', async () => {
    seedState([['official', MANIFEST]])
    serve({ [MANIFEST]: { name: 'official', plugins: [{ name: 'loose', source: LOOSE }] } })

    // The default arm refuses before any remote is asked anything.
    expect(await runMarketplace(['install', 'loose'])).toBe(1)
    expect(stderr()).toContain('has no sha pin')
    expect(resolveRefSha).not.toHaveBeenCalled()
    reset()

    // The flag may appear on either side of the name.
    resolveRefSha.mockResolvedValue(RESOLVED_SHA)
    recipes.set(LOOSE.url, (destination) => {
      mkdirSync(join(destination, 'commands'), { recursive: true })
    })
    expect(await runMarketplace(['install', '--allow-unpinned', 'loose'])).toBe(0)

    expect(resolveRefSha).toHaveBeenCalledWith(LOOSE.url, 'HEAD')
    expect(stdout()).toContain(`  pinned      ${RESOLVED_SHA}`)
    expect(loadState(statePath()).installed[0]?.sha).toBe(RESOLVED_SHA)
  })

  it('prints a local source as having no commit to show', async () => {
    seedState([['official', MANIFEST]])
    serve({ [MANIFEST]: { name: 'official', plugins: [{ name: 'localish', source: './plugins/localish' }] } })
    recipes.set('./plugins/localish', (destination) => {
      mkdirSync(join(destination, 'commands'), { recursive: true })
    })

    expect(await runMarketplace(['install', 'localish'])).toBe(0)

    expect(stdout()).toContain('  pinned      (local source)')
    expect(stderr()).toBe('')
  })

  it('reports a fetch fault that is not an Error by its text', async () => {
    seedState([['official', MANIFEST]])
    serve({ [MANIFEST]: { name: 'official', plugins: [{ name: 'broken', source: PINNED }] } })
    const fault: unknown = 'disk exploded'
    recipes.set(PINNED.url, () => {
      throw fault
    })

    expect(await runMarketplace(['install', 'broken'])).toBe(1)

    expect(stdout()).toBe('')
    expect(stderr()).toBe('dsh: disk exploded\n')
  })
})

describe('marketplace uninstall', () => {
  it('refuses uninstall without a plugin name', async () => {
    expect(await runMarketplace(['uninstall'])).toBe(1)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('dsh: marketplace uninstall requires a plugin name\n')
  })

  it('removes the content, the record and the skills, then reports the second try', async () => {
    seedState([['official', MANIFEST]])
    serve({ [MANIFEST]: { name: 'official', plugins: [{ name: 'doomed', source: PINNED }] } })
    recipes.set(PINNED.url, (destination) => {
      mkdirSync(join(destination, 'skills', 'doomed-skill'), { recursive: true })
      writeFileSync(
        join(destination, 'skills', 'doomed-skill', 'SKILL.md'),
        '---\nname: doomed-skill\ndescription: Fixture.\n---\n\nBody.\n',
        'utf8',
      )
    })
    expect(await runMarketplace(['install', 'doomed'])).toBe(0)
    const installPath = join(scratch, 'marketplace', 'plugins', 'doomed')
    expect(existsSync(join(skillsRoot(), 'doomed-skill'))).toBe(true)
    reset()

    expect(await runMarketplace(['uninstall', 'doomed'])).toBe(0)

    expect(stdout()).toBe('uninstalled doomed\n')
    expect(existsSync(installPath)).toBe(false)
    // Materialized skills live in the shared discovery root, not under the
    // plugin directory, so only the record makes them removable.
    expect(existsSync(join(skillsRoot(), 'doomed-skill'))).toBe(false)
    expect(loadState(statePath()).installed).toEqual([])

    reset()
    expect(await runMarketplace(['uninstall', 'doomed'])).toBe(1)
    expect(stdout()).toBe('doomed is not installed\n')
  })
})

describe('marketplace installed', () => {
  it('says when it has installed nothing', async () => {
    seedState([['official', MANIFEST]])

    expect(await runMarketplace(['installed'])).toBe(0)
    expect(stdout()).toBe('nothing installed from a marketplace\n')
  })

  it('reports how each installed plugin is mounted, and what carries it', async () => {
    seedState([['official', MANIFEST]], [
      installedRecord('alpha', {
        rowIds: ['marketplace:mcp:alpha'],
        skillIds: [],
        sha: 'a'.repeat(40),
        capabilities: ['mcp'],
      }),
      installedRecord('beta', { rowIds: [], skillIds: [], capabilities: ['skills'] }),
      installedRecord('gamma', { rowIds: ['marketplace:mcp:gamma'], skillIds: [], capabilities: ['mcp'] }),
      installedRecord('delta', { rowIds: ['marketplace:mcp:delta'], skillIds: [], capabilities: ['mcp'] }),
      installedRecord('epsilon', { rowIds: [], skillIds: [], capabilities: [] }),
    ])
    // Enablement lives in the patch layer and nowhere else, so this is the only
    // input that decides enabled/disabled/not-mounted.
    writeFileSync(patchLayerPath(), serializePatchLayer([
      { insert: [{ id: 'marketplace:mcp:alpha', name: MCP_CLIENT_MODULE }] },
      { insert: [{ id: 'marketplace:mcp:gamma', name: MCP_CLIENT_MODULE, disabled: true }] },
    ]), 'utf8')

    expect(await runMarketplace(['installed'])).toBe(0)

    expect(stdout()).toBe([
      `alpha\tenabled\tmcp\n    official @ ${'a'.repeat(40)}\n`,
      'beta\tno-rows\tskills\n    official @ (local source)\n',
      'gamma\tdisabled\tmcp\n    official @ (local source)\n',
      'delta\tnot-mounted\tmcp\n    official @ (local source)\n',
      'epsilon\tno-rows\t-\n    official @ (local source)\n',
    ].join(''))
  })
})

describe('marketplace enable and disable', () => {
  it('refuses a toggle without a plugin name, naming the verb', async () => {
    expect(await runMarketplace(['enable'])).toBe(1)
    expect(stderr()).toBe('dsh: marketplace enable requires a plugin name\n')

    reset()
    expect(await runMarketplace(['disable'])).toBe(1)
    expect(stderr()).toBe('dsh: marketplace disable requires a plugin name\n')
  })

  it('refuses a plugin it has no record for', async () => {
    seedState([['official', MANIFEST]])

    expect(await runMarketplace(['disable', 'ghost'])).toBe(1)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('dsh: ghost is not installed\n')
  })

  it('reports a plugin that mounts nothing instead of pretending a toggle applied', async () => {
    seedState([['official', MANIFEST]], [installedRecord('inert', { rowIds: [], skillIds: [] })])

    expect(await runMarketplace(['disable', 'inert'])).toBe(1)
    expect(stdout()).toBe('')
    expect(stderr()).toBe('dsh: inert mounts nothing (no runtime row and no skills)\n')
  })

  it('toggles the loader row and the discovery entry together, and reports each state', async () => {
    seedState([['official', MANIFEST]], [
      installedRecord('demo', {
        rowIds: ['marketplace:mcp:demo'],
        skillIds: ['demo-skill'],
        capabilities: ['skills', 'mcp'],
      }),
    ])
    writeFileSync(patchLayerPath(), serializePatchLayer([
      { insert: [{ id: 'marketplace:mcp:demo', name: MCP_CLIENT_MODULE }] },
    ]), 'utf8')
    liveSkill('demo-skill')

    expect(await runMarketplace(['disable', 'demo'])).toBe(0)
    expect(stdout()).toBe('disabled demo (1 runtime row(s), skills)\n')
    // Both mechanisms really moved: the flag in the patch layer and the skill
    // out of the discovery root.
    expect(readEnabled(parsePatchLayer(patchLayerPath()).patches, 'marketplace:mcp:demo')).toBe(false)
    expect(existsSync(join(skillsRoot(), 'demo-skill'))).toBe(false)
    expect(existsSync(join(skillsRoot(), '.disabled', 'demo', 'demo-skill'))).toBe(true)

    // Already in the requested state: success, because the end state holds.
    reset()
    expect(await runMarketplace(['disable', 'demo'])).toBe(0)
    expect(stdout()).toBe('demo is already disabled\n')

    reset()
    expect(await runMarketplace(['enable', 'demo'])).toBe(0)
    expect(stdout()).toBe('enabled demo (1 runtime row(s), skills)\n')
    expect(readEnabled(parsePatchLayer(patchLayerPath()).patches, 'marketplace:mcp:demo')).toBe(true)
    expect(existsSync(join(skillsRoot(), 'demo-skill'))).toBe(true)

    reset()
    expect(await runMarketplace(['enable', 'demo'])).toBe(0)
    expect(stdout()).toBe('demo is already enabled\n')
  })

  it('names only the mechanism a toggle actually moved', async () => {
    seedState([['official', MANIFEST]], [
      installedRecord('skills-only', { rowIds: [], skillIds: ['solo'], capabilities: ['skills'] }),
    ])
    liveSkill('solo')
    expect(await runMarketplace(['disable', 'skills-only'])).toBe(0)
    expect(stdout()).toBe('disabled skills-only (skills)\n')

    reset()
    seedState([['official', MANIFEST]], [
      installedRecord('rows-only', { rowIds: ['marketplace:mcp:rows'], skillIds: [], capabilities: ['mcp'] }),
    ])
    writeFileSync(patchLayerPath(), serializePatchLayer([
      { insert: [{ id: 'marketplace:mcp:rows', name: MCP_CLIENT_MODULE }] },
    ]), 'utf8')
    expect(await runMarketplace(['disable', 'rows-only'])).toBe(0)
    expect(stdout()).toBe('disabled rows-only (1 runtime row(s))\n')
  })
})
