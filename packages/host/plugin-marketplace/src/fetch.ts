/**
 * Fetch a marketplace manifest.
 *
 * Uses plain `fetch`, which means it inherits the process-wide proxy policy
 * `installProxyFromEnvironment` installed at launch (see
 * packages/util/http-proxy). Building a transport here would silently bypass
 * that policy and fail on exactly the networks the policy exists for — the
 * failure mode behind deepseek-harness discussion #175.
 *
 * The manifest is UNTRUSTED input: it arrives from a third-party repository and
 * its `source` fields later become git URLs and filesystem paths. So parsing is
 * strict (see parse.ts) and nothing here writes to disk or executes anything.
 */
import { MarketplaceParseError, parseMarketplace, type Marketplace, type PluginSource } from './parse.ts'

/** Hard cap so a hostile or broken endpoint cannot exhaust memory. */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024

/** Default network budget; a manifest is small and static. */
export const DEFAULT_FETCH_TIMEOUT_MS = 20_000

/** Raised when a manifest cannot be retrieved, or is over the size limit. */
export class MarketplaceFetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'MarketplaceFetchError'
  }
}

/** Caller-tunable network budget and cancellation for one manifest fetch. */
export interface FetchOptions {
  timeoutMs?: number
  /** Caller abort (e.g. Ctrl-C); composed with the timeout signal. */
  signal?: AbortSignal
}

/**
 * Fetch and parse a marketplace document.
 *
 * @param url - absolute url of the `marketplace.json` document to read.
 * @param options - network budget and an optional caller abort signal.
 * @returns the parsed manifest, with every source pinned.
 * @throws {MarketplaceFetchError} on transport/status/size failure.
 * @throws {MarketplaceParseError} when the body is not a valid manifest.
 */
export async function fetchMarketplace(url: string, options: FetchOptions = {}): Promise<Marketplace> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal])

  let response: Response
  try {
    response = await fetch(url, { signal, redirect: 'follow' })
  } catch (error) {
    // Distinguish our own abort from a transport fault: reporting a caller
    // cancel as a network error sends the operator hunting a problem that
    // does not exist.
    if (options.signal?.aborted === true) throw new MarketplaceFetchError(`cancelled while fetching ${url}`, { cause: error })
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error))
    throw new MarketplaceFetchError(`cannot reach ${url}: ${detail}`, { cause: error })
  }

  if (!response.ok) {
    throw new MarketplaceFetchError(`${url} answered HTTP ${String(response.status)} ${response.statusText}`.trim())
  }

  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_MANIFEST_BYTES) {
    throw new MarketplaceFetchError(`${url} declares ${String(declared)} bytes, over the ${String(MAX_MANIFEST_BYTES)} limit`)
  }

  const body = await response.text()
  if (body.length > MAX_MANIFEST_BYTES) {
    throw new MarketplaceFetchError(`${url} returned ${String(body.length)} bytes, over the ${String(MAX_MANIFEST_BYTES)} limit`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch (error) {
    throw new MarketplaceFetchError(`${url} did not return JSON`, { cause: error })
  }

  try {
    return parseMarketplace(raw)
  } catch (error) {
    if (error instanceof MarketplaceParseError) {
      throw new MarketplaceParseError(`${url}: ${error.message}`)
    }
    throw error
  }
}

/**
 * Well-known manifest locations for a GitHub repository.
 *
 * Both the official registry and third-party marketplaces put the document at
 * `.claude-plugin/marketplace.json`; the bare root path is included because
 * several vendors publish it there instead. Order matters: the conventional
 * path wins.
 *
 * Only GitHub's `raw` host is derived automatically. A general host would need
 * a per-provider rule (GitLab and Bitbucket differ), so an explicit manifest URL
 * is the supported way to point at anything else.
 *
 * @param repoUrl - the repository url to derive manifest locations for.
 * @returns the candidate urls in preference order, conventional path first; an
 * empty list when the host is not GitHub and no rule applies.
 */
export function candidateManifestUrls(repoUrl: string): string[] {
  const base = repoUrl.replace(/\.git$/, '').replace(/\/$/, '')
  if (!/^https?:\/\/github\.com\//i.test(base)) return []
  return [`${base}/raw/main/.claude-plugin/marketplace.json`, `${base}/raw/main/marketplace.json`]
}

/**
 * True when the url already points at a JSON document rather than a repository.
 * @param url - the spec the user typed.
 * @returns true when it ends in `.json` or addresses a raw-content host, so it
 * can be fetched directly instead of being expanded into candidates.
 */
export function looksLikeManifestUrl(url: string): boolean {
  return /\.json(\?|$)/i.test(url) || /\/(raw|raw\.githubusercontent\.com)\//i.test(url)
}

/** Manifest locations {@link marketplaceRepoRoot} knows how to strip. */
const MANIFEST_SUFFIXES = ['/.claude-plugin/marketplace.json', '/marketplace.json']

/**
 * Turn a manifest url into a clone url for the repository holding it.
 *
 * Not a string append: the url a manifest is READ from is a raw-content url
 * (`…/raw/main/…` or `raw.githubusercontent.com/…`), which is not a repository
 * and does not become one by adding `.git`. Suspending judgement rather than
 * guessing matters here because the result is handed to `git` and a wrong host
 * would clone something unrelated.
 *
 * @param manifestUrl - the url the manifest was read from.
 * @returns the clone url, or undefined when its host is not one we have a rule
 * for. Only GitHub is derived, matching candidateManifestUrls.
 */
function cloneUrlFrom(manifestUrl: string): string | undefined {
  const decoded = decodeURIComponent(manifestUrl)
  // Capture groups are destructured rather than indexed: an indexed group is
  // `string | undefined` even inside a successful match, and a non-null
  // assertion to silence that is what the lint rule forbids. Both groups are
  // mandatory in their pattern, so a match implies both are present.
  // exec returns null on no match, not undefined, so the guard is truthiness.
  const github = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/(?:raw|blob|tree)\/.*)?$/i.exec(decoded)
  if (github) {
    const [, owner, repo] = github
    if (owner !== undefined && repo !== undefined) return `https://github.com/${owner}/${repo}.git`
  }
  // A raw host is derived rather than stripped, so it reuses the same form as
  // the github.com rule above instead of relying on a string replace.
  const raw = /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+?)(?:\/.*)?$/i.exec(decoded)
  if (raw) {
    const [, owner, repo] = raw
    if (owner !== undefined && repo !== undefined) return `https://github.com/${owner}/${repo}.git`
  }
  return undefined
}

/**
 * The repository a marketplace manifest lives in.
 *
 * Needed because the marketplace format defines a relative `local` source
 * (`./plugins/x`) against the MARKETPLACE ROOT, not the process working
 * directory. Measured against the official registry: 52 of 294 entries use that
 * form, and every one of them is uninstallable without this.
 *
 * @param manifestUrl - the url the manifest was actually read from.
 * @returns the repository root url, or undefined when the url does not name a
 * recognizable manifest location — guessing a root from an arbitrary url would
 * resolve plugin paths against the wrong repository.
 */
export function marketplaceRepoRoot(manifestUrl: string): string | undefined {
  for (const suffix of MANIFEST_SUFFIXES) {
    if (manifestUrl.endsWith(suffix)) return cloneUrlFrom(manifestUrl)
  }
  return undefined
}

/**
 * Resolve a `local` source path from a manifest against its marketplace root.
 *
 * A repository-root-relative path is re-expressed as a git subdir of the
 * marketplace repository, which is the only way to fetch it: the path names
 * content inside a repository we already know how to read.
 *
 * The manifest's `ref` is carried across when it declared one, so an entry that
 * named a branch still resolves against that branch. No `sha` is invented here:
 * resolving a revision belongs to install, where it can be recorded.
 *
 * @param raw - the source path exactly as the manifest declared it.
 * @param repoUrl - the marketplace clone url, from marketplaceRepoRoot.
 * @param ref - the branch or tag the manifest named, when it named one.
 * @returns a git subdir source, or undefined when the path is not a relative
 * one or no clone url is known.
 */
export function resolveLocalSource(
  raw: string,
  repoUrl: string | undefined,
  ref?: string,
): PluginSource | undefined {
  if (repoUrl === undefined) return undefined
  const subdirectory = raw.replace(/^\.\//, '').replace(/^\//, '')
  if (subdirectory === '' || subdirectory.startsWith('../')) return undefined
  return { kind: 'git', url: repoUrl, subdirectory, ...(ref !== undefined ? { ref } : {}) }
}

/**
 * Fetch a marketplace from EITHER a manifest url or a repository url.
 *
 * A repo url is the form a user naturally types (`anthropics/claude-plugins-official`),
 * so it has to be resolved rather than rejected. Each candidate is tried in
 * turn; the collected reasons are reported together so a failure says what was
 * actually attempted instead of only naming the last one.
 *
 * @param spec - either a direct manifest url or a GitHub repository url.
 * @param options - network budget and an optional caller abort signal, applied
 * to each candidate attempt.
 * @returns the parsed manifest together with the url it was actually read from,
 * which is what `add` records as the marketplace's origin.
 * @throws {MarketplaceFetchError} when the spec is neither form, or every
 * candidate failed.
 */
export async function fetchMarketplaceFrom(
  spec: string,
  options: FetchOptions = {},
): Promise<{ marketplace: Marketplace; manifestUrl: string }> {
  if (looksLikeManifestUrl(spec)) {
    return { marketplace: await fetchMarketplace(spec, options), manifestUrl: spec }
  }
  const candidates = candidateManifestUrls(spec)
  if (candidates.length === 0) {
    throw new MarketplaceFetchError(
      `${spec} is neither a manifest url (…json) nor a GitHub repository; pass the full url of the marketplace.json`,
    )
  }
  const attempts: string[] = []
  for (const candidate of candidates) {
    try {
      return { marketplace: await fetchMarketplace(candidate, options), manifestUrl: candidate }
    } catch (error) {
      attempts.push(`${candidate} → ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new MarketplaceFetchError(`no marketplace manifest at ${spec}:\n  ${attempts.join('\n  ')}`)
}
