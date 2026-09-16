import { describe, expect, it } from 'vitest'
import type { SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import { releasedV4SessionFormatCodec, assertReleasedV4Header } from '../src/index.ts'

const header: SessionFormatHeader = { version: 4, id: 'identity', createdAt: 1, isSeeded: false, delegationDepth: 0 }

describe('released v4 codec', () => {
  it('accepts a v4 header and refuses a v3 header', () => {
    expect(() => assertReleasedV4Header(header)).not.toThrow()
    expect(() => assertReleasedV4Header({ ...header, version: 3 })).toThrow('expected format v4 header')
  })

  it('round-trips a physical header at version 4', () => {
    const physical = releasedV4SessionFormatCodec.encodeHeader(header, 0)
    expect(physical['version']).toBe(4)
    expect(releasedV4SessionFormatCodec.decodeHeader(physical).version).toBe(4)
  })
})
