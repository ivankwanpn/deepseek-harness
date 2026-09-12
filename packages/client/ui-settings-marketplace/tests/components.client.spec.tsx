// @vitest-environment jsdom
/**
 * Presentation behavior of the marketplace tab's controls.
 *
 * The panel is a REQUEST surface: each test asserts what the panel asked the
 * Host for and what it rendered from the answer, never how it stored it. The
 * read-only case is the one worth having beyond the happy paths — a deployment
 * that refuses writes must not offer controls that would fail on every click.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketplaceStatusView } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls this package's `settings.marketplace` LocaleNamespaceMap merge
// into the aggregate client program. Without it this test's program has no such
// namespace, and PropsLocale resolves to no `t` seat at all.
import type {} from '../src/client/index.ts'
import { MarketplaceSettingsTab } from '../src/client/MarketplaceSettingsTab.tsx'
import type { MarketplaceSettingsTabProps } from '../src/client/MarketplaceSettingsTab.tsx'
import { en, type MarketplaceLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: MarketplaceLocaleKey): string => en[key]) as MarketplaceSettingsTabProps['t']

/** A skills-only plugin, an MCP plugin, and one that mounts nothing at all. */
function status(overrides: Partial<MarketplaceStatusView> = {}): MarketplaceStatusView {
  return {
    marketplaces: [{ name: 'claude-plugins-official', url: 'https://example.test/marketplace.json' }],
    installed: [
      {
        plugin: 'superpowers',
        marketplace: 'claude-plugins-official',
        sha: 'b36e0829',
        installPath: 'C:\\plugins\\superpowers',
        capabilities: ['skills'],
        rowIds: [],
        skillIds: ['brainstorming'],
        state: 'no-rows',
        skills: 'live',
      },
      {
        plugin: 'aikido',
        marketplace: 'claude-plugins-official',
        installPath: 'C:\\plugins\\aikido',
        capabilities: ['mcp'],
        rowIds: ['marketplace:mcp:aikido'],
        skillIds: [],
        state: 'enabled',
        skills: 'none',
      },
      {
        plugin: 'inert',
        marketplace: 'claude-plugins-official',
        installPath: 'C:\\plugins\\inert',
        capabilities: [],
        rowIds: [],
        skillIds: [],
        state: 'no-rows',
        skills: 'none',
      },
    ],
    allowMutations: true,
    ...overrides,
  }
}

/** Render the tab over one snapshot and three stub Remote calls. */
function mount(view: MarketplaceStatusView, overrides: Partial<{
  setEnabled: MarketplaceSettingsTabProps['setEnabled']
  uninstall: MarketplaceSettingsTabProps['uninstall']
}> = {}) {
  const setEnabled = overrides.setEnabled ?? vi.fn(async () => ({ status: view }) as never)
  const uninstall = overrides.uninstall ?? vi.fn(async () => ({ status: view }) as never)
  render(
    <MarketplaceSettingsTab
      {...({
        t,
        status: async () => view,
        setEnabled,
        uninstall,
      } as unknown as MarketplaceSettingsTabProps)}
    />,
  )
  return { setEnabled, uninstall }
}

describe('marketplace controls', () => {
  it('shows a toggle for every plugin that mounts something, and none for one that mounts nothing', async () => {
    mount(status())

    // The skills-only plugin is ON through its skills, and the MCP plugin
    // through its row: both need a control, because both can be turned off.
    const skillsToggle = await screen.findByRole('switch', { name: 'superpowers — Enabled' })
    expect(skillsToggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('switch', { name: 'aikido — Enabled' }).getAttribute('aria-checked')).toBe('true')

    // Nothing to toggle: offering a switch here would be a control that cannot
    // move anything.
    expect(screen.queryByRole('switch', { name: 'inert — Enabled' })).toBeNull()
    // It still has an uninstall, because a record exists to remove.
    expect(screen.getByText('inert')).toBeTruthy()
  })

  it('asks the Host for the opposite state and renders the status it returns', async () => {
    const disabled = status({
      installed: [
        {
          plugin: 'superpowers',
          marketplace: 'claude-plugins-official',
          installPath: 'C:\\plugins\\superpowers',
          capabilities: ['skills'],
          rowIds: [],
          skillIds: ['brainstorming'],
          state: 'no-rows',
          skills: 'parked',
        },
      ],
    })
    const { setEnabled } = mount(status(), { setEnabled: vi.fn(async () => ({ status: disabled }) as never) })

    fireEvent.click(await screen.findByRole('switch', { name: 'superpowers — Enabled' }))

    await waitFor(() => { expect(setEnabled).toHaveBeenCalledWith('superpowers', false) })
    // The panel renders the ANSWER, not the click: the switch follows the Host.
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'superpowers — Enabled' }).getAttribute('aria-checked')).toBe('false')
    })
    // And the fact behind it: parked skills, spelled out for the reader.
    expect(screen.getByText('parked')).toBeTruthy()
  })

  it('gates uninstall behind an explicit acknowledgement', async () => {
    const { uninstall } = mount(status())

    fireEvent.click((await screen.findAllByRole('button', { name: 'Uninstall' }))[0]!)

    const dialog = await screen.findByRole('dialog', { name: /superpowers/u })
    const confirm = within(dialog).getByRole('button', { name: 'Uninstall' })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)

    // Clicking confirm before acknowledging does nothing.
    fireEvent.click(confirm)
    expect(uninstall).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }))

    await waitFor(() => { expect(uninstall).toHaveBeenCalledWith('superpowers') })
  })

  it('reports a refused write on the plugin it was refused for', async () => {
    mount(status(), {
      setEnabled: vi.fn(async () => { throw new Error('marketplace/read-only: refused') }),
    })

    fireEvent.click(await screen.findByRole('switch', { name: 'aikido — Enabled' }))

    const failure = await screen.findByText(/marketplace\/read-only: refused/u)
    expect(failure.textContent).toContain('The action failed:')
    // The other cards are untouched: one refusal is not a page-level error.
    expect(screen.getByRole('switch', { name: 'superpowers — Enabled' })).toBeTruthy()
  })

  it('offers no controls at all when the deployment serves the panel read-only', async () => {
    mount(status({ allowMutations: false }))

    expect(await screen.findByText(/read-only/u)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Uninstall' })).toBeNull()
    // The read itself still renders: read-only is not the same as unavailable.
    expect(screen.getByText('superpowers')).toBeTruthy()
  })
})
