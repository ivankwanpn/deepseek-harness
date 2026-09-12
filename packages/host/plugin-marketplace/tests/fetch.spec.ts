/**
 * Manifest fetching, url classification, and marketplace-relative source resolution.
 *
 * The transport is the one stubbed boundary — `fetch` is replaced with a function
 * that returns real `Response` objects and, for the abort cases, rejects exactly
 * when the real composed signal fires, which is the contract `fetch` itself
 * honours. Everything downstream is real: the size cap, the JSON decode, the
 * strict parse, the candidate loop, and the string mapping from a manifest url to
 * the repository and subdirectory an install would read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  candidateManifestUrls,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchMarketplace,
  fetchMarketplaceFrom,
  installSource,
  looksLikeManifestUrl,
  marketplaceRepoRoot,
  MAX_MANIFEST_BYTES,
  MarketplaceFetchError,
  resolveLocalSource,
} from '../src/fetch.ts'
import { MarketplaceParseError, parseEntry } from '../src/parse.ts'

/** A manifest url on GitHub, so a repository root is derivable from it. */
const MANIFEST_URL = 'https://github.com/example/registry/raw/main/.claude-plugin/marketplace.json'
/** The clone url {@link MANIFEST_URL} maps to. */
const REPO_URL = 'https://github.com/example/registry.git'

/** Every url the stubbed transport was asked for, in call order. */
const requested: string[] = []
/** Every init the stubbed transport was handed, in call order. */
const inits: (RequestInit | undefined)[] = []

/**
 * Answer every fetch from one handler.
 *
 * @param handler - produces the response for a url and the init the caller passed.
 */
function serve(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): void {
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    requested.push(url)
    inits.push(init)
    return Promise.resolve(handler(url, init))
  })
}

/**
 * The signal's abort reason as an Error.
 *
 * `AbortSignal.reason` is typed `any`. These cases abort with an Error, and the
 * coercion keeps every rejection in this file carrying one whatever a future
 * case passes.
 *
 * @param signal - the signal whose reason is being rejected with.
 * @returns the reason when it is an Error, otherwise an Error naming it.
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason))
}

/**
 * Reject when the composed signal aborts, exactly as `fetch` does.
 *
 * A signal that is already aborted at call time rejects immediately, so a case
 * that aborts around the call is not racing the transport.
 *
 * @param signal - the signal the caller composed.
 * @returns a promise that never resolves.
 */
function abortable(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal === null || signal === undefined) {
      reject(new Error('the caller passed no signal'))
      return
    }
    if (signal.aborted) {
      reject(abortReason(signal))
      return
    }
    signal.addEventListener('abort', () => { reject(abortReason(signal)) }, { once: true })
  })
}

beforeEach(() => {
  requested.length = 0
  inits.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchMarketplace', () => {
  it('fetches, follows redirects, and returns the parsed manifest', async () => {
    serve(() => new Response(JSON.stringify({
      name: 'official',
      plugins: [{ name: 'aikido', source: { url: 'https://example.test/aikido.git', ref: 'main' } }],
    }), { status: 200 }))

    const marketplace = await fetchMarketplace(MANIFEST_URL)

    expect(requested).toEqual([MANIFEST_URL])
    expect(inits[0]?.redirect).toBe('follow')
    // The body went through the real strict reader, so the warning an unpinned
    // entry earns is what the caller sees.
    expect(marketplace.name).toBe('official')
    expect(marketplace.plugins[0]?.warnings).toEqual(['git source has no sha pin'])
  })

  it('reports the transport fault through its cause', async () => {
    const cases: { thrown: unknown; expected: string }[] = []
    const dns = new Error('fetch failed')
    Object.assign(dns, { cause: { code: 'ENOTFOUND' } })
    cases.push({ thrown: dns, expected: 'ENOTFOUND' })
    const reset = new Error('fetch failed')
    Object.assign(reset, { cause: { message: 'socket hang up' } })
    cases.push({ thrown: reset, expected: 'socket hang up' })
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:9')
    cases.push({ thrown: refused, expected: 'connect ECONNREFUSED 127.0.0.1:9' })
    // A transport that rejects with something other than an Error still has to
    // produce a diagnostic rather than "undefined".
    cases.push({ thrown: 'boom', expected: 'boom' })

    for (const { thrown, expected } of cases) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the last case rejects with a non-Error on purpose.
      serve(() => Promise.reject(thrown))
      let caught: unknown
      try {
        await fetchMarketplace(MANIFEST_URL)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(MarketplaceFetchError)
      expect((caught as MarketplaceFetchError).message).toBe(`cannot reach ${MANIFEST_URL}: ${expected}`)
      expect((caught as MarketplaceFetchError).cause).toBe(thrown)
    }
  })

  it('reports a caller cancel as a cancel, not as a network fault', async () => {
    serve((_url, init) => abortable(init?.signal))
    const controller = new AbortController()
    const pending = fetchMarketplace(MANIFEST_URL, { signal: controller.signal })
    controller.abort(new Error('operator pressed Ctrl-C'))

    let caught: unknown
    try {
      await pending
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MarketplaceFetchError)
    expect((caught as MarketplaceFetchError).message).toBe(`cancelled while fetching ${MANIFEST_URL}`)
  })

  it('enforces the fetch budget with the composed timeout signal', async () => {
    let reason = ''
    serve((_url, init) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (signal === null || signal === undefined) throw new Error('the caller passed no signal')
      signal.addEventListener('abort', () => {
        reason = abortReason(signal).message
        reject(abortReason(signal))
      }, { once: true })
    }))

    let caught: unknown
    try {
      await fetchMarketplace(MANIFEST_URL, { timeoutMs: 5 })
    } catch (error) {
      caught = error
    }
    // The timeout fired while the caller's own signal stayed live, so this is a
    // reach failure with the deadline's reason — never a reported cancel.
    expect(reason).not.toBe('')
    expect(caught).toBeInstanceOf(MarketplaceFetchError)
    expect((caught as MarketplaceFetchError).message).toBe(`cannot reach ${MANIFEST_URL}: ${reason}`)
  })

  it('uses the default budget when the caller sets none', async () => {
    expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThan(0)
    serve(() => new Response('{"name":"official","plugins":[]}', { status: 200 }))
    await expect(fetchMarketplace(MANIFEST_URL)).resolves.toMatchObject({ name: 'official' })
  })

  it('refuses a non-ok response, naming the status', async () => {
    serve(() => new Response('missing', { status: 404, statusText: 'Not Found' }))
    await expect(fetchMarketplace(MANIFEST_URL))
      .rejects.toThrow(new MarketplaceFetchError(`${MANIFEST_URL} answered HTTP 404 Not Found`))

    serve(() => new Response('boom', { status: 500 }))
    await expect(fetchMarketplace(MANIFEST_URL))
      .rejects.toThrow(new MarketplaceFetchError(`${MANIFEST_URL} answered HTTP 500`))
  })

  it('refuses a manifest whose declared length is over the cap', async () => {
    serve(() => new Response('{}', {
      status: 200,
      headers: { 'content-length': String(MAX_MANIFEST_BYTES + 1) },
    }))
    await expect(fetchMarketplace(MANIFEST_URL)).rejects.toThrow(new MarketplaceFetchError(
      `${MANIFEST_URL} declares ${String(MAX_MANIFEST_BYTES + 1)} bytes, over the ${String(MAX_MANIFEST_BYTES)} limit`,
    ))
  })

  it('ignores a content-length it cannot read as a number', async () => {
    serve(() => new Response('{"name":"official","plugins":[]}', {
      status: 200,
      headers: { 'content-length': 'unknown' },
    }))
    await expect(fetchMarketplace(MANIFEST_URL)).resolves.toMatchObject({ name: 'official' })
  })

  it('refuses a body over the cap even when no length was declared', async () => {
    const oversized = 'x'.repeat(MAX_MANIFEST_BYTES + 1)
    serve(() => new Response(oversized, { status: 200 }))
    await expect(fetchMarketplace(MANIFEST_URL)).rejects.toThrow(new MarketplaceFetchError(
      `${MANIFEST_URL} returned ${String(oversized.length)} bytes, over the ${String(MAX_MANIFEST_BYTES)} limit`,
    ))
  })

  it('refuses a body that is not JSON', async () => {
    serve(() => new Response('<html>not a manifest</html>', { status: 200 }))
    let caught: unknown
    try {
      await fetchMarketplace(MANIFEST_URL)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MarketplaceFetchError)
    expect((caught as MarketplaceFetchError).message).toBe(`${MANIFEST_URL} did not return JSON`)
    expect((caught as MarketplaceFetchError).cause).toBeInstanceOf(SyntaxError)
  })

  it('attributes a malformed manifest to the url it was read from', async () => {
    serve(() => new Response('{"plugins":[]}', { status: 200 }))
    let caught: unknown
    try {
      await fetchMarketplace(MANIFEST_URL)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MarketplaceParseError)
    expect((caught as MarketplaceParseError).message)
      .toBe(`${MANIFEST_URL}: marketplace document has no name`)
  })
})

describe('fetchMarketplaceFrom', () => {
  it('reads a manifest url directly and reports it as the origin', async () => {
    serve(() => new Response('{"name":"official","plugins":[]}', { status: 200 }))
    await expect(fetchMarketplaceFrom(MANIFEST_URL))
      .resolves.toMatchObject({ manifestUrl: MANIFEST_URL, marketplace: { name: 'official' } })
    expect(requested).toEqual([MANIFEST_URL])
  })

  it('reads a raw-content url that does not end in .json', async () => {
    const raw = 'https://example.test/raw/main/manifest'
    serve(() => new Response('{"name":"official","plugins":[]}', { status: 200 }))
    await expect(fetchMarketplaceFrom(raw)).resolves.toMatchObject({ manifestUrl: raw })
    expect(requested).toEqual([raw])
  })

  it('tries the conventional manifest path before the repository root', async () => {
    const [conventional, root] = candidateManifestUrls('https://github.com/example/registry')
    serve(url => url === conventional
      ? new Response('missing', { status: 404, statusText: 'Not Found' })
      : new Response('{"name":"official","plugins":[]}', { status: 200 }))

    await expect(fetchMarketplaceFrom('https://github.com/example/registry'))
      .resolves.toMatchObject({ manifestUrl: root })
    expect(requested).toEqual([conventional, root])
  })

  it('reports every candidate it tried when none answered', async () => {
    serve(() => new Response('missing', { status: 404, statusText: 'Not Found' }))
    const [conventional, root] = candidateManifestUrls('https://github.com/example/registry')

    let caught: unknown
    try {
      await fetchMarketplaceFrom('https://github.com/example/registry')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(MarketplaceFetchError)
    expect((caught as MarketplaceFetchError).message).toBe(
      'no marketplace manifest at https://github.com/example/registry:\n'
      + `  ${conventional} → ${conventional} answered HTTP 404 Not Found\n`
      + `  ${root} → ${root} answered HTTP 404 Not Found`,
    )
  })

  it('refuses a spec that is neither a manifest url nor a GitHub repository', async () => {
    serve(() => new Response('{}', { status: 200 }))
    await expect(fetchMarketplaceFrom('https://gitlab.example.test/example/registry'))
      .rejects.toThrow(new MarketplaceFetchError(
        'https://gitlab.example.test/example/registry is neither a manifest url (…json) nor a GitHub repository;'
        + ' pass the full url of the marketplace.json',
      ))
    expect(requested).toEqual([])
  })
})

describe('candidateManifestUrls', () => {
  it('derives the two candidate urls for a GitHub repository, conventional first', () => {
    for (const spec of [
      'https://github.com/example/registry',
      'https://github.com/example/registry/',
      'https://github.com/example/registry.git',
    ]) {
      expect(candidateManifestUrls(spec)).toEqual([
        'https://github.com/example/registry/raw/main/.claude-plugin/marketplace.json',
        'https://github.com/example/registry/raw/main/marketplace.json',
      ])
    }
    // The host test is case-insensitive and the url is rewritten verbatim, so a
    // user who capitalizes the host still gets candidates rather than none.
    expect(candidateManifestUrls('http://GitHub.com/example/registry')).toEqual([
      'http://GitHub.com/example/registry/raw/main/.claude-plugin/marketplace.json',
      'http://GitHub.com/example/registry/raw/main/marketplace.json',
    ])
  })

  it('derives nothing for a host whose raw-content rule it does not know', () => {
    expect(candidateManifestUrls('https://gitlab.example.test/example/registry')).toEqual([])
    expect(candidateManifestUrls('git@github.com:example/registry.git')).toEqual([])
  })
})

describe('looksLikeManifestUrl', () => {
  it('accepts a JSON document and a raw-content path, and nothing else', () => {
    expect(looksLikeManifestUrl('https://example.test/marketplace.json')).toBe(true)
    expect(looksLikeManifestUrl('https://example.test/marketplace.json?ref=main')).toBe(true)
    expect(looksLikeManifestUrl('https://example.test/raw/main/marketplace')).toBe(true)
    expect(looksLikeManifestUrl('https://raw.githubusercontent.com/example/registry/main/marketplace')).toBe(true)
    expect(looksLikeManifestUrl('https://github.com/example/registry')).toBe(false)
    expect(looksLikeManifestUrl('https://example.test/plugin.json.txt')).toBe(false)
  })
})

describe('marketplaceRepoRoot', () => {
  it('maps a manifest url to the repository that holds it', () => {
    expect(marketplaceRepoRoot(MANIFEST_URL)).toBe(REPO_URL)
    expect(marketplaceRepoRoot('https://github.com/example/registry/raw/main/marketplace.json')).toBe(REPO_URL)
    expect(marketplaceRepoRoot('https://github.com/example/registry/blob/main/.claude-plugin/marketplace.json')).toBe(REPO_URL)
    expect(marketplaceRepoRoot('https://raw.githubusercontent.com/example/registry/main/marketplace.json')).toBe(REPO_URL)
    expect(marketplaceRepoRoot('https://raw.githubusercontent.com/example/registry/main/.claude-plugin/marketplace.json')).toBe(REPO_URL)
  })

  it('refuses to guess a root from a url that names no manifest location', () => {
    expect(marketplaceRepoRoot('https://example.test/manifest.json')).toBeUndefined()
    expect(marketplaceRepoRoot('https://github.com/example/registry')).toBeUndefined()
    // A raw url on an unrelated host is not one this package has a rule for.
    expect(marketplaceRepoRoot('https://example.test/raw/main/marketplace.json')).toBeUndefined()
  })
})

describe('resolveLocalSource', () => {
  it('re-expresses a repository-relative path as a subdirectory of the marketplace repository', () => {
    expect(resolveLocalSource('./plugins/x', REPO_URL)).toEqual({ kind: 'git', url: REPO_URL, subdirectory: 'plugins/x' })
    expect(resolveLocalSource('/plugins/x', REPO_URL)).toEqual({ kind: 'git', url: REPO_URL, subdirectory: 'plugins/x' })
    expect(resolveLocalSource('./plugins/x', REPO_URL, 'main')).toEqual({ kind: 'git', url: REPO_URL, subdirectory: 'plugins/x', ref: 'main' })
  })

  it('refuses a path it cannot turn into a subtree', () => {
    expect(resolveLocalSource('./plugins/x', undefined)).toBeUndefined()
    expect(resolveLocalSource('./', REPO_URL)).toBeUndefined()
    expect(resolveLocalSource('/../escape', REPO_URL)).toBeUndefined()
  })
})

describe('installSource', () => {
  it('leaves a git source exactly as the manifest declared it', () => {
    const entry = parseEntry({ name: 'aikido', source: { url: 'https://example.test/aikido.git', sha: 'a'.repeat(40) } }, 0)
    expect(installSource(entry, MANIFEST_URL)).toEqual(entry.source)
  })

  it('resolves a marketplace-relative local source against the marketplace repository', () => {
    const entry = parseEntry({ name: 'relative', source: './plugins/relative' }, 0)
    expect(installSource(entry, MANIFEST_URL))
      .toEqual({ kind: 'git', url: REPO_URL, subdirectory: 'plugins/relative' })
  })

  it('keeps a local source whose manifest url names no repository', () => {
    const entry = parseEntry({ name: 'local', source: './plugins/local' }, 0)
    expect(installSource(entry, 'https://example.test/marketplace.json')).toEqual({ kind: 'local', path: './plugins/local' })
  })
})
