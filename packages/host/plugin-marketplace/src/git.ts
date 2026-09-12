/**
 * Fetch a plugin's content at a pinned revision, and report what it carries.
 *
 * SECURITY: every git invocation goes through `execFile` with an ARGUMENT ARRAY
 * and no shell. A marketplace `source` is attacker-influenced data that reaches
 * git as a URL, a ref, a sha and a subdirectory — passing any of it through a
 * shell would be command injection. There is deliberately no `exec` here and no
 * `shell: true` anywhere in this file.
 *
 * A git source is only fetched when it is PINNED. An unpinned fetch resolves
 * `HEAD` at fetch time, so the same manifest could deliver different code
 * tomorrow; the parse layer reports the missing pin, and this layer refuses to
 * act on it.
 */
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import type { PluginSource } from './parse.ts'
import type { InstalledCapability } from './state.ts'

const run = promisify(execFile)

/** Generous: a cold clone over a slow link is not a hang. */
const GIT_TIMEOUT_MS = 180_000

/** Raised when a plugin source cannot be fetched or does not match its pin. */
export class PluginFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'PluginFetchError'
  }
}

/** Run git with args as ARGV (never a shell string). */
async function git(args: readonly string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run('git', [...args], {
      ...(cwd !== undefined ? { cwd } : {}),
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr
    const firstLine = typeof stderr === 'string' ? stderr.trim().split('\n')[0] : undefined
    const detail = firstLine !== undefined && firstLine !== '' ? firstLine : (error as Error).message
    /* v8 ignore next -- every call passes at least one argument, so the empty-command fallback is defensive. */
    throw new PluginFetchError(`git ${args[0] ?? ''} failed: ${detail}`, { cause: error })
  }
}

/**
 * Resolve a ref to the commit it names RIGHT NOW, without cloning.
 *
 * This is how an unpinned source is made reproducible at install time. The
 * manifest not naming a revision does not mean none can be recorded: the remote
 * will always answer with the commit its ref points at, and recording that
 * commit is what turns "whatever main is today" into a fact the state file can
 * be held to. It also makes the install verifiable — fetchPlugin checks out this
 * exact commit and fails if the server hands back anything else.
 *
 * HEAD is asked for first because every host answers it; `main` and `master`
 * are the fallbacks for a server whose HEAD is a symbolic ref it will not
 * dereference. Detached or unborn HEAD therefore still resolves.
 *
 * @param url - the repository to ask; needs no local clone.
 * @param ref - the ref to resolve, defaulting to the remote's HEAD.
 * @returns the 40-hex commit the ref names.
 * @throws {PluginFetchError} when the remote cannot be reached or names no such
 * ref — guessing a commit would defeat the point.
 */
export async function resolveRefSha(url: string, ref = 'HEAD'): Promise<string> {
  const candidates = ref === 'HEAD' ? ['HEAD', 'refs/heads/main', 'refs/heads/master'] : [ref]
  const attempts: string[] = []
  for (const candidate of candidates) {
    try {
      const stdout = await git(['ls-remote', url, candidate])
      const sha = stdout.trim().split(/\s+/)[0]
      if (sha !== undefined && /^[0-9a-f]{40}$/.test(sha)) return sha
      attempts.push(`${candidate}: no commit returned`)
    } catch (error) {
      /* v8 ignore next -- git failures arrive as Error instances; the String arm defends this resolver against a non-Error throw. */
      attempts.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new PluginFetchError(`cannot resolve ${ref} in ${url} (${attempts.join('; ')})`)
}

/**
 * What a fetched plugin carries, decided by WHAT IS ON DISK.
 *
 * The marketplace manifest does not declare these (measured: zero of 294
 * official entries carry `mcpServers`, `commands`, `agents` or `hooks` — only
 * `lspServers` appears, in 12). Capabilities therefore have to be read after
 * fetching. Existence is the only honest signal: a manifest can claim anything.
 *
 * No runtime-entry probe: see `InstalledCapability` for why a loader-mountable
 * plugin is not one of the things we report.
 *
 * @param root - the fetched plugin directory to probe.
 * @returns the capabilities whose carrier file exists on disk, in a stable
 * order; empty when the plugin carries nothing mountable.
 */
export function detectCapabilities(root: string): InstalledCapability[] {
  const capabilities: InstalledCapability[] = []
  if (isDir(join(root, 'skills'))) capabilities.push('skills')
  if (isDir(join(root, 'commands'))) capabilities.push('commands')
  if (isFile(join(root, '.mcp.json'))) capabilities.push('mcp')
  return capabilities
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}
function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** What one successful fetch produced, decided by what landed on disk. */
export interface FetchPluginResult {
  /** Absolute directory holding the plugin content. */
  root: string
  capabilities: InstalledCapability[]
  /** Commit actually checked out, as reported by git. */
  resolvedSha: string
}

/** A repository's own metadata: an installed plugin is data, not a nested clone. */
const REPOSITORY_METADATA = '.git'

/**
 * Put fetched content at its final location.
 *
 * `destination` is replaced wholesale, so an earlier install cannot survive
 * underneath the new one, and a `.git` directory is left behind: what an install
 * owns is plugin content, and carrying a clone's remote url and object database
 * into it is neither wanted nor part of what the install record describes.
 *
 * @param from - directory holding the content to install.
 * @param destination - absolute directory to replace.
 */
function placeContent(from: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(join(destination, '..'), { recursive: true })
  cpSync(from, destination, {
    recursive: true,
    filter: entry => basename(entry) !== REPOSITORY_METADATA,
  })
}

/**
 * Fetch one plugin source into `destination`.
 *
 * Clones into a temporary directory first and moves the wanted subtree into
 * place, so a failed or partial fetch can never leave a half-populated install
 * directory that a later sync would treat as valid.
 *
 * @param source - the parsed source to fetch; a `local` source is copied out of
 * the directory the manifest named, while a git source must carry a pinned `sha`.
 * @param destination - absolute directory to populate; replaced wholesale so a
 * previous install cannot survive underneath the new one.
 * @returns where the content landed, what it carries, and the commit git
 * actually checked out.
 * @throws {PluginFetchError} when the source is unpinned, missing, or the
 * server hands back a commit other than the pinned one.
 */
export async function fetchPlugin(source: PluginSource, destination: string): Promise<FetchPluginResult> {
  if (source.kind === 'local') {
    if (!existsSync(source.path)) throw new PluginFetchError(`local source ${source.path} does not exist`)
    placeContent(source.path, destination)
    return { root: destination, capabilities: detectCapabilities(destination), resolvedSha: '' }
  }

  if (source.sha === undefined) {
    throw new PluginFetchError(
      `refusing to fetch ${source.url} without a pinned sha: an unpinned source resolves at fetch time and can change`,
    )
  }

  const scratch = mkdtempSync(join(tmpdir(), 'dsh-plugin-fetch-'))
  const work = scratch
  try {
    // Sparse checkout only when a subdirectory was named: a plain plugin repo
    // has no subtree to narrow to.
    if (source.subdirectory !== undefined) {
      await git(['init', '--quiet', work])
      await git(['remote', 'add', 'origin', source.url], work)
      await git(['sparse-checkout', 'init', '--cone'], work)
      await git(['sparse-checkout', 'set', '--cone', '--', source.subdirectory], work)
      // Try the exact commit first; a shallow fetch of a sha requires the server
      // to allow it, so fall back to a full fetch rather than failing outright.
      try {
        await git(['fetch', '--depth', '1', 'origin', source.sha], work)
      } catch {
        await git(['fetch', 'origin'], work)
      }
      await git(['checkout', '--quiet', source.sha], work)
    } else {
      await git(['clone', '--quiet', '--no-checkout', source.url, work])
      try {
        await git(['fetch', '--depth', '1', 'origin', source.sha], work)
      } catch {
        await git(['fetch', 'origin'], work)
      }
      await git(['checkout', '--quiet', source.sha], work)
    }

    // Verify we got the commit we asked for. A server that ignores the sha
    // would otherwise hand us different code than the manifest pinned.
    const head = (await git(['rev-parse', 'HEAD'], work)).trim()
    if (head !== source.sha) {
      throw new PluginFetchError(`checked out ${head} but ${source.sha} was pinned; refusing to install`)
    }

    const contentRoot = source.subdirectory === undefined ? work : join(work, source.subdirectory)
    if (!existsSync(contentRoot)) {
      throw new PluginFetchError(`subdirectory ${source.subdirectory} not present at ${source.sha}`)
    }

    placeContent(contentRoot, destination)

    return { root: destination, capabilities: detectCapabilities(destination), resolvedSha: head }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
