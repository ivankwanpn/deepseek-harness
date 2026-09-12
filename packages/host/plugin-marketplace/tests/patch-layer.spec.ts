/**
 * Behavioural cover for the user patch layer.
 *
 * The file these tests write is the user's own `cordis.patch.yml`, so every
 * assertion is made against the bytes on disk or against what a later
 * `parsePatchLayer` reads back. The two halves matter equally: a write must
 * change only the ids the marketplace owns and must carry a hand-set
 * `disabled` forward, and a REFUSAL must leave the user's file exactly as it
 * was — an unreadable document is never rewritten from a template, and a
 * composition that cannot be parsed back is never persisted.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  PatchLayerError,
  composePatchLayer,
  parsePatchLayer,
  presentIds,
  readEnabled,
  serializePatchLayer,
  setEnabled,
  writePatchLayerIfChanged,
  type ManagedRow,
} from '../src/patch-layer.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-patch-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Write a patch layer verbatim and return its path. */
function writeLayer(text: string): string {
  const path = join(scratch, 'cordis.patch.yml')
  writeFileSync(path, text, 'utf8')
  return path
}

/** One marketplace row as sync composes it. */
function row(id: string, name = '@deepseek-ai/dsh-mcp-client', config?: unknown): ManagedRow {
  return config === undefined ? { id, name } : { id, name, config }
}

describe('reading a user layer', () => {
  it('treats a missing file and a blank one as a first run', () => {
    expect(parsePatchLayer(join(scratch, 'absent.yml'))).toEqual({ patches: [], empty: true })
    expect(parsePatchLayer(writeLayer('   \n\n'))).toEqual({ patches: [], empty: true })
    // An empty document is the profile template's initial state.
    expect(parsePatchLayer(writeLayer('null\n'))).toEqual({ patches: [], empty: true })
  })

  it('refuses a document it cannot parse rather than rewriting it', () => {
    const path = writeLayer('foo: [1, 2\n')

    let thrown: unknown
    try {
      parsePatchLayer(path)
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(PatchLayerError)
    expect((thrown as PatchLayerError).name).toBe('PatchLayerError')
    expect((thrown as PatchLayerError).message).toContain('refusing to rewrite it')
    expect((thrown as PatchLayerError).cause).toBeInstanceOf(Error)
    // The user's bytes are untouched by the refusal.
    expect(readFileSync(path, 'utf8')).toBe('foo: [1, 2\n')
  })

  it('refuses a document that is not a YAML list', () => {
    const path = writeLayer('marketplace: everything\n')
    expect(() => parsePatchLayer(path)).toThrow(/is not a YAML list/)
  })

  it('refuses a layer it cannot read at all', () => {
    // A directory in the file's place: readable is not the same as readable as
    // YAML, and guessing here would overwrite whatever the user meant by it.
    const path = join(scratch, 'cordis.patch.yml')
    mkdirSync(path)

    expect(() => parsePatchLayer(path)).toThrow(PatchLayerError)
    expect(() => parsePatchLayer(path)).toThrow(/cannot read patch layer/)
  })
})

describe('reading enablement back', () => {
  const layer = [
    '- insert:',
    '    - id: marketplace:mcp:alpha',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '    - id: marketplace:mcp:beta',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      disabled: true',
    "- id: 'marketplace:mcp:ghost'",
    '  disabled: true',
    "- id: 'marketplace:mcp:retargeted'",
    '  insert:',
    '    - id: nested',
    '      name: nested-module',
    "- id: 'marketplace:mcp:silent'",
    '  config:',
    '    keep: true',
  ].join('\n')

  it('distinguishes absent, enabled and disabled', () => {
    const { patches, empty } = parsePatchLayer(writeLayer(`${layer}\n`))
    expect(empty).toBe(false)

    expect(readEnabled(patches, 'marketplace:mcp:alpha')).toBe(true)
    expect(readEnabled(patches, 'marketplace:mcp:beta')).toBe(false)
    // Nothing claims the id: "absent" must never read as "disabled".
    expect(readEnabled(patches, 'marketplace:mcp:nowhere')).toBeUndefined()
  })

  it('honours an id-targeted patch that flips enablement later in the file', () => {
    const { patches } = parsePatchLayer(writeLayer(`${layer}\n`))

    // A row can be toggled without being re-inserted, which is why the reading
    // does not stop at the root rows.
    expect(readEnabled(patches, 'marketplace:mcp:ghost')).toBe(false)
    // A patch that carries its own insert targets a group, not this id.
    expect(readEnabled(patches, 'marketplace:mcp:retargeted')).toBeUndefined()
    // A patch that says nothing about enablement says nothing.
    expect(readEnabled(patches, 'marketplace:mcp:silent')).toBeUndefined()
  })

  it('reports only the ids root rows occupy', () => {
    const { patches } = parsePatchLayer(writeLayer(`${layer}\n`))

    // `ghost` is named by a patch, not mounted by a root row; the nested insert
    // targets a group. Neither is an id a root insert could collide with.
    expect([...presentIds(patches)].sort()).toEqual(['marketplace:mcp:alpha', 'marketplace:mcp:beta'])
  })
})

describe('composing managed rows into a user layer', () => {
  it('keeps every user row in order and appends one insert', () => {
    const path = writeLayer([
      '- insert:',
      '    - id: user:one',
      '      name: user-module-one',
      '    - name: user-row-without-an-id',
      "- id: 'user-group'",
      '  config:',
      '    nested: true',
      '',
    ].join('\n'))
    const desired = [row('marketplace:mcp:alpha', '@deepseek-ai/dsh-mcp-client', { serverName: 'alpha' })]

    const composed = composePatchLayer(parsePatchLayer(path), desired)

    expect(composed.conflicts).toEqual([])
    expect(composed.changed).toBe(true)
    expect(composed.patches).toEqual([
      { insert: [{ id: 'user:one', name: 'user-module-one' }, { name: 'user-row-without-an-id' }] },
      { id: 'user-group', config: { nested: true } },
      { insert: [{ id: 'marketplace:mcp:alpha', name: '@deepseek-ai/dsh-mcp-client', config: { serverName: 'alpha' } }] },
    ])

    // And the bytes a write produces still parse back to the user's rows.
    expect(writePatchLayerIfChanged(path, composed)).toBe(true)
    const written = parsePatchLayer(path)
    expect(presentIds(written.patches)).toEqual(new Set(['user:one', 'marketplace:mcp:alpha']))
    expect(readEnabled(written.patches, 'marketplace:mcp:alpha')).toBe(true)
  })

  it('leaves a foreign row that occupies one of our ids alone and reports it', () => {
    const path = writeLayer([
      '- insert:',
      '    - id: marketplace:mcp:alpha',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '    - id: marketplace:mcp:beta',
      '      name: hand-written-module',
      '',
    ].join('\n'))
    const desired = [
      row('marketplace:mcp:alpha'),
      row('marketplace:mcp:beta'),
    ]

    const composed = composePatchLayer(parsePatchLayer(path), desired)

    expect(composed.conflicts).toEqual([
      'marketplace:mcp:beta is already mounted as hand-written-module; leaving it untouched',
    ])
    // Our own row is re-composed; the foreign owner keeps its mount and only the
    // rows we own are re-inserted.
    expect(composed.patches).toEqual([
      { insert: [{ id: 'marketplace:mcp:beta', name: 'hand-written-module' }] },
      { insert: [{ id: 'marketplace:mcp:alpha', name: '@deepseek-ai/dsh-mcp-client' }] },
    ])

    expect(writePatchLayerIfChanged(path, composed)).toBe(true)
    const written = parsePatchLayer(path)
    const rows = written.patches.flatMap(patch => Array.isArray(patch.insert) ? patch.insert : [])
    expect(rows.find(entry => entry.id === 'marketplace:mcp:beta')?.name).toBe('hand-written-module')
  })

  it('carries a hand-set disabled flag forward and writes no config key', () => {
    const path = writeLayer([
      '- insert:',
      '    - id: marketplace:mcp:alpha',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      disabled: true',
      '',
    ].join('\n'))

    const composed = composePatchLayer(parsePatchLayer(path), [row('marketplace:mcp:alpha')])

    // Nothing changed: the composed layer is byte-equal to the user's. Had the
    // `disabled` flag been dropped, this would report a change and rewrite a
    // hand-annotated file for nothing.
    expect(composed.changed).toBe(false)
    expect(composed.patches).toEqual([
      { insert: [{ id: 'marketplace:mcp:alpha', name: '@deepseek-ai/dsh-mcp-client', disabled: true }] },
    ])
  })

  it('omits the config key for a row that carries none', () => {
    const path = writeLayer([
      '- insert:',
      '    - id: marketplace:mcp:alpha',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: alpha',
      '',
    ].join('\n'))

    const composed = composePatchLayer(parsePatchLayer(path), [row('marketplace:mcp:alpha')])
    const [patch] = composed.patches
    const [composedRow] = patch?.insert ?? []

    expect(composed.changed).toBe(true)
    expect(composedRow).toEqual({ id: 'marketplace:mcp:alpha', name: '@deepseek-ai/dsh-mcp-client' })
    expect(composedRow !== undefined && 'config' in composedRow).toBe(false)
  })

  it('detects change canonically, so key order alone never rewrites the file', () => {
    // Perfectly valid YAML, and the same row: a comparison that depended on key
    // order would report a change and cost the user their comments.
    const path = writeLayer([
      '- insert:',
      "    - name: '@deepseek-ai/dsh-mcp-client'",
      '      id: marketplace:mcp:alpha',
      '',
    ].join('\n'))

    const composed = composePatchLayer(parsePatchLayer(path), [row('marketplace:mcp:alpha')])

    expect(composed.changed).toBe(false)
  })
})

describe('writing the layer', () => {
  it('writes nothing when the composition did not change', () => {
    const path = writeLayer('# hand-annotated\n[]\n')
    const before = readFileSync(path, 'utf8')
    const parsed = parsePatchLayer(path)

    expect(writePatchLayerIfChanged(path, { patches: parsed.patches, changed: false })).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('serializes the header with the rows, and `!!js` survives the round trip', () => {
    // `!!js` is the dialect's whole point: a config value the Loader evaluates,
    // printed verbatim rather than evaluated at write time.
    const patches = [{ insert: [{ id: 'x', name: 'mod', config: { cwd: { __jsExpr: 'process.cwd()' } } }] }]
    const text = serializePatchLayer(patches)

    expect(text.startsWith('# User patch layer — applied over every bundle layer of every profile.\n')).toBe(true)
    const reparsed = parsePatchLayer(writeLayer(text))
    expect(reparsed.patches).toEqual(patches)
  })

  it('refuses to persist a layer it cannot read back', () => {
    const path = writeLayer('# hand-annotated\n[]\n')
    const before = readFileSync(path, 'utf8')
    // A `!!js` node whose payload is not a scalar: the dump succeeds, the load
    // does not, which is exactly the serialization fault this guard exists for.
    const patches = [{ insert: [{ id: 'x', name: 'mod', config: { value: { __jsExpr: {} } } }] }]

    expect(() => writePatchLayerIfChanged(path, { patches, changed: true })).toThrow(PatchLayerError)
    expect(() => writePatchLayerIfChanged(path, { patches, changed: true })).toThrow(/does not round-trip/)
    // Nothing was persisted over the user's file.
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})

describe('setEnabled', () => {
  const layer = [
    '- insert:',
    '    - id: marketplace:mcp:alpha',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '    - id: user:one',
    '      name: user-module',
    "- id: 'user-group'",
    '  config:',
    '    x: 1',
    '',
  ].join('\n')

  /** The root row with this id, as a later read sees it. */
  function readRow(path: string, id: string): EntryOptions | undefined {
    return parsePatchLayer(path).patches
      .flatMap(patch => Array.isArray(patch.insert) ? patch.insert : [])
      .find(entry => entry.id === id)
  }

  it('returns false for a row the layer does not hold', () => {
    const path = writeLayer(layer)
    const before = readFileSync(path, 'utf8')

    expect(setEnabled(path, 'marketplace:mcp:absent', false)).toBe(false)

    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('rewrites exactly one row and leaves the user rows untouched', () => {
    const path = writeLayer(layer)

    expect(setEnabled(path, 'marketplace:mcp:alpha', false)).toBe(true)
    expect(readRow(path, 'marketplace:mcp:alpha')?.disabled).toBe(true)
    expect(readRow(path, 'user:one')).toEqual({ id: 'user:one', name: 'user-module' })
    expect(readEnabled(parsePatchLayer(path).patches, 'marketplace:mcp:alpha')).toBe(false)

    // Enabling omits the key rather than writing `disabled: false`, so an absent
    // key still means enabled and the emitted YAML stays clean.
    expect(setEnabled(path, 'marketplace:mcp:alpha', true)).toBe(true)
    const enabled = readRow(path, 'marketplace:mcp:alpha')
    expect(enabled?.disabled).toBeUndefined()
    expect(enabled !== undefined && 'disabled' in enabled).toBe(false)

    // Already in the requested state: the file is left alone.
    const settled = readFileSync(path, 'utf8')
    expect(setEnabled(path, 'marketplace:mcp:alpha', true)).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(settled)
  })

  it('returns false for a layer that does not exist yet', () => {
    expect(setEnabled(join(scratch, 'never-written.yml'), 'marketplace:mcp:alpha', false)).toBe(false)
  })
})
