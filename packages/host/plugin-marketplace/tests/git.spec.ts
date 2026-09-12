/**
 * Pinned fetching against a real git remote.
 *
 * The remote for every case is a repository this file creates in a private temp
 * root and drives with `execFileSync('git', …)`, so the real `execFile` argv
 * paths run: clone, sparse checkout, the shallow-fetch fallback, the commit
 * verification, and the copy out of scratch. Assertions are on the bytes that
 * landed in the install directory and on the refusals, never on a stub's return,
 * because the question this file answers is what an install leaves on disk for a
 * given pin.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { detectCapabilities, fetchPlugin, PluginFetchError, resolveRefSha } from '../src/git.ts'

/** Identity and behaviour flags, so a developer's global git config cannot change the outcome. */
const GIT_FLAGS = [
  '-c', 'user.email=marketplace-tests@example.test',
  '-c', 'user.name=Marketplace Tests',
  '-c', 'commit.gpgsign=false',
  '-c', 'core.autocrlf=false',
]

let scratch = ''

/** The repository every git case fetches from. */
let remote = ''
/** `file://` url of {@link remote}; the file transport is what upload-pack sees. */
let remoteUrl = ''
/** First commit: the state of the tree before the second edit. */
let firstCommit = ''
/** Second commit, and the tip of `main`. */
let secondCommit = ''

/**
 * Run git in a directory, failing the test on a non-zero exit.
 *
 * @param cwd - the repository to run in.
 * @param args - argv after the identity flags.
 * @returns trimmed stdout.
 */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...GIT_FLAGS, ...args], { cwd, encoding: 'utf8' }).trim()
}

/**
 * Create a repository with the given files and commit them.
 *
 * @param name - directory name under the scratch root.
 * @param files - repository-relative path to exact bytes.
 * @returns the new commit.
 */
function commitFiles(name: string, files: Record<string, string>): string {
  const root = join(scratch, name)
  mkdirSync(root, { recursive: true })
  git(root, ['init', '--quiet', '-b', 'main'])
  // Byte-exact checkouts: without this a host whose git converts line endings
  // would hand the install CRLF bytes the assertion below does not expect.
  writeFileSync(join(root, '.gitattributes'), '* -text\n')
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', name])
  return git(root, ['rev-parse', 'HEAD'])
}

/** The first version of the plugin content, committed at {@link firstCommit}. */
const SKILL_V1 = '---\nname: audit\ndescription: first\n---\nv1\n'
/** The second version, committed at {@link secondCommit}. */
const SKILL_V2 = '---\nname: audit\ndescription: second\n---\nv2\n'

/** Every path the fixture remote carries, at the first commit. */
function fixtureFiles(skill: string): Record<string, string> {
  return {
    '.mcp.json': '{"mcpServers":{"fixture":{"command":"npx"}}}\n',
    'commands/check.md': '# check\n',
    'skills/audit/SKILL.md': skill,
    'plugins/alpha/skills/audit/SKILL.md': skill,
    'plugins/alpha/commands/check.md': '# alpha check\n',
    'plugins/beta/SKILL.md': '# beta\n',
  }
}

/** A destination directory under the scratch root, with parents. */
function destination(name: string): string {
  return join(scratch, 'installs', name, 'plugin')
}

/**
 * Register cleanup before the fixtures exist, so a failing setup still removes
 * whatever it created.
 */
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-git-'))
  remote = join(scratch, 'remote')
  firstCommit = commitFiles('remote', fixtureFiles(SKILL_V1))
  writeFileSync(join(remote, 'skills', 'audit', 'SKILL.md'), SKILL_V2)
  writeFileSync(join(remote, 'plugins', 'alpha', 'skills', 'audit', 'SKILL.md'), SKILL_V2)
  git(remote, ['add', '-A'])
  git(remote, ['commit', '--quiet', '-m', 'second'])
  secondCommit = git(remote, ['rev-parse', 'HEAD'])
  remoteUrl = pathToFileURL(remote).href
})

afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true })
})

describe('resolveRefSha over a real remote', () => {
  it('resolves the remote HEAD without cloning', () => {
    return expect(resolveRefSha(remoteUrl)).resolves.toBe(secondCommit)
  })

  it('resolves an explicitly named ref', async () => {
    await expect(resolveRefSha(remoteUrl, 'refs/heads/main')).resolves.toBe(secondCommit)
    await expect(resolveRefSha(remoteUrl, 'main')).resolves.toBe(secondCommit)
  })

  it('falls back to main, then master, when HEAD is an unborn branch', async () => {
    // A repository whose HEAD names a branch that does not exist yet still has
    // history on a real branch, and the remote answers for that branch.
    const onMain = join(scratch, 'unborn-head-main')
    mkdirSync(onMain)
    git(onMain, ['init', '--quiet', '-b', 'main'])
    writeFileSync(join(onMain, 'a.txt'), 'a\n')
    git(onMain, ['add', '-A'])
    git(onMain, ['commit', '--quiet', '-m', 'a'])
    const mainSha = git(onMain, ['rev-parse', 'HEAD'])
    git(onMain, ['symbolic-ref', 'HEAD', 'refs/heads/ghost'])
    await expect(resolveRefSha(pathToFileURL(onMain).href)).resolves.toBe(mainSha)

    const onMaster = join(scratch, 'unborn-head-master')
    mkdirSync(onMaster)
    git(onMaster, ['init', '--quiet', '-b', 'master'])
    writeFileSync(join(onMaster, 'a.txt'), 'a\n')
    git(onMaster, ['add', '-A'])
    git(onMaster, ['commit', '--quiet', '-m', 'a'])
    const masterSha = git(onMaster, ['rev-parse', 'HEAD'])
    git(onMaster, ['symbolic-ref', 'HEAD', 'refs/heads/ghost'])
    await expect(resolveRefSha(pathToFileURL(onMaster).href)).resolves.toBe(masterSha)
  })

  it('reports every candidate it tried when the remote names no commit', async () => {
    const empty = join(scratch, 'empty-remote')
    mkdirSync(empty)
    git(empty, ['init', '--quiet', '-b', 'main'])
    const url = pathToFileURL(empty).href

    // An unborn HEAD on every candidate: each answers, and none names a commit.
    await expect(resolveRefSha(url)).rejects.toThrow(new PluginFetchError(
      `cannot resolve HEAD in ${url} (HEAD: no commit returned; refs/heads/main: no commit returned; refs/heads/master: no commit returned)`,
    ))
  })

  it('carries git stderr into the resolution failure', async () => {
    const url = pathToFileURL(join(scratch, 'absent-remote')).href
    let thrown: unknown
    try {
      await resolveRefSha(url)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PluginFetchError)
    // The first stderr line is the actionable part; a bare "git failed" would
    // send the operator looking for a problem on this machine instead.
    expect((thrown as PluginFetchError).message).toContain('git ls-remote failed: fatal:')
    expect((thrown as PluginFetchError).message).toContain(`${url} (HEAD: git ls-remote failed:`)
  })

  it('refuses a url that cannot be an argv element, without spawning git', async () => {
    // A manifest is untrusted input: this url is what an entry could carry, and
    // execFile rejects the NUL before any process starts. The diagnostic still
    // names the failing subcommand and the argument fault.
    let thrown: unknown
    try {
      await resolveRefSha('https://example.test/\u0000x')
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PluginFetchError)
    expect((thrown as PluginFetchError).message).toContain('git ls-remote failed: The argument')
    expect((thrown as PluginFetchError).message).toContain('null bytes')
  })
})

describe('fetchPlugin from a local source', () => {
  it('uses the directory in place and reports what it carries', async () => {
    const local = join(scratch, 'local-plugin')
    mkdirSync(join(local, 'skills', 'audit'), { recursive: true })
    mkdirSync(join(local, 'commands'), { recursive: true })
    writeFileSync(join(local, '.mcp.json'), '{}\n')

    const result = await fetchPlugin({ kind: 'local', path: local }, destination('local'))

    // Nothing is copied for a local source: the caller reads the directory the
    // manifest named, and an absent sha is reported as the empty string.
    expect(result).toEqual({ root: local, capabilities: ['skills', 'commands', 'mcp'], resolvedSha: '' })
    expect(existsSync(destination('local'))).toBe(false)
  })

  it('refuses a local source that is not on disk', async () => {
    const missing = join(scratch, 'not-there')
    await expect(fetchPlugin({ kind: 'local', path: missing }, destination('gone')))
      .rejects.toThrow(new PluginFetchError(`local source ${missing} does not exist`))
  })
})

describe('fetchPlugin from a git source', () => {
  it('refuses an unpinned git source before touching the network or the disk', async () => {
    await expect(fetchPlugin({ kind: 'git', url: remoteUrl }, destination('unpinned')))
      .rejects.toThrow(new PluginFetchError(
        `refusing to fetch ${remoteUrl} without a pinned sha: an unpinned source resolves at fetch time and can change`,
      ))
    expect(existsSync(destination('unpinned'))).toBe(false)
  })

  it('installs the pinned tip, its capabilities, and the commit it checked out', async () => {
    const target = destination('tip')
    const result = await fetchPlugin({ kind: 'git', url: remoteUrl, sha: secondCommit }, target)

    expect(result.resolvedSha).toBe(secondCommit)
    expect(result.capabilities).toEqual(['skills', 'commands', 'mcp'])
    expect(readFileSync(join(target, 'skills', 'audit', 'SKILL.md'), 'utf8')).toBe(SKILL_V2)
    expect(readFileSync(join(target, '.mcp.json'), 'utf8')).toBe('{"mcpServers":{"fixture":{"command":"npx"}}}\n')
    expect(result.root).toBe(target)
  })

  it('installs the pinned commit rather than the branch tip', async () => {
    const target = destination('pinned-old')
    const result = await fetchPlugin({ kind: 'git', url: remoteUrl, sha: firstCommit }, target)

    expect(result.resolvedSha).toBe(firstCommit)
    expect(readFileSync(join(target, 'skills', 'audit', 'SKILL.md'), 'utf8')).toBe(SKILL_V1)
  })

  it('narrows a git-subdir source to the pinned subtree', async () => {
    const target = destination('subdir')
    const result = await fetchPlugin(
      { kind: 'git', url: remoteUrl, subdirectory: 'plugins/alpha', sha: secondCommit },
      target,
    )

    expect(result.resolvedSha).toBe(secondCommit)
    expect(result.capabilities).toEqual(['skills', 'commands'])
    expect(readFileSync(join(target, 'skills', 'audit', 'SKILL.md'), 'utf8')).toBe(SKILL_V2)
    // The sparse checkout materialized only the wanted subtree.
    expect(existsSync(join(target, 'plugins', 'beta'))).toBe(false)
  })

  it('replaces whatever the destination held before', async () => {
    const target = destination('replace')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'stale.txt'), 'stale\n')

    await fetchPlugin({ kind: 'git', url: remoteUrl, subdirectory: 'plugins/alpha', sha: secondCommit }, target)

    expect(existsSync(join(target, 'stale.txt'))).toBe(false)
    expect(readFileSync(join(target, 'skills', 'audit', 'SKILL.md'), 'utf8')).toBe(SKILL_V2)
  })

  it('replaces a previous install of the whole repository', async () => {
    const target = destination('reinstall')
    await fetchPlugin({ kind: 'git', url: remoteUrl, sha: secondCommit }, target)
    writeFileSync(join(target, 'user-note.txt'), 'stale\n')

    // Re-installing an older pin must leave only that revision behind, with no
    // residue from the install it replaced.
    const result = await fetchPlugin({ kind: 'git', url: remoteUrl, sha: firstCommit }, target)

    expect(result.resolvedSha).toBe(firstCommit)
    expect(existsSync(join(target, 'user-note.txt'))).toBe(false)
    expect(readFileSync(join(target, 'skills', 'audit', 'SKILL.md'), 'utf8')).toBe(SKILL_V1)
  })

  it('refuses a subdirectory the pinned commit does not carry', async () => {
    const target = destination('absent-subdir')
    await expect(fetchPlugin(
      { kind: 'git', url: remoteUrl, subdirectory: 'plugins/absent', sha: secondCommit },
      target,
    )).rejects.toThrow(new PluginFetchError(`subdirectory plugins/absent not present at ${secondCommit}`))
    expect(existsSync(target)).toBe(false)
  })

  it('refuses a pin the remote cannot deliver, in both fetch modes', async () => {
    // A manifest can name a commit the repository no longer has. The shallow
    // fetch by sha is refused, the full fetch does not supply it either, and the
    // install must fail rather than land whatever the branch holds.
    const absent = 'f'.repeat(40)
    for (const source of [
      { kind: 'git', url: remoteUrl, sha: absent },
      { kind: 'git', url: remoteUrl, subdirectory: 'plugins/alpha', sha: absent },
    ] as const) {
      const target = destination(`absent-${source.subdirectory ?? 'whole'}`)
      let thrown: unknown
      try {
        await fetchPlugin(source, target)
      } catch (error) {
        thrown = error
      }
      expect(thrown).toBeInstanceOf(PluginFetchError)
      expect((thrown as PluginFetchError).message).toContain('git checkout failed:')
      expect(existsSync(target)).toBe(false)
    }
  })

  it('refuses a pin that resolves to a different commit than the one recorded', async () => {
    // An annotated tag object is a commit-ish, so checkout succeeds, but the
    // commit it lands on is not the sha the manifest pinned. Installing it would
    // make the recorded pin a lie.
    git(remote, ['tag', '-a', 'release', '-m', 'release'])
    const tagObject = git(remote, ['rev-parse', 'release'])
    const target = destination('tag-object')

    let thrown: unknown
    try {
      await fetchPlugin({ kind: 'git', url: remoteUrl, sha: tagObject }, target)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(PluginFetchError)
    expect((thrown as PluginFetchError).message).toBe(
      `checked out ${secondCommit} but ${tagObject} was pinned; refusing to install`,
    )
    expect(existsSync(target)).toBe(false)
  })
})

describe('detectCapabilities', () => {
  it('reports the carrier files that exist, in a stable order', () => {
    const root = join(scratch, 'capabilities', 'all')
    mkdirSync(join(root, 'skills'), { recursive: true })
    mkdirSync(join(root, 'commands'), { recursive: true })
    writeFileSync(join(root, '.mcp.json'), '{}\n')
    expect(detectCapabilities(root)).toEqual(['skills', 'commands', 'mcp'])
  })

  it('reports nothing for a plugin that carries nothing mountable', () => {
    const root = join(scratch, 'capabilities', 'empty')
    mkdirSync(root, { recursive: true })
    expect(detectCapabilities(root)).toEqual([])
  })

  it('requires a directory for skills and commands, and a file for .mcp.json', () => {
    // Existence is the only honest signal, and the carrier has to have the right
    // kind: a file named `skills` mounts nothing, and a directory named
    // `.mcp.json` is not a server declaration.
    const root = join(scratch, 'capabilities', 'wrong-kind')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'skills'), 'not a directory\n')
    writeFileSync(join(root, 'commands'), 'not a directory\n')
    mkdirSync(join(root, '.mcp.json'))
    expect(detectCapabilities(root)).toEqual([])
  })
})
