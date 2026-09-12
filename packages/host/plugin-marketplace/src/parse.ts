/**
 * Marketplace reader — parse a Claude-compatible `marketplace.json`.
 *
 * WHY this shape: the Claude plugin marketplace format is a de-facto standard
 * (anthropics/claude-plugins-official, plus every vendor's own marketplace).
 * Reading it means inheriting that ecosystem instead of inventing a registry.
 *
 * SECURITY POSTURE — this module only PARSES. It performs no network I/O, no
 * git, and executes nothing. Every entry carries its `sha` through so a caller
 * can pin; an entry without one is reported, never silently accepted.
 */

/** Where a plugin's files come from. */
export type PluginSource =
  | { kind: 'local'; path: string; ref?: string }
  | { kind: 'git'; url: string; subdirectory?: string; ref?: string; sha?: string }

/** A parsed marketplace entry, normalized from the vendor's loose JSON. */
export interface MarketplaceEntry {
  name: string
  description?: string
  category?: string
  version?: string
  homepage?: string
  tags: string[]
  source: PluginSource
  /** Servers the ENTRY declares inline (not from the plugin's own `.mcp.json`). */
  inlineMcpServers: string[]
  /** LSP servers the entry declares inline. */
  inlineLspServers: string[]
  /** Skills the entry lists explicitly (`skills: [...]`), when the manifest narrows them. */
  inlineSkills: string[]
  /** `strict: false` means the manifest may narrow what the plugin contributes. */
  strict: boolean
  /** Diagnostics worth surfacing: missing pin, unusual source, etc. */
  warnings: string[]
}

/** One parsed marketplace document, ready to search and install from. */
export interface Marketplace {
  name: string
  description?: string
  plugins: MarketplaceEntry[]
  /** Renames the registry publishes (old -> new), for id migration. */
  renames: Record<string, string>
}

/** Raised when a manifest is structurally not a marketplace we can read. */
export class MarketplaceParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MarketplaceParseError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

/** `${owner}/${repo}` and bare URLs both appear as `github`-style sources. */
function githubUrl(source: string): string | undefined {
  if (!/^[\w.-]+\/[\w.-]+$/.test(source)) return undefined
  return `https://github.com/${source}.git`
}

function gitUrl(source: string): string | undefined {
  if (source.startsWith('http://') || source.startsWith('https://')) return source
  if (source.startsWith('git@') || source.startsWith('ssh://')) return source
  return githubUrl(source)
}

/**
 * Parse one `source` value.
 *
 * Vendor manifests use three shapes, all of which appear in the official
 * registry: a bare string (sometimes a repo path like `./plugins/x`, sometimes
 * a `owner/repo`), and an object with `source: url | git-subdir` plus an
 * optional `path`/`ref`/`sha`.
 *
 * @param raw - the entry's `source` field, still untrusted.
 * @param warnings - collector appended to in place; a git source with no `sha`
 * is reported here rather than thrown, because the manifest is still readable
 * and the user needs to see why it cannot be installed.
 * @returns the normalized source, with `kind` resolved.
 * @throws {MarketplaceParseError} when the object form names no resolvable url,
 * an unsupported `source` kind, or a `git-subdir` with no `path`.
 */
export function parseSource(raw: unknown, warnings: string[]): PluginSource {
  if (typeof raw === 'string') {
    const value = raw.trim()
    if (value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) {
      return { kind: 'local', path: value }
    }
    const url = gitUrl(value)
    if (url === undefined) {
      // Unknown string form: keep it verbatim as a local path rather than
      // guessing a host, and say so.
      warnings.push(`unrecognized source string ${JSON.stringify(value)}; treating as a local path`)
      return { kind: 'local', path: value }
    }
    warnings.push(`source ${JSON.stringify(value)} has no sha pin`)
    return { kind: 'git', url }
  }

  if (!isRecord(raw)) throw new MarketplaceParseError(`plugin source must be a string or object, got ${typeof raw}`)

  const kind = str(raw.source)
  const url = str(raw.url)
  const path = str(raw.path)
  const ref = str(raw.ref ?? raw.branch ?? raw.tag)
  const sha = str(raw.sha)

  if (kind === 'github' || url === undefined) {
    // A `{source:'github', repo:'owner/name'}` shape, or a url-less entry.
    const repo = str(raw.repo) ?? url
    const resolved = repo === undefined ? undefined : (gitUrl(repo) ?? (kind === 'github' ? githubUrl(repo) : undefined))
    if (resolved === undefined) throw new MarketplaceParseError('plugin source object has no resolvable url')
    if (sha === undefined) warnings.push('git source has no sha pin')
    return { kind: 'git', url: resolved, ...(path !== undefined ? { subdirectory: path } : {}), ...(ref !== undefined ? { ref } : {}), ...(sha !== undefined ? { sha } : {}) }
  }

  if (kind !== undefined && kind !== 'url' && kind !== 'git' && kind !== 'git-subdir') {
    throw new MarketplaceParseError(`unsupported source kind ${JSON.stringify(kind)}`)
  }

  const git = gitUrl(url)
  if (git === undefined) throw new MarketplaceParseError(`source url ${JSON.stringify(url)} is not a git url`)

  // `git-subdir` REQUIRES a path — without it we cannot know which subtree to
  // fetch, and fetching the whole repo would pull unrelated content.
  if (kind === 'git-subdir' && path === undefined) {
    throw new MarketplaceParseError('git-subdir source is missing `path`')
  }
  if (sha === undefined) warnings.push('git source has no sha pin')

  return {
    kind: 'git',
    url: git,
    ...(path !== undefined ? { subdirectory: path } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(sha !== undefined ? { sha } : {}),
  }
}

/**
 * Parse one plugin entry. Exported for tests; `parseMarketplace` is the entry point.
 * @param raw - the entry object from the manifest's `plugins` array.
 * @param index - its position, used only to make error messages locatable.
 * @returns the normalized entry, carrying any source warnings.
 * @throws {MarketplaceParseError} when the entry is not an object or names no
 * plugin.
 */
export function parseEntry(raw: unknown, index: number): MarketplaceEntry {
  if (!isRecord(raw)) throw new MarketplaceParseError(`plugins[${String(index)}] is not an object`)
  const name = str(raw.name)
  if (name === undefined) throw new MarketplaceParseError(`plugins[${String(index)}] has no name`)

  const warnings: string[] = []
  const source = parseSource(raw.source, warnings)

  const mcp = isRecord(raw.mcpServers) ? Object.keys(raw.mcpServers) : []
  const lsp = isRecord(raw.lspServers) ? Object.keys(raw.lspServers) : []

  // Read once and spread conditionally. Re-reading inside the test and then
  // asserting non-null would be the same value twice with a lie attached.
  const description = str(raw.description)
  const category = str(raw.category)
  const version = str(raw.version)
  const homepage = str(raw.homepage)

  return {
    name,
    ...(description !== undefined ? { description } : {}),
    ...(category !== undefined ? { category } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
    tags: strArray(raw.tags),
    source,
    inlineMcpServers: mcp,
    inlineLspServers: lsp,
    inlineSkills: strArray(raw.skills),
    strict: raw.strict !== false,
    warnings,
  }
}

/**
 * Parse a whole marketplace document. Throws on malformed structure.
 * @param raw - the decoded JSON body, still untrusted.
 * @returns the marketplace with every entry normalized and `renames` filtered
 * to string targets.
 * @throws {MarketplaceParseError} when the document is not an object, names no
 * marketplace, has no `plugins` array, or repeats a plugin name (which would
 * make `install <name>` ambiguous).
 */
export function parseMarketplace(raw: unknown): Marketplace {
  if (!isRecord(raw)) throw new MarketplaceParseError('marketplace document is not an object')
  const name = str(raw.name)
  if (name === undefined) throw new MarketplaceParseError('marketplace document has no name')
  if (!Array.isArray(raw.plugins)) throw new MarketplaceParseError('marketplace document has no plugins array')

  const renames: Record<string, string> = {}
  if (isRecord(raw.renames)) {
    for (const [from, to] of Object.entries(raw.renames)) {
      const target = str(to)
      if (target !== undefined) renames[from] = target
    }
  }

  const plugins = raw.plugins.map((entry, index) => parseEntry(entry, index))

  // Duplicate names would make `install <name>` ambiguous.
  const seen = new Set<string>()
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) throw new MarketplaceParseError(`duplicate plugin name ${JSON.stringify(plugin.name)}`)
    seen.add(plugin.name)
  }

  const description = str(raw.description)

  return { name, ...(description !== undefined ? { description } : {}), plugins, renames }
}

/**
 * A source is installable under our rules only when it is pinned.
 *
 * Classify the source an install would READ, not the entry as the manifest
 * declares it. A marketplace-relative `local` source is re-expressed by
 * `installSource` in fetch.ts as a git subdirectory of the marketplace
 * repository, which carries no `sha`; classifying the declared form calls that
 * source pinned and an install then refuses it.
 *
 * @param entry - the entry carrying the source to classify.
 * @returns true for a local source that resolves against no repository, or a
 * git source carrying a `sha`; an unpinned git source resolves at fetch time
 * and is therefore refused.
 */
export function isPinned(entry: MarketplaceEntry): boolean {
  return entry.source.kind === 'local' || entry.source.sha !== undefined
}
