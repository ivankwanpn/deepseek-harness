import { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { describe, expect, it, vi } from 'vitest'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { apply as applyGateway, inject } from '@deepseek-ai/dsh-api-gateway/src/client/index.ts'
import { apply as applyRemotes } from '../src/client/index.ts'

/**
 * The Browser boot path: this assembly is what mounts the selected Remote
 * contributions, so a contribution whose method name collides with the
 * namespace service it publishes on fails the whole page, not one namespace.
 */
describe('Client Remote assembly', () => {
  it('mounts every selected contribution', async () => {
    const ctx = new Context()
    await ctx.plugin(TypertRegistry)
    const call = vi.fn<ConnectionHandle['rpc']['call']>()
    ctx.provide('connection', {
      rpc: { call, open: undefined },
      registerGenerationSource: () => () => {},
      start: () => ({ stop: () => {} }),
    } as unknown as ConnectionHandle)
    await ctx.plugin({ inject, apply: applyGateway })

    const dispose = await applyRemotes(ctx)

    const marketplace = ctx.get('remote.marketplace') as unknown as Record<string, unknown>
    expect(typeof marketplace.install).toBe('function')
    expect(typeof marketplace.uninstall).toBe('function')
    await dispose()
    expect(ctx.typert.remotes.list()).toEqual([])
  }, 60_000)
})
