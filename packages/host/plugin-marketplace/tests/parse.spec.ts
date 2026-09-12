/**
 * Strict parsing of a Claude-compatible `marketplace.json`.
 *
 * Pins the reader's three jobs: classifying every `source` form the official
 * registry actually uses (bare string, repo path, `owner/repo`, and the
 * `source`/`url`/`git-subdir` object), reporting a missing pin as a warning on a
 * readable entry rather than throwing, and refusing a document that cannot be
 * searched unambiguously. Every case asserts the returned value or the thrown
 * error, so a reordered guard or a dropped field reddens the file instead of
 * silently changing what an install would read.
 */
import { describe, expect, it } from 'vitest'
import {
  isPinned,
  MarketplaceParseError,
  parseEntry,
  parseMarketplace,
  parseSource,
} from '../src/parse.ts'

/** A syntactically valid 40-hex commit, so a pin is never mistaken for a ref. */
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

describe('parseSource, string form', () => {
  it('keeps a repository-relative path local and untouched', () => {
    for (const path of ['./plugins/x', '../shared/x', '/srv/plugins/x']) {
      const warnings: string[] = []
      expect(parseSource(path, warnings)).toEqual({ kind: 'local', path })
      // A path already on disk has nothing to pin, so it carries no warning.
      expect(warnings).toEqual([])
    }
  })

  it('trims the string before classifying it', () => {
    const warnings: string[] = []
    expect(parseSource('  ./plugins/x\n', warnings)).toEqual({ kind: 'local', path: './plugins/x' })
    expect(warnings).toEqual([])
  })

  it('turns owner/repo into a GitHub clone url and reports the missing pin', () => {
    const warnings: string[] = []
    expect(parseSource('anthropics/claude-plugins-official', warnings)).toEqual({
      kind: 'git',
      url: 'https://github.com/anthropics/claude-plugins-official.git',
    })
    expect(warnings).toEqual(['source "anthropics/claude-plugins-official" has no sha pin'])
  })

  it('passes through every url scheme git understands', () => {
    for (const url of [
      'https://example.test/plugins/x.git',
      'http://example.test/plugins/x.git',
      'git@github.com:example/plugins.git',
      'ssh://git@example.test/plugins.git',
    ]) {
      const warnings: string[] = []
      expect(parseSource(url, warnings)).toEqual({ kind: 'git', url })
      expect(warnings).toEqual([`source ${JSON.stringify(url)} has no sha pin`])
    }
  })

  it('keeps an unrecognized string verbatim as a local path and says so', () => {
    const warnings: string[] = []
    expect(parseSource('plugins with spaces', warnings)).toEqual({ kind: 'local', path: 'plugins with spaces' })
    expect(warnings).toEqual([
      'unrecognized source string "plugins with spaces"; treating as a local path',
    ])
  })

  it('classifies the empty string as an unrecognized path rather than guessing a host', () => {
    const warnings: string[] = []
    expect(parseSource('   ', warnings)).toEqual({ kind: 'local', path: '' })
    expect(warnings).toEqual(['unrecognized source string ""; treating as a local path'])
  })
})

describe('parseSource, object form', () => {
  it('reads a url source with every optional field', () => {
    const warnings: string[] = []
    expect(parseSource(
      { source: 'url', url: 'https://example.test/x.git', path: 'plugins/x', ref: 'v1.2.3', sha: SHA },
      warnings,
    )).toEqual({ kind: 'git', url: 'https://example.test/x.git', subdirectory: 'plugins/x', ref: 'v1.2.3', sha: SHA })
    expect(warnings).toEqual([])
  })

  it('falls back to branch, then tag, for the declared revision', () => {
    expect(parseSource({ url: 'https://example.test/x.git', branch: 'next' }, []))
      .toEqual({ kind: 'git', url: 'https://example.test/x.git', ref: 'next' })
    expect(parseSource({ url: 'https://example.test/x.git', tag: 'v9' }, []))
      .toEqual({ kind: 'git', url: 'https://example.test/x.git', ref: 'v9' })
    // An explicit `ref` wins: the manifest names the revision it means.
    expect(parseSource({ url: 'https://example.test/x.git', ref: 'main', branch: 'next' }, []))
      .toEqual({ kind: 'git', url: 'https://example.test/x.git', ref: 'main' })
  })

  it('takes an entry with no source kind as long as it names a url', () => {
    expect(parseSource({ url: 'https://example.test/x.git', sha: SHA }, []))
      .toEqual({ kind: 'git', url: 'https://example.test/x.git', sha: SHA })
  })

  it('expands a bare owner/repo url the same way the string form does', () => {
    expect(parseSource({ source: 'git', url: 'example/plugins', sha: SHA }, []))
      .toEqual({ kind: 'git', url: 'https://github.com/example/plugins.git', sha: SHA })
  })

  it('accepts git-subdir only when it names the path to fetch', () => {
    const warnings: string[] = []
    expect(parseSource({ source: 'git-subdir', url: 'https://example.test/x.git', path: 'plugins/x', ref: 'main' }, warnings))
      .toEqual({ kind: 'git', url: 'https://example.test/x.git', subdirectory: 'plugins/x', ref: 'main' })
    expect(warnings).toEqual(['git source has no sha pin'])

    expect(() => parseSource({ source: 'git-subdir', url: 'https://example.test/x.git' }, []))
      .toThrow(new MarketplaceParseError('git-subdir source is missing `path`'))
  })

  it('resolves the github repo field', () => {
    const warnings: string[] = []
    expect(parseSource({ source: 'github', repo: 'example/plugins', ref: 'v1', sha: SHA }, warnings))
      .toEqual({ kind: 'git', url: 'https://github.com/example/plugins.git', ref: 'v1', sha: SHA })
    expect(warnings).toEqual([])
  })

  it('reports a missing pin on a repo-only source and omits the fields it was not given', () => {
    const warnings: string[] = []
    expect(parseSource({ source: 'github', repo: 'example/plugins', path: 'plugins/x' }, warnings))
      .toEqual({ kind: 'git', url: 'https://github.com/example/plugins.git', subdirectory: 'plugins/x' })
    expect(warnings).toEqual(['git source has no sha pin'])
  })

  it('reports every unusable object source as a parse error', () => {
    // Nothing to resolve from: no url, no repo.
    expect(() => parseSource({}, [])).toThrow(new MarketplaceParseError('plugin source object has no resolvable url'))
    // A `github` kind whose repo is not an `owner/name` pair.
    expect(() => parseSource({ source: 'github', repo: 'not a repo' }, []))
      .toThrow(new MarketplaceParseError('plugin source object has no resolvable url'))
    // A url-less entry of any other kind, with a repo the url rules reject.
    expect(() => parseSource({ source: 'url', repo: 'not a repo' }, []))
      .toThrow(new MarketplaceParseError('plugin source object has no resolvable url'))
    expect(() => parseSource({ source: 'svn', url: 'https://example.test/x' }, []))
      .toThrow(new MarketplaceParseError('unsupported source kind "svn"'))
    expect(() => parseSource({ source: 'url', url: 'not a git url' }, []))
      .toThrow(new MarketplaceParseError('source url "not a git url" is not a git url'))
  })

  it('refuses a source that is neither a string nor an object', () => {
    expect(() => parseSource(42, [])).toThrow(new MarketplaceParseError('plugin source must be a string or object, got number'))
    expect(() => parseSource(null, [])).toThrow(new MarketplaceParseError('plugin source must be a string or object, got object'))
    expect(() => parseSource(['./x'], [])).toThrow(MarketplaceParseError)
  })
})

describe('parseEntry', () => {
  it('normalizes every declared field', () => {
    const entry = parseEntry({
      name: 'aikido',
      description: '  scans code  ',
      category: 'security',
      version: '2.1.0',
      homepage: 'https://example.test/aikido',
      tags: ['security', 7, 'scanner'],
      skills: ['audit', null],
      source: { source: 'url', url: 'https://example.test/aikido.git', sha: SHA },
      mcpServers: { aikido: { command: 'npx' }, other: { command: 'npx' } },
      lspServers: { ts: { command: 'tsserver' } },
      strict: false,
    }, 0)

    expect(entry).toEqual({
      name: 'aikido',
      description: 'scans code',
      category: 'security',
      version: '2.1.0',
      homepage: 'https://example.test/aikido',
      tags: ['security', 'scanner'],
      source: { kind: 'git', url: 'https://example.test/aikido.git', sha: SHA },
      inlineMcpServers: ['aikido', 'other'],
      inlineLspServers: ['ts'],
      inlineSkills: ['audit'],
      strict: false,
      warnings: [],
    })
  })

  it('omits absent optionals instead of inventing empty strings', () => {
    const entry = parseEntry({ name: 'bare', source: './plugins/bare' }, 3)
    expect(entry).toEqual({
      name: 'bare',
      tags: [],
      source: { kind: 'local', path: './plugins/bare' },
      inlineMcpServers: [],
      inlineLspServers: [],
      inlineSkills: [],
      strict: true,
      warnings: [],
    })
    // Absent means absent: a caller must not see an empty description.
    expect('description' in entry).toBe(false)
    expect('category' in entry).toBe(false)
    expect('version' in entry).toBe(false)
    expect('homepage' in entry).toBe(false)
  })

  it('ignores inline server maps that are not objects', () => {
    const entry = parseEntry({
      name: 'odd',
      source: './plugins/odd',
      mcpServers: ['not', 'a', 'map'],
      lspServers: 'nope',
      tags: 'nope',
      skills: 12,
    }, 0)
    expect(entry.inlineMcpServers).toEqual([])
    expect(entry.inlineLspServers).toEqual([])
    expect(entry.inlineSkills).toEqual([])
    expect(entry.tags).toEqual([])
  })

  it('locates an unusable entry by its index', () => {
    expect(() => parseEntry('nope', 4)).toThrow(new MarketplaceParseError('plugins[4] is not an object'))
    expect(() => parseEntry({ source: './x' }, 7)).toThrow(new MarketplaceParseError('plugins[7] has no name'))
    expect(() => parseEntry({ name: '   ', source: './x' }, 1)).toThrow(new MarketplaceParseError('plugins[1] has no name'))
  })
})

describe('parseMarketplace', () => {
  it('normalizes a full document and filters renames to string targets', () => {
    const marketplace = parseMarketplace({
      name: '  official  ',
      description: ' the registry ',
      renames: { old: 'new', dropped: 7, blank: '  ' },
      plugins: [
        { name: 'a', source: './plugins/a' },
        { name: 'b', source: { source: 'url', url: 'https://example.test/b.git', sha: SHA } },
      ],
    })

    expect(marketplace.name).toBe('official')
    expect(marketplace.description).toBe('the registry')
    expect(marketplace.renames).toEqual({ old: 'new' })
    expect(marketplace.plugins.map(plugin => plugin.name)).toEqual(['a', 'b'])
  })

  it('omits an absent description and tolerates a non-object renames map', () => {
    const marketplace = parseMarketplace({ name: 'official', renames: ['old'], plugins: [] })
    expect(marketplace).toEqual({ name: 'official', plugins: [], renames: {} })
  })

  it('refuses a document that is not a searchable marketplace', () => {
    expect(() => parseMarketplace([])).toThrow(new MarketplaceParseError('marketplace document is not an object'))
    expect(() => parseMarketplace('nope')).toThrow(new MarketplaceParseError('marketplace document is not an object'))
    expect(() => parseMarketplace({ plugins: [] })).toThrow(new MarketplaceParseError('marketplace document has no name'))
    expect(() => parseMarketplace({ name: 'official' })).toThrow(new MarketplaceParseError('marketplace document has no plugins array'))
    expect(() => parseMarketplace({ name: 'official', plugins: {} })).toThrow(new MarketplaceParseError('marketplace document has no plugins array'))
  })

  it('refuses a repeated plugin name, which would make install ambiguous', () => {
    expect(() => parseMarketplace({
      name: 'official',
      plugins: [
        { name: 'aikido', source: './plugins/a' },
        { name: 'aikido', source: './plugins/b' },
      ],
    })).toThrow(new MarketplaceParseError('duplicate plugin name "aikido"'))
  })

  it('surfaces the index of an unusable entry inside a document', () => {
    expect(() => parseMarketplace({ name: 'official', plugins: [null] }))
      .toThrow(new MarketplaceParseError('plugins[0] is not an object'))
  })
})

describe('isPinned', () => {
  it('accepts a local source and a sha-pinned git source, and refuses an unpinned one', () => {
    expect(isPinned(parseEntry({ name: 'local', source: './plugins/local' }, 0))).toBe(true)
    expect(isPinned(parseEntry({ name: 'pinned', source: { url: 'https://example.test/x.git', sha: SHA } }, 0))).toBe(true)
    expect(isPinned(parseEntry({ name: 'loose', source: { url: 'https://example.test/x.git', ref: 'main' } }, 0))).toBe(false)
  })
})
