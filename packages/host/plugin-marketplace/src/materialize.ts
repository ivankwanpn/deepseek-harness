/**
 * Materialize one fetched plugin's capabilities into DSH's own surfaces, and
 * derive the patch rows that mount it.
 *
 * THE mapping, and why it is two-mechanism rather than one:
 *
 *  - skills are a FILE TREE. `skill-filesystem` discovers `~/.agents/skills`
 *    dynamically, so a skill needs no loader row and no restart. Materializing
 *    it is the whole installation.
 *  - a runtime plugin and an MCP server are LOADER ROWS. They mount through the
 *    user patch layer, which DSH watches through Cordis HMR, so a row change is
 *    live too. There is nothing to copy.
 *
 * Collapsing these into "copy files and call it enabled" would be wrong for the
 * second kind (a row that was never written is not a disabled plugin, it is a
 * missing one), and inventing loader rows for skills would register them twice —
 * once by discovery, once by row.
 *
 * Enablement (`disabled`) is NOT decided here: the patch layer owns it (see
 * patch-layer.ts). These rows describe existence and shape only.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ManagedRow } from './patch-layer.ts'
import { type InstalledCapability, type InstalledEntry } from './state.ts'

/** Module specifier that mounts one MCP server. */
export const MCP_CLIENT_MODULE = '@deepseek-ai/dsh-mcp-client'

/**
 * Whether a path is a directory, without throwing on absence.
 *
 * Unreadable counts as absent: a capability probe must never be the thing that
 * aborts an install, and every caller here is deciding whether to mention a
 * capability rather than whether to trust the file.
 *
 * @param path - the absolute path to probe.
 * @returns true only when the path exists and is a directory.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * Where a materialization run reads its inputs from and writes skills to.
 *
 * The harness home is REQUIRED rather than re-derived from `os.homedir()`: a
 * caller that pinned `DSH_HOME` must stay inside its own root instead of
 * silently writing into the real user's `~/.agents` (see
 * defaultAgentsSkillsDir).
 */
export interface MaterializeOptions {
  /** Harness home (`~/.dsh`); skills land under `<home>/../.agents` by default. */
  harnessHome: string
  /**
   * Where discovered skills live. Defaults to the sibling `~/.agents/skills`
   * because that is the root `skill-filesystem` reads; overriding it is only
   * useful for tests and for installs that pin `DSH_AGENTS_HOME`.
   */
  agentsSkillsDir?: string
}

/**
 * What materializing one installed entry produced, for sync to merge and report.
 *
 * Warnings are deliberately NON-FATAL: one unusable MCP server or a plugin whose
 * capabilities changed on disk must not abort the parts that still work, or a
 * single bad file would take an otherwise mountable plugin down with it.
 */
export interface MaterializeResult {
  /** Rows that must exist in the patch layer for this entry. */
  rows: ManagedRow[]
  /**
   * Ids of the rows above, which are the ids an installer must record so that
   * enablement and uninstall can name them later.
   *
   * Kept separate from `rows` because ids are NOT derivable from the plugin
   * name: an MCP row is keyed on the sanitized SERVER name, and a plugin may
   * declare several. A caller that recomputed `marketplace:<plugin>` would
   * address rows that do not exist and silently toggle nothing.
   */
  rowIds: string[]
  /** Where skills were copied, when the entry carries any. */
  skillsDir?: string
  /** Names of MCP servers derived from the plugin's `.mcp.json`. */
  mcpServers: string[]
  /** Non-fatal problems worth telling the user about. */
  warnings: string[]
}

/**
 * `<agentsHome>/skills/<plugin>` — one directory per plugin, so uninstall is
 * one rm.
 *
 * @param options - the harness home and, when pinned, the skills root to use.
 * @param plugin - the entry name from the marketplace state; it becomes the
 * directory name.
 * @returns the absolute live skills directory, whether or not it exists yet.
 */
export function skillsDirFor(options: MaterializeOptions, plugin: string): string {
  const base = options.agentsSkillsDir ?? defaultAgentsSkillsDir(options.harnessHome)
  return join(base, plugin)
}

/**
 * Where discovered skills live.
 *
 * `DSH_AGENTS_HOME` wins when set, because `skill-filesystem` resolves its
 * agents root from exactly that variable (skill-filesystem/src/index.ts:164 —
 * `resolve(config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? <home>/.agents)`).
 * Ignoring it would copy skills to a directory DSH never scans, which looks like
 * a successful install that mounts nothing.
 *
 * Otherwise `~/.dsh` and `~/.agents` are siblings under the user's home, so the
 * root is derived from the harness home rather than re-reading `os.homedir()`: a
 * caller that overrode DSH_HOME must not silently write into the real user's
 * `~/.agents`. When the harness home is not a `.dsh` directory (an isolated test
 * root), a SIBLING directory is used rather than the real `~/.agents` — the safe
 * direction, since writing to the user's real skill root from a sandboxed run
 * would be a genuine side effect.
 *
 * @param harnessHome - the harness root the caller resolved; it is ignored when
 * `DSH_AGENTS_HOME` is set, and never re-derived from `os.homedir()`.
 * @returns the skills root to install into: `<DSH_AGENTS_HOME>/skills` when that
 * variable is set, the `.agents/skills` sibling of a `.dsh` harness home
 * otherwise, or `<harnessHome>/agents-skills` for an isolated root.
 */
export function defaultAgentsSkillsDir(harnessHome: string): string {
  const override = process.env.DSH_AGENTS_HOME
  if (override !== undefined && override.trim() !== '') return join(override, 'skills')
  const marker = /[\\/]\.dsh[\\/]?$/.exec(harnessHome)
  if (marker === null) return join(harnessHome, 'agents-skills')
  return join(harnessHome.slice(0, marker.index), '.agents', 'skills')
}

/** One MCP server as `.mcp.json` declares it, narrowed to what DSH can mount. */
export interface NormalizedMcpServer {
  name: string
  /** stdio arm. */
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** remote arm. */
  url?: string
  headers?: Record<string, string>
}

/**
 * Normalize a plugin's `.mcp.json` into mountable servers.
 *
 * Claude-shaped input, DSH-shaped output. The two differ in ways that matter:
 *  - `command` may be a STRING or an ARRAY in the wild; DSH wants an executable
 *    plus separate args, so a one-element string is an executable with no args
 *    and a multi-element array is [executable, ...args].
 *  - the env key is `env` in Claude's files but `environment` appears in some
 *    plugin manifests; accept both rather than dropping the server.
 *  - DSH's `serverName` must match `[A-Za-z0-9_-]{1,32}`, so a name that does
 *    not fit is sanitized and reported, never silently renamed.
 *
 * @param raw - the parsed `.mcp.json` document; a value that is not an object
 * yields no servers rather than an error, since shipping no MCP server is a
 * normal plugin shape.
 * @param warnings - collector for servers skipped because they declare neither a
 * command nor a url; mutated in place.
 * @returns the mountable servers in declaration order, with their declared names
 * left intact for sanitizeServerName to coerce.
 */
export function normalizeMcpServers(raw: unknown, warnings: string[]): NormalizedMcpServer[] {
  if (typeof raw !== 'object' || raw === null) return []
  const root = raw as Record<string, unknown>
  // Both shapes occur: `{ mcpServers: {...} }` and a bare `{ name: {...} }`.
  const table = typeof root.mcpServers === 'object' && root.mcpServers !== null
    ? (root.mcpServers as Record<string, unknown>)
    : root

  const servers: NormalizedMcpServer[] = []
  for (const [name, value] of Object.entries(table)) {
    if (typeof value !== 'object' || value === null) continue
    const spec = value as Record<string, unknown>

    const rawCommand = spec.command
    let command: string | undefined
    let args: string[] | undefined
    if (typeof rawCommand === 'string') {
      command = rawCommand
    } else if (Array.isArray(rawCommand) && rawCommand.every(v => typeof v === 'string')) {
      // `every` already narrowed the array to `string[]`; asserting that again
      // would be restating what the guard just proved.
      const parts = rawCommand
      command = parts[0]
      if (parts.length > 1) args = parts.slice(1)
    }

    const declaredArgs = Array.isArray(spec.args) ? spec.args.filter((v): v is string => typeof v === 'string') : undefined
    if (declaredArgs !== undefined && declaredArgs.length > 0) args = [...(args ?? []), ...declaredArgs]

    // Both raw values arrive as `any` (PluginSource carries an index
    // signature), so each is narrowed to `object` at the guard and cast to
    // `Record<string, unknown>` only where `Object.entries` needs a real type.
    const envRaw = spec.env ?? spec.environment
    const env = typeof envRaw === 'object' && envRaw !== null
      ? Object.fromEntries(Object.entries(envRaw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : undefined
    const headersRaw = spec.headers
    const headers = typeof headersRaw === 'object' && headersRaw !== null
      ? Object.fromEntries(Object.entries(headersRaw as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'))
      : undefined

    const url = typeof spec.url === 'string' ? spec.url : undefined
    if (command === undefined && url === undefined) {
      warnings.push(`mcp server ${JSON.stringify(name)} has neither a command nor a url; skipped`)
      continue
    }
    servers.push({
      name,
      ...(command !== undefined ? { command } : {}),
      ...(args !== undefined && args.length > 0 ? { args } : {}),
      ...(env !== undefined && Object.keys(env).length > 0 ? { env } : {}),
      ...(typeof spec.cwd === 'string' ? { cwd: spec.cwd } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(headers !== undefined && Object.keys(headers).length > 0 ? { headers } : {}),
    })
  }
  return servers
}

/**
 * DSH namespaces MCP tools as `mcp__<serverName>__<tool>`, and `serverName` is
 * constrained to `[A-Za-z0-9_-]{1,32}` and unique within a registration scope.
 * A plugin's server name is third-party input, so it must be coerced, and the
 * coercion must be REPORTED: a silently renamed namespace changes the model's
 * tool names, which invalidates saved approvals keyed on those names.
 *
 * @param name - the server name exactly as the plugin declared it.
 * @param warnings - collector for the coercion report; mutated in place. The
 * reporting plugin's name is NOT added here: sync prefixes every warning it
 * forwards, so a caller reading these directly sees the server name, which is
 * the identity that actually changed.
 * @returns a non-empty name within `[A-Za-z0-9_-]{1,32}`: characters outside the
 * set become `-`, anything past 32 characters is truncated, and a name that
 * cleans up to nothing becomes `server`.
 */
export function sanitizeServerName(name: string, warnings: string[]): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, '-')
  const bounded = cleaned.length > 32 ? cleaned.slice(0, 32) : cleaned
  const final = bounded === '' ? 'server' : bounded
  if (final !== name) {
    warnings.push(`mcp server name ${JSON.stringify(name)} → ${JSON.stringify(final)} (DSH requires [A-Za-z0-9_-]{1,32})`)
  }
  return final
}

/**
 * Copy skills out of an installed plugin into the discovery root.
 *
 * Idempotent by replacement: the destination is removed first, so a plugin
 * upgrade cannot leave skills from the previous revision behind. That matters
 * because the discovery root is flat — a stale `skills/<name>` would keep being
 * offered to the model with no trace of where it came from.
 *
 * SKIPS a plugin whose skills are currently parked by `setSkillsEnabled`. Without
 * that check a sync would faithfully re-copy the tree and silently UNDO a
 * disable — the same "I turned it off and it came back" failure the patch layer
 * guards against for loader rows.
 *
 * @param sourceRoot - the installed plugin's directory; its `skills/` subtree is
 * what gets copied.
 * @param options - the harness home and skills root the destination and the
 * parked copy are both derived from.
 * @param plugin - the entry name from the marketplace state; it names the
 * destination directory and selects the enablement check.
 * @returns the destination directory, or undefined when there are no skills.
 */
export function materializeSkills(sourceRoot: string, options: MaterializeOptions, plugin: string): string | undefined {
  const source = join(sourceRoot, 'skills')
  if (!existsSync(source)) return undefined
  if (skillsEnabled(options, plugin) === false) return undefined
  const destination = skillsDirFor(options, plugin)
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(join(destination, '..'), { recursive: true })
  cpSync(source, destination, { recursive: true })
  return destination
}

/**
 * Read `.mcp.json` from an installed plugin, if present.
 *
 * A missing file is a plugin without MCP servers, not an error. An unparseable
 * one is reported and treated as empty, so a single bad file cannot abort the
 * install of an otherwise usable plugin.
 *
 * @param sourceRoot - the installed plugin's directory.
 * @param warnings - collector for a parse failure; mutated in place.
 * @returns the servers the file declares, or none when it is absent or
 * unreadable.
 */
export function readPluginMcp(sourceRoot: string, warnings: string[]): NormalizedMcpServer[] {
  const file = join(sourceRoot, '.mcp.json')
  if (!existsSync(file)) return []
  try {
    return normalizeMcpServers(JSON.parse(readFileSync(file, 'utf8')), warnings)
  } catch (error) {
    warnings.push(`.mcp.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  }
}

/**
 * Where a disabled plugin's skills are parked.
 *
 * A dot-prefixed SIBLING of the live directory, not a subdirectory of it:
 * `skill-filesystem` walks one level for `<name>/SKILL.md`, so a directory named
 * `.disabled` would still be discovered as a skill named `.disabled` and, worse,
 * a nested `skills/.disabled/<plugin>/<skill>` would be walked as a skill
 * directory. Keeping it next to (not inside) the root removes it from discovery
 * without relying on the scanner ignoring dotfiles.
 */
export const DISABLED_SKILLS_DIRNAME = '.disabled'

/**
 * Where a plugin's skills are parked while it is disabled:
 * `<skillsRoot>/.disabled/<plugin>`.
 *
 * A SIBLING of the live directory rather than a child of it, so the skills
 * scanner never walks into it — DISABLED_SKILLS_DIRNAME records why nesting
 * would have been discovered instead of ignored.
 *
 * @param options - the harness home and skills root the parking directory is
 * derived from.
 * @param plugin - the entry name from the marketplace state.
 * @returns the absolute parking directory, whether or not it exists.
 */
export function disabledSkillsDir(options: MaterializeOptions, plugin: string): string {
  const live = skillsDirFor(options, plugin)
  return join(live, '..', DISABLED_SKILLS_DIRNAME, plugin)
}

/**
 * Enable or disable a plugin's SKILLS.
 *
 * Skills have no loader row, so `disabled` has no meaning for them: the only way
 * to turn them off is to take them out of the discovery tree. Moving preserves
 * the content, so re-enabling needs no re-fetch and no network.
 *
 * @param options - the harness home and skills root both directories are derived
 * from.
 * @param plugin - the entry name from the marketplace state.
 * @param enabled - true to move skills back into discovery, false to park them
 * outside it.
 * @returns true when something moved; false when the plugin has no skills or was
 * already in the requested state.
 */
export function setSkillsEnabled(options: MaterializeOptions, plugin: string, enabled: boolean): boolean {
  const live = skillsDirFor(options, plugin)
  const parked = disabledSkillsDir(options, plugin)
  const from = enabled ? parked : live
  const to = enabled ? live : parked
  if (!existsSync(from)) return false
  rmSync(to, { recursive: true, force: true })
  mkdirSync(join(to, '..'), { recursive: true })
  renameSync(from, to)
  return true
}

/**
 * Whether a plugin's skills are currently in the discovery tree.
 *
 * Three states rather than a boolean, because "parked" and "never had skills"
 * call for different answers: only the first is a disabled plugin, while the
 * second tells `marketplace enable/disable` that the entry mounts nothing at
 * all.
 *
 * @param options - the harness home and skills root both directories are derived
 * from.
 * @param plugin - the entry name from the marketplace state.
 * @returns true when the live directory exists, false when only the parked one
 * does, and undefined when neither exists.
 */
export function skillsEnabled(options: MaterializeOptions, plugin: string): boolean | undefined {
  const live = existsSync(skillsDirFor(options, plugin))
  const parked = existsSync(disabledSkillsDir(options, plugin))
  if (live) return true
  if (parked) return false
  return undefined
}

/**
 * Materialize one installed entry and return the rows that mount it.
 *
 * `capabilities` from the state file is advisory: it was detected at install
 * time, and the directory may have changed. What is on disk now decides, with
 * the recorded set used only to explain a mismatch.
 *
 * @param entry - the installed record to materialize; only its `plugin`,
 * `installPath`, and advisory `capabilities` are read.
 * @param options - the harness home and skills root materialization writes to.
 * @returns the rows that mount the entry, where its skills landed when it has
 * any, the server names it declares, and the non-fatal problems found on disk.
 */
export function materializeEntry(
  entry: InstalledEntry,
  options: MaterializeOptions,
): MaterializeResult {
  const rows: ManagedRow[] = []
  const warnings: string[] = []
  const onDisk: InstalledCapability[] = []

  const skillsDir = materializeSkills(entry.installPath, options, entry.plugin)
  if (skillsDir !== undefined) onDisk.push('skills')

  // `commands/` is DETECTED but not materialized (see Known Limitations), so it
  // contributes no row and no mount — but it must still be counted here. This
  // list is compared against the capabilities recorded at install, and
  // detectCapabilities reports commands, so omitting it made every plugin that
  // ships one announce "capabilities changed on disk" on every single sync.
  if (isDirectory(join(entry.installPath, 'commands'))) onDisk.push('commands')

  const servers = readPluginMcp(entry.installPath, warnings)
  if (servers.length > 0) onDisk.push('mcp')
  for (const server of servers) {
    const serverName = sanitizeServerName(server.name, warnings)
    rows.push({
      // Id keyed on the SERVER NAME, not on the plugin. `mcp-client` reserves
      // `serverName` per scope and THROWS on a duplicate
      // (mcp-client/src/index.ts:152-163), so two plugins shipping a server of
      // the same name are a genuine conflict. Namespacing the id by plugin would
      // hide that from sync and let both rows through, turning a clear
      // "duplicate serverName" into an opaque loader failure at mount time.
      id: `marketplace:mcp:${serverName}`,
      name: MCP_CLIENT_MODULE,
      config: {
        serverName,
        ...(server.command !== undefined
          ? {
            transport: 'stdio',
            command: server.command,
            ...(server.args !== undefined ? { args: server.args } : {}),
            ...(server.env !== undefined ? { env: server.env } : {}),
            ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
          }
          : {
            transport: 'streamable-http',
            url: server.url,
            ...(server.headers !== undefined ? { headers: server.headers } : {}),
          }),
      },
    })
  }

  const recorded = [...entry.capabilities].sort().join(',')
  const actual = [...onDisk].sort().join(',')
  if (recorded !== actual) {
    warnings.push(`capabilities changed on disk since install (recorded ${recorded || 'none'}, found ${actual || 'none'})`)
  }

  return {
    rows,
    rowIds: rows.map(row => row.id),
    ...(skillsDir !== undefined ? { skillsDir } : {}),
    mcpServers: servers.map(s => s.name),
    warnings,
  }
}
