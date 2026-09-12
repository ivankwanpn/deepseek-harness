/**
 * Behavioural cover for capability → surface mapping.
 *
 * Materialization is the step where a third-party plugin's file tree becomes
 * DSH's own surfaces, and every rule asserted here is one the README records a
 * failure for: MCP servers become loader rows keyed on the SANITIZED server
 * name, skills are copied FLAT into the single directory `skill-filesystem`
 * reads, a disabled plugin's skills are parked rather than deleted, and the two
 * cleanup functions differ in exactly one way — uninstall may take the parking
 * directory, a sync may not, because that directory is a disabled plugin's only
 * copy of its skills. Each assertion is made against real files under a temp
 * root, or against the value a later read reports, never against an
 * implementation detail.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MCP_CLIENT_MODULE,
  defaultAgentsSkillsDir,
  disabledSkillsDir,
  materializeEntry,
  materializeSkills,
  normalizeMcpServers,
  readPluginMcp,
  removeMaterializedSkills,
  removePluginSkills,
  sanitizeServerName,
  setSkillsEnabled,
  skillEntryNames,
  skillsEnabled,
  skillsRootDir,
  type MaterializeOptions,
} from '../src/materialize.ts'
import { rowIdFor, type InstalledEntry } from '../src/state.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-materialize-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The skills root these tests materialize into, pinned so nothing escapes them. */
function options(): MaterializeOptions {
  return { harnessHome: scratch, agentsSkillsDir: join(scratch, '.agents', 'skills') }
}

/** The discovery root `options()` names. */
function root(): string {
  return join(scratch, '.agents', 'skills')
}

/**
 * A plugin directory shipping one discoverable skill per name.
 *
 * @param plugin - directory name under the scratch install root.
 * @param skills - skill directory name to frontmatter description.
 * @returns the plugin's directory.
 */
function pluginWithSkills(plugin: string, skills: Record<string, string>): string {
  const installPath = join(scratch, 'plugins', plugin)
  for (const [name, description] of Object.entries(skills)) {
    const dir = join(installPath, 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`, 'utf8')
  }
  return installPath
}

/** An installed record for a plugin directory, with no ownership recorded yet. */
function entryFor(plugin: string, installPath: string, capabilities: InstalledEntry['capabilities'] = []): InstalledEntry {
  return {
    id: rowIdFor(plugin),
    marketplace: 'test',
    plugin,
    sourceUrl: 'https://example.test/plugin.git',
    installPath,
    capabilities,
    installedAt: new Date(0).toISOString(),
  }
}

describe('normalizeMcpServers', () => {
  it('mounts every shape a .mcp.json uses in the wild and reports what it cannot', () => {
    const warnings: string[] = []
    const servers = normalizeMcpServers({
      mcpServers: {
        stdio: { command: 'npx', args: ['-y', 'pkg'] },
        'array-command': { command: ['node', 'server.js'] },
        'one-element': { command: ['node'] },
        'non-string-argv': { command: ['node', 5], url: 'https://example.test/argv' },
        bare: { command: 'plain' },
        'with-env': { command: 'env-server', env: { KEEP: 'yes', DROP: 7 }, cwd: '/work/dir' },
        'empty-env': { command: 'empty-env', env: { DROP: 7 } },
        'null-env': { command: 'null-env', env: null, environment: null },
        remote: { url: 'https://example.test/remote', headers: { Authorization: 'Bearer t', 'x-drop': 3 } },
        'remote-bare': { url: 'https://example.test/plain', headers: null },
        'empty-headers': { url: 'https://example.test/empty', headers: { 'x-drop': 3 } },
        'empty-args': { command: 'empty-args', args: [] },
        skipped: { description: 'neither a command nor a url' },
        'not-an-object': 'nope',
      },
    }, warnings)

    expect(servers).toEqual([
      { name: 'stdio', command: 'npx', args: ['-y', 'pkg'] },
      // An array command is an executable plus separate args.
      { name: 'array-command', command: 'node', args: ['server.js'] },
      { name: 'one-element', command: 'node' },
      // Not every element is a string, so the array is not a command; the url
      // arm still mounts it rather than dropping the server.
      { name: 'non-string-argv', url: 'https://example.test/argv' },
      { name: 'bare', command: 'plain' },
      // `environment` is the key some manifests use; `env: null` must not be
      // read as a table, and a table whose values are not strings is dropped.
      { name: 'with-env', command: 'env-server', env: { KEEP: 'yes' }, cwd: '/work/dir' },
      { name: 'empty-env', command: 'empty-env' },
      { name: 'null-env', command: 'null-env' },
      { name: 'remote', url: 'https://example.test/remote', headers: { Authorization: 'Bearer t' } },
      { name: 'remote-bare', url: 'https://example.test/plain' },
      { name: 'empty-headers', url: 'https://example.test/empty' },
      { name: 'empty-args', command: 'empty-args' },
    ])
    expect(warnings).toEqual(['mcp server "skipped" has neither a command nor a url; skipped'])
  })

  it('accepts the bare {name: spec} shape and refuses a document that is not an object', () => {
    // Both document shapes occur: `{ mcpServers: {...} }` and a bare table.
    expect(normalizeMcpServers({ solo: { command: 'x' } }, [])).toEqual([{ name: 'solo', command: 'x' }])
    // A plugin shipping no MCP server is a normal shape, not an error.
    expect(normalizeMcpServers('not a document', [])).toEqual([])
    expect(normalizeMcpServers(null, [])).toEqual([])
  })
})

describe('sanitizeServerName', () => {
  it('coerces a third-party name into the namespace DSH allows and reports it', () => {
    const warnings: string[] = []
    const tooLong = 'm'.repeat(40)

    expect(sanitizeServerName('My Server!', warnings)).toBe('My-Server-')
    expect(sanitizeServerName(tooLong, warnings)).toBe('m'.repeat(32))
    // A name that cleans up to nothing still has to be mountable.
    expect(sanitizeServerName('', warnings)).toBe('server')
    expect(warnings).toEqual([
      'mcp server name "My Server!" → "My-Server-" (DSH requires [A-Za-z0-9_-]{1,32})',
      `mcp server name ${JSON.stringify(tooLong)} → ${JSON.stringify('m'.repeat(32))} (DSH requires [A-Za-z0-9_-]{1,32})`,
      'mcp server name "" → "server" (DSH requires [A-Za-z0-9_-]{1,32})',
    ])
  })

  it('reports nothing for a name that already fits', () => {
    const warnings: string[] = []
    expect(sanitizeServerName('aikido-mcp', warnings)).toBe('aikido-mcp')
    expect(warnings).toEqual([])
  })
})

describe('readPluginMcp', () => {
  it('reads a real .mcp.json from disk and treats a missing one as no servers', () => {
    const installPath = join(scratch, 'plugins', 'with-mcp')
    mkdirSync(installPath, { recursive: true })
    writeFileSync(
      join(installPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { alpha: { command: 'npx', args: ['-y', 'pkg'] } } }),
      'utf8',
    )
    const warnings: string[] = []

    expect(readPluginMcp(installPath, warnings)).toEqual([{ name: 'alpha', command: 'npx', args: ['-y', 'pkg'] }])
    expect(readPluginMcp(join(scratch, 'plugins', 'absent'), warnings)).toEqual([])
    expect(warnings).toEqual([])
  })

  it('reports an unparseable .mcp.json instead of aborting the install', () => {
    const installPath = join(scratch, 'plugins', 'broken-mcp')
    mkdirSync(installPath, { recursive: true })
    writeFileSync(join(installPath, '.mcp.json'), '{ not json', 'utf8')
    const warnings: string[] = []

    expect(readPluginMcp(installPath, warnings)).toEqual([])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('.mcp.json could not be parsed:')
  })

  it('formats a throwable that is not an Error', () => {
    // The collector is the caller's array, and the probe mutates it; a collector
    // that throws is the only way a non-Error reaches this catch, and the
    // documented contract is that ANY failure here is reported rather than
    // propagated.
    const installPath = join(scratch, 'plugins', 'hostile-collector')
    mkdirSync(installPath, { recursive: true })
    writeFileSync(
      join(installPath, '.mcp.json'),
      JSON.stringify({ mcpServers: { unusable: { description: 'no command, no url' } } }),
      'utf8',
    )
    const recorded: string[] = []
    let pushes = 0
    const collector = {
      push(...messages: string[]): number {
        pushes += 1
        if (pushes === 1) throw 'a throwable that is not an Error'
        recorded.push(...messages)
        return recorded.length
      },
    } as unknown as string[]

    expect(readPluginMcp(installPath, collector)).toEqual([])
    expect(recorded).toEqual(['.mcp.json could not be parsed: a throwable that is not an Error'])
  })
})

describe('the rows one installed entry mounts', () => {
  it('composes one row per MCP server, with the transport the server declares', () => {
    const installPath = join(scratch, 'plugins', 'rows')
    mkdirSync(installPath, { recursive: true })
    writeFileSync(join(installPath, '.mcp.json'), JSON.stringify({
      mcpServers: {
        'stdio-full': { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: 't' }, cwd: '/work' },
        'stdio-bare': { command: 'node' },
        'remote-full': { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
        'remote-bare': { url: 'https://example.test/plain' },
      },
    }), 'utf8')

    const result = materializeEntry(entryFor('rows', installPath, ['mcp']), options())

    expect(result.rowIds).toEqual([
      'marketplace:mcp:stdio-full',
      'marketplace:mcp:stdio-bare',
      'marketplace:mcp:remote-full',
      'marketplace:mcp:remote-bare',
    ])
    expect(result.mcpServers).toEqual(['stdio-full', 'stdio-bare', 'remote-full', 'remote-bare'])
    expect(result.rows).toEqual([
      {
        id: 'marketplace:mcp:stdio-full',
        name: MCP_CLIENT_MODULE,
        config: {
          serverName: 'stdio-full',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'pkg'],
          env: { TOKEN: 't' },
          cwd: '/work',
        },
      },
      {
        id: 'marketplace:mcp:stdio-bare',
        name: MCP_CLIENT_MODULE,
        config: { serverName: 'stdio-bare', transport: 'stdio', command: 'node' },
      },
      {
        id: 'marketplace:mcp:remote-full',
        name: MCP_CLIENT_MODULE,
        config: { serverName: 'remote-full', transport: 'streamable-http', url: 'https://example.test/mcp', headers: { Authorization: 'Bearer t' } },
      },
      {
        id: 'marketplace:mcp:remote-bare',
        name: MCP_CLIENT_MODULE,
        config: { serverName: 'remote-bare', transport: 'streamable-http', url: 'https://example.test/plain' },
      },
    ])
    expect(result.warnings).toEqual([])
  })

  it('reports the capabilities, on disk, that the install did not record', () => {
    // `commands/` is detected but never materialized, so it must still count in
    // the comparison — omitting it made every plugin shipping one announce a
    // change on every sync forever.
    const installPath = join(scratch, 'plugins', 'commands')
    mkdirSync(join(installPath, 'commands'), { recursive: true })
    expect(materializeEntry(entryFor('commands', installPath, ['commands']), options()).warnings).toEqual([])

    // A carrier whose contents are unusable is still the carrier. Install reads
    // the capability from the FILE (detectCapabilities), so a sync that read it
    // from the usable servers instead announced "recorded mcp, found none" on
    // every run for a .mcp.json declaring nothing it can mount.
    const carrierPath = join(scratch, 'plugins', 'carrier')
    mkdirSync(carrierPath, { recursive: true })
    writeFileSync(join(carrierPath, '.mcp.json'), JSON.stringify({ mcpServers: { unusable: {} } }), 'utf8')
    const carrier = materializeEntry(entryFor('carrier', carrierPath, ['mcp']), options())
    expect(carrier.rows).toEqual([])
    expect(carrier.warnings.join(' ')).not.toContain('capabilities changed')

    // A genuinely different set is still reported, in both directions.
    const skillsPath = pluginWithSkills('shrunk', { solo: 'Only one.' })
    expect(materializeEntry(entryFor('shrunk', skillsPath, ['mcp']), options()).warnings.join(' '))
      .toContain('capabilities changed on disk since install (recorded mcp, found skills)')

    // A record that detected nothing at install, against a directory that has
    // grown one since: "none" is spelled out rather than left blank.
    expect(materializeEntry(entryFor('shrunk', skillsPath, []), options()).warnings.join(' '))
      .toContain('capabilities changed on disk since install (recorded none, found skills)')

    const emptyPath = join(scratch, 'plugins', 'empty')
    mkdirSync(emptyPath, { recursive: true })
    expect(materializeEntry(entryFor('empty', emptyPath, ['mcp']), options()).warnings.join(' '))
      .toContain('capabilities changed on disk since install (recorded mcp, found none)')
  })
})

describe('where discovered skills live', () => {
  let savedAgentsHome: string | undefined

  beforeEach(() => {
    savedAgentsHome = process.env.DSH_AGENTS_HOME
  })

  afterEach(() => {
    if (savedAgentsHome === undefined) delete process.env.DSH_AGENTS_HOME
    else process.env.DSH_AGENTS_HOME = savedAgentsHome
  })

  it('derives the .agents sibling of a .dsh harness home', () => {
    delete process.env.DSH_AGENTS_HOME
    const harnessHome = join(scratch, 'profile', '.dsh')

    expect(defaultAgentsSkillsDir(harnessHome)).toBe(join(scratch, 'profile', '.agents', 'skills'))
    // An isolated root keeps everything under itself: writing into a real user's
    // ~/.agents from a sandboxed run would be a genuine side effect.
    expect(defaultAgentsSkillsDir(join(scratch, 'isolated'))).toBe(join(scratch, 'isolated', 'agents-skills'))
    // An explicit root always wins.
    expect(skillsRootDir({ harnessHome, agentsSkillsDir: join(scratch, 'pinned') })).toBe(join(scratch, 'pinned'))
  })

  it('follows DSH_AGENTS_HOME, because that is the root the provider reads', () => {
    const agentsHome = join(scratch, 'pinned-agents')
    process.env.DSH_AGENTS_HOME = agentsHome
    expect(defaultAgentsSkillsDir(join(scratch, 'profile', '.dsh'))).toBe(join(agentsHome, 'skills'))

    // A blank value is not a root; the derivation continues as if it were unset.
    process.env.DSH_AGENTS_HOME = '   '
    expect(defaultAgentsSkillsDir(join(scratch, 'profile', '.dsh'))).toBe(join(scratch, 'profile', '.agents', 'skills'))
  })

  it('materializes into the root DSH_AGENTS_HOME names', () => {
    const agentsHome = join(scratch, 'env-agents')
    process.env.DSH_AGENTS_HOME = agentsHome
    const installPath = pluginWithSkills('env-rooted', { solo: 'Pinned root.' })

    const result = materializeEntry(entryFor('env-rooted', installPath, ['skills']), { harnessHome: scratch })

    expect(result.skillIds).toEqual(['solo'])
    expect(readFileSync(join(agentsHome, 'skills', 'solo', 'SKILL.md'), 'utf8')).toContain('Pinned root.')
    expect(existsSync(join(scratch, 'agents-skills'))).toBe(false)
  })
})

describe('materializing skills into the discovery root', () => {
  it('copies each discoverable entry flat and reports the ones discovery cannot see', () => {
    const installPath = pluginWithSkills('flat', { alpha: 'First.' })
    // A directory without a top-level SKILL.md, and a non-Markdown file.
    mkdirSync(join(installPath, 'skills', 'docs'), { recursive: true })
    writeFileSync(join(installPath, 'skills', 'notes.txt'), 'not a skill', 'utf8')

    const result = materializeSkills(installPath, options(), 'flat', [])

    expect(result.skillIds).toEqual(['alpha'])
    expect(result.warnings).toEqual([
      'skills/docs ships no SKILL.md and is not discoverable, so it was not materialized',
      'skills/notes.txt ships no SKILL.md and is not discoverable, so it was not materialized',
    ])
    expect(readFileSync(join(root(), 'alpha', 'SKILL.md'), 'utf8')).toContain('First.')
    expect(existsSync(join(root(), 'docs'))).toBe(false)
    expect(existsSync(join(root(), 'notes.txt'))).toBe(false)
  })

  it('replaces an owned entry so an upgrade cannot leave the old revision behind', () => {
    const installPath = pluginWithSkills('upgrade', { solo: 'Revision one.' })
    materializeSkills(installPath, options(), 'upgrade', [])
    expect(readFileSync(join(root(), 'solo', 'SKILL.md'), 'utf8')).toContain('Revision one.')

    writeFileSync(
      join(installPath, 'skills', 'solo', 'SKILL.md'),
      '---\nname: solo\ndescription: Revision two.\n---\n\nBody.\n',
      'utf8',
    )
    materializeSkills(installPath, options(), 'upgrade', ['solo'])

    expect(readFileSync(join(root(), 'solo', 'SKILL.md'), 'utf8')).toContain('Revision two.')
  })

  it('reports a name another plugin already owns instead of overwriting it', () => {
    const first = pluginWithSkills('first-owner', { shared: 'From the first plugin.' })
    const second = pluginWithSkills('second-owner', { shared: 'From the second plugin.' })
    materializeSkills(first, options(), 'first-owner', [])

    const result = materializeSkills(second, options(), 'second-owner', [], new Map([['shared', 'first-owner']]))

    expect(result.skillIds).toEqual([])
    expect(result.warnings).toEqual(['skill shared is already provided by first-owner and was not materialized'])
    expect(readFileSync(join(root(), 'shared', 'SKILL.md'), 'utf8')).toContain('From the first plugin.')
  })

  it('does not re-copy a parked plugin, which would undo the disable', () => {
    const installPath = pluginWithSkills('parked', { solo: 'Parked copy.' })
    materializeSkills(installPath, options(), 'parked', [])
    expect(setSkillsEnabled(options(), 'parked', ['solo'], false)).toBe(true)

    const result = materializeSkills(installPath, options(), 'parked', ['solo'])

    // The names are still reported so a later enable knows what to move back.
    expect(result.skillIds).toEqual(['solo'])
    expect(existsSync(join(root(), 'solo'))).toBe(false)
    expect(readFileSync(join(disabledSkillsDir(options(), 'parked'), 'solo', 'SKILL.md'), 'utf8')).toContain('Parked copy.')
  })

  it('drops a name the plugin stopped shipping and keeps the rest of the parking directory', () => {
    const installPath = pluginWithSkills('shrinking', { kept: 'Still shipped.', gone: 'No longer shipped.' })
    materializeSkills(installPath, options(), 'shrinking', [])
    expect(setSkillsEnabled(options(), 'shrinking', ['kept', 'gone'], false)).toBe(true)
    rmSync(join(installPath, 'skills', 'gone'), { recursive: true, force: true })

    const result = materializeSkills(installPath, options(), 'shrinking', ['kept', 'gone'])

    expect(result.skillIds).toEqual(['kept'])
    // The parked copy of the dropped name is gone; the survivor is untouched, so
    // re-enabling still restores something.
    expect(existsSync(join(disabledSkillsDir(options(), 'shrinking'), 'gone'))).toBe(false)
    expect(existsSync(join(disabledSkillsDir(options(), 'shrinking'), 'kept', 'SKILL.md'))).toBe(true)
  })
})

describe('the two cleanup functions', () => {
  it('removes only the names it is given, from either placement', () => {
    const installPath = pluginWithSkills('partial', { live: 'In discovery.', parked: 'Outside it.' })
    materializeSkills(installPath, options(), 'partial', [])
    expect(setSkillsEnabled(options(), 'partial', ['parked'], false)).toBe(true)
    // The plugin-scoped container an earlier build wrote.
    mkdirSync(join(root(), 'partial', 'inner'), { recursive: true })
    writeFileSync(join(root(), 'partial', 'inner', 'SKILL.md'), '---\nname: inner\ndescription: Old.\n---\n', 'utf8')

    expect(removeMaterializedSkills(options(), 'partial', ['live', 'parked', 'never-existed']))
      .toEqual(['live', 'parked'])

    // What a SYNC may not delete: the parking directory is a disabled plugin's
    // only copy, and the container belongs to uninstall.
    expect(existsSync(join(root(), 'live'))).toBe(false)
    expect(existsSync(join(disabledSkillsDir(options(), 'partial'), 'parked'))).toBe(false)
    expect(existsSync(disabledSkillsDir(options(), 'partial'))).toBe(true)
    expect(existsSync(join(root(), 'partial', 'inner', 'SKILL.md'))).toBe(true)
  })

  it('is the wider uninstall cleanup, container included', () => {
    const installPath = pluginWithSkills('uninstalling', { solo: 'Only skill.' })
    materializeSkills(installPath, options(), 'uninstalling', [])
    expect(setSkillsEnabled(options(), 'uninstalling', ['solo'], false)).toBe(true)
    mkdirSync(join(root(), 'uninstalling', 'inner'), { recursive: true })
    writeFileSync(join(root(), 'uninstalling', 'inner', 'SKILL.md'), '---\nname: inner\ndescription: Old.\n---\n', 'utf8')

    expect(removePluginSkills(options(), 'uninstalling', ['solo'])).toEqual(['solo'])

    expect(existsSync(disabledSkillsDir(options(), 'uninstalling'))).toBe(false)
    expect(existsSync(join(root(), 'uninstalling'))).toBe(false)
  })

  it('leaves a discoverable entry that happens to share the plugin name', () => {
    // `<root>/<plugin>` is only a legacy container when it holds no SKILL.md;
    // when it does, some plugin owns that name and this uninstall must not
    // delete it.
    const owned = join(root(), 'shared-name')
    mkdirSync(owned, { recursive: true })
    writeFileSync(join(owned, 'SKILL.md'), '---\nname: shared-name\ndescription: Mine.\n---\n\nBody.\n', 'utf8')

    expect(removePluginSkills(options(), 'shared-name', [])).toEqual([])

    expect(readFileSync(join(owned, 'SKILL.md'), 'utf8')).toContain('Mine.')
  })
})

describe('enablement of skills', () => {
  it('reports the three states a plugin can be in', () => {
    const installPath = pluginWithSkills('states', { solo: 'Only skill.' })
    materializeSkills(installPath, options(), 'states', [])
    expect(skillsEnabled(options(), 'states', ['solo'])).toBe(true)

    expect(setSkillsEnabled(options(), 'states', ['solo'], false)).toBe(true)
    expect(skillsEnabled(options(), 'states', ['solo'])).toBe(false)

    expect(setSkillsEnabled(options(), 'states', ['solo'], true)).toBe(true)
    expect(skillsEnabled(options(), 'states', ['solo'])).toBe(true)

    // Nothing recorded, and names recorded but nothing on disk.
    expect(skillsEnabled(options(), 'states', [])).toBeUndefined()
    expect(skillsEnabled(options(), 'states', ['never-materialized'])).toBeUndefined()
  })

  it('skips a recorded name that is not on disk and reports nothing moved', () => {
    const installPath = pluginWithSkills('stale-name', { present: 'Still here.' })
    materializeSkills(installPath, options(), 'stale-name', [])

    expect(setSkillsEnabled(options(), 'stale-name', ['present', 'never-materialized'], false)).toBe(true)
    expect(existsSync(join(disabledSkillsDir(options(), 'stale-name'), 'never-materialized'))).toBe(false)
    // Nothing was in discovery to park, so nothing moved.
    expect(setSkillsEnabled(options(), 'stale-name', ['never-materialized'], false)).toBe(false)
    expect(skillsEnabled(options(), 'stale-name', [])).toBeUndefined()
  })
})

describe('skillEntryNames', () => {
  it('counts only the shapes discovery reads', () => {
    const installPath = pluginWithSkills('shapes', { b: 'Directory with SKILL.md.', a: 'Sorted second.' })
    writeFileSync(join(installPath, 'skills', 'z.md'), '---\nname: z\ndescription: Flat file.\n---\n', 'utf8')
    mkdirSync(join(installPath, 'skills', 'empty-dir'), { recursive: true })
    writeFileSync(join(installPath, 'skills', 'ignored.txt'), 'not markdown', 'utf8')

    expect(skillEntryNames(installPath)).toEqual({
      names: ['a', 'b', 'z.md'],
      skipped: ['empty-dir', 'ignored.txt'],
    })
    // A plugin without a skills directory carries no skills and reports nothing.
    expect(skillEntryNames(join(scratch, 'plugins', 'no-skills'))).toEqual({ names: [], skipped: [] })
  })
})
