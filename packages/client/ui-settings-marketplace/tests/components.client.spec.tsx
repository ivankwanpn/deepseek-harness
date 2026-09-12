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
import type { MarketplaceCatalogView, MarketplaceStatusView } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls this package's `settings.marketplace` LocaleNamespaceMap merge
// into the aggregate client program. Without it this test's program has no such
// namespace, and PropsLocale resolves to no `t` seat at all.
import type {} from '../src/client/index.ts'
import { matchesQuery } from '../src/client/CatalogSection.tsx'
import { MarketplaceSettingsTab } from '../src/client/MarketplaceSettingsTab.tsx'
import type {
  MarketplaceSettingsTabInjected,
  MarketplaceSettingsTabProps,
} from '../src/client/MarketplaceSettingsTab.tsx'
import { en, type MarketplaceLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const t = ((key: MarketplaceLocaleKey): string => en[key]) as MarketplaceSettingsTabProps['t']

/** A promise a case settles by hand, so it can assert the in-flight state. */
function deferred<T>(): { promise: Promise<T>; reject: (reason: Error) => void } {
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((_resolve, rejectPromise) => { reject = rejectPromise })
  return { promise, reject }
}

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

/**
 * The tab's complete props over one snapshot and stub Remote calls.
 *
 * Every Remote call the tab can make is a stub, so a case that asserts a call
 * was NOT made is asserting the panel's own behavior rather than a missing one.
 */
function props(
  overrides: Partial<MarketplaceSettingsTabInjected> = {},
  view: MarketplaceStatusView = status(),
): MarketplaceSettingsTabProps {
  return {
    t,
    status: async () => view,
    setEnabled: vi.fn(async () => ({ status: view }) as never),
    uninstall: vi.fn(async () => ({ status: view }) as never),
    catalog: vi.fn(async () => ({ rows: [], failed: [] })),
    install: vi.fn(async () => ({ plugin: 'commit-helper', warnings: [], status: view }) as never),
    ...overrides,
  } as unknown as MarketplaceSettingsTabProps
}

/** Render the tab over one snapshot and three stub Remote calls. */
function mount(view: MarketplaceStatusView, overrides: Partial<Pick<
  MarketplaceSettingsTabInjected,
  'setEnabled' | 'uninstall'
>> = {}) {
  const setEnabled = overrides.setEnabled ?? vi.fn(async () => ({ status: view }) as never)
  const uninstall = overrides.uninstall ?? vi.fn(async () => ({ status: view }) as never)
  render(<MarketplaceSettingsTab {...props({ setEnabled, uninstall }, view)} />)
  return { setEnabled, uninstall }
}

describe('marketplace controls', () => {
  // The factory above fills both lists, so the empty rendering — the one a
  // deployment with no marketplaces sees — had no case at all.
  it('says each list is empty instead of rendering a list with no entries', async () => {
    mount(status({ marketplaces: [], installed: [] }))

    expect(await screen.findByText(en.marketplacesEmpty)).toBeTruthy()
    expect(screen.getByText(en.installedEmpty)).toBeTruthy()
  })

  // The panel reads its snapshot on mount, so a refused read is the state a
  // deployment behind a broken transport lands in; the retry has to ask again
  // rather than re-render the failure.
  it('renders a refused read with a retry that asks the Host again', async () => {
    const reads = vi.fn()
      .mockRejectedValueOnce(new Error('transport down'))
      .mockResolvedValueOnce(status({ marketplaces: [], installed: [] }))
    render(<MarketplaceSettingsTab {...props({ status: reads })} />)

    expect(await screen.findByText(en.error)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: en.retry }))

    await waitFor(() => { expect(reads).toHaveBeenCalledTimes(2) })
    expect(await screen.findByText(en.marketplacesEmpty)).toBeTruthy()
  })

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

  // The dialog labels its close control and its cancel button with the same
  // copy, so the footer's cancel is the last control carrying that name.
  it('closes the uninstall confirmation without asking the Host', async () => {
    const { uninstall } = mount(status())

    fireEvent.click((await screen.findAllByRole('button', { name: 'Uninstall' }))[0]!)
    const dialog = await screen.findByRole('dialog', { name: /superpowers/u })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    const cancels = within(dialog).getAllByRole('button', { name: en.uninstallCancel })
    fireEvent.click(cancels[cancels.length - 1]!)

    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(uninstall).not.toHaveBeenCalled()
  })

  it('prints a refusal that is not an Error as its own text', async () => {
    const { uninstall } = mount(status(), {
      // The panel reports whatever the write threw, so a refusal that arrives as
      // a bare value still has to reach the card instead of a blank failure. The
      // bare value is the case under test here, not an oversight.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the rejection reason is the subject.
      uninstall: vi.fn(() => Promise.reject('marketplace refused')),
    })

    fireEvent.click((await screen.findAllByRole('button', { name: 'Uninstall' }))[0]!)
    const dialog = await screen.findByRole('dialog', { name: /superpowers/u })
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Uninstall' }))

    await waitFor(() => { expect(uninstall).toHaveBeenCalledWith('superpowers') })
    expect(await screen.findByText(/marketplace refused/u)).toBeTruthy()
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

describe('available plugins', () => {
  /** One catalog row, with the fields a case does not override left unremarkable. */
  function row(overrides: Partial<MarketplaceCatalogView['rows'][number]> = {}): MarketplaceCatalogView['rows'][number] {
    return {
      plugin: 'commit-helper',
      marketplace: 'official',
      description: 'commit flow',
      tags: [],
      installable: true,
      installed: false,
      warnings: [],
      ...overrides,
    }
  }

  /** Render the tab, ask for the catalog, and wait for the section to appear. */
  async function browse(catalog: MarketplaceSettingsTabInjected['catalog']): Promise<void> {
    render(<MarketplaceSettingsTab {...props({ catalog })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    expect(await screen.findByText('Available plugins')).toBeTruthy()
  }

  it('stays unloaded until asked, then renders rows and filters locally', async () => {
    const catalog = vi.fn(async () => ({
      rows: [
        { plugin: 'commit-helper', marketplace: 'official', description: 'commit flow', tags: [], installable: true, installed: false, warnings: [] },
        { plugin: 'deploy', marketplace: 'official', description: 'deploy flow', category: 'ops', tags: [], installable: true, installed: false, warnings: [] },
      ],
      failed: [],
    }))
    render(<MarketplaceSettingsTab {...props({ catalog })} />)
    await screen.findByText('superpowers')

    // Nothing is read until the user asks: the tab must not depend on the network.
    expect(catalog).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    expect(await screen.findByText('commit-helper')).toBeTruthy()
    expect(catalog).toHaveBeenCalledTimes(1)

    fireEvent.change(screen.getByPlaceholderText('Filter by name, description, category or tag'), { target: { value: 'ops' } })
    expect(screen.queryByText('commit-helper')).toBeNull()
    expect(screen.getByText('deploy')).toBeTruthy()
    // Filtering is local: one read for the whole interaction.
    expect(catalog).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed catalog read inside its own section', async () => {
    const catalog = vi.fn(async () => { throw new Error('gateway/internal: boom') })
    render(<MarketplaceSettingsTab {...props({ catalog })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))

    expect(await screen.findByText('Could not read the registered marketplaces.')).toBeTruthy()
    // The sections that read local state still render.
    expect(screen.getByText('superpowers')).toBeTruthy()
  })

  it('renders what each row carries, and names the marketplace it could not read', async () => {
    await browse(vi.fn(async () => ({
      rows: [
        // No description and no category: the row still renders its name.
        { plugin: 'installed-one', marketplace: 'official', tags: [], installable: true, installed: true, warnings: [] },
        row({ plugin: 'unpinned-one', marketplace: 'ops-inc', installable: false, warnings: ['no pinned revision'] }),
      ],
      failed: [{ marketplace: 'flaky', reason: 'git fetch failed' }],
    })))

    // Both badges state a fact the row cannot otherwise show.
    expect(screen.getByText('installed')).toBeTruthy()
    expect(screen.getByText('no pin')).toBeTruthy()
    expect(screen.getByText('no pinned revision')).toBeTruthy()
    // A marketplace that could not be read is named beside the ones that could.
    expect(screen.getByText('Could not read flaky: git fetch failed')).toBeTruthy()
  })

  it('says the registered marketplaces are empty when they offered nothing', async () => {
    await browse(vi.fn(async () => ({ rows: [], failed: [] })))

    expect(screen.getByText('Every registered marketplace is empty.')).toBeTruthy()
  })

  it('says nothing matched when the filter excludes every row it read', async () => {
    await browse(vi.fn(async () => ({ rows: [row()], failed: [] })))

    fireEvent.change(screen.getByPlaceholderText('Filter by name, description, category or tag'), { target: { value: 'aikido' } })

    expect(screen.getByText('No available plugin matches that filter.')).toBeTruthy()
    expect(screen.queryByText('commit-helper')).toBeNull()
  })

  it('keeps the rows it read on screen while a refresh runs, and when it fails', async () => {
    const refresh = deferred<MarketplaceCatalogView>()
    const catalog = vi.fn()
      .mockImplementationOnce(async () => ({ rows: [row()], failed: [] }))
      .mockImplementationOnce(() => refresh.promise)
    await browse(catalog)
    expect(await screen.findByText('commit-helper')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))

    // The rows already read stay up while the re-read runs: a refresh is not a
    // blank page, and its failure does not take back what is already known.
    expect(screen.getByText('Reading the marketplaces…')).toBeTruthy()
    expect(screen.getByText('commit-helper')).toBeTruthy()

    refresh.reject(new Error('gateway/internal: boom'))
    expect(await screen.findByText('Could not read the registered marketplaces.')).toBeTruthy()
    expect(screen.getByText('commit-helper')).toBeTruthy()
    expect(catalog).toHaveBeenCalledTimes(2)
  })
})

describe('catalog filter', () => {
  /** A row carrying every field the CLI searches. */
  const searchable: MarketplaceCatalogView['rows'][number] = {
    plugin: 'commit-helper',
    marketplace: 'official',
    description: 'commit flow',
    category: 'vcs',
    tags: ['git', 'hooks'],
    installable: true,
    installed: false,
    warnings: [],
  }

  it('matches the four fields the CLI searches, case-insensitively', () => {
    expect(matchesQuery(searchable, '')).toBe(true)
    expect(matchesQuery(searchable, 'COMMIT')).toBe(true)
    expect(matchesQuery(searchable, 'commit FLOW')).toBe(true)
    expect(matchesQuery(searchable, 'VCS')).toBe(true)
    expect(matchesQuery(searchable, 'hooks')).toBe(true)
    expect(matchesQuery(searchable, 'aikido')).toBe(false)
  })

  it('searches a row that states no description and no category', () => {
    const sparse: MarketplaceCatalogView['rows'][number] = {
      plugin: 'commit-helper',
      marketplace: 'official',
      tags: ['git', 'hooks'],
      installable: true,
      installed: false,
      warnings: [],
    }
    expect(matchesQuery(sparse, 'commit-helper')).toBe(true)
    expect(matchesQuery(sparse, 'hooks')).toBe(true)
    expect(matchesQuery(sparse, 'vcs')).toBe(false)
  })

  it('ignores whitespace around the filter, as the CLI does', () => {
    // The CLI trims the query it joined from its arguments; a stray leading or
    // trailing space in the panel must not become a filter that matches nothing.
    expect(matchesQuery(searchable, '  hooks  ')).toBe(true)
    expect(matchesQuery(searchable, ' commit flow ')).toBe(true)
    expect(matchesQuery(searchable, '  aikido  ')).toBe(false)
    // Whitespace alone is no filter at all, exactly as the empty query is.
    expect(matchesQuery(searchable, '   ')).toBe(true)
  })
})

describe('installing from the catalog', () => {
  const rows = [
    { plugin: 'commit-helper', marketplace: 'official', description: 'commit flow', tags: [], installable: true, installed: false, warnings: [] },
    { plugin: 'loose', marketplace: 'official', description: 'loose flow', tags: [], installable: false, installed: false, warnings: ['source "x" has no sha pin'] },
  ]

  it('installs a pinned entry in one call', async () => {
    const installed = status({
      installed: [{
        plugin: 'commit-helper',
        marketplace: 'official',
        sha: 'a'.repeat(40),
        installPath: 'C:\\plugins\\commit-helper',
        capabilities: [],
        rowIds: [],
        skillIds: [],
        state: 'no-rows',
        skills: 'none',
      }],
    })
    const install = vi.fn(async () => ({ plugin: 'commit-helper', sha: 'a'.repeat(40), warnings: [], status: installed }))
    render(<MarketplaceSettingsTab {...props({ catalog: vi.fn(async () => ({ rows, failed: [] })), install })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    await screen.findByText('commit-helper')

    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]!)
    await vi.waitFor(() => { expect(install).toHaveBeenCalledWith('commit-helper', false) })
    // No acknowledgement was asked for: a pinned entry installs in one call.
    expect(screen.queryByRole('dialog')).toBeNull()
    // The installed section renders the status the Host returned, not the one
    // the panel started from — 'superpowers' is gone with it.
    expect(await screen.findByText('C:\\plugins\\commit-helper')).toBeTruthy()
    expect(screen.queryByText('superpowers')).toBeNull()
    // A clean run leaves no failure line behind.
    expect(screen.queryByText(/Install failed/u)).toBeNull()
  })

  it('will not install an unpinned entry until it is acknowledged', async () => {
    const install = vi.fn(async () => ({ plugin: 'loose', sha: 'b'.repeat(40), warnings: [], status: status() }))
    render(<MarketplaceSettingsTab {...props({ catalog: vi.fn(async () => ({ rows, failed: [] })), install })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    await screen.findByText('loose')

    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[1]!)
    const confirm = await screen.findByRole('button', { name: 'Install anyway' })
    // Unavailable until the box is set: the permission IS the checkbox.
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    // A click while it is unavailable installs nothing at all.
    fireEvent.click(confirm)
    expect(install).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: 'I understand this entry is unpinned' }))
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(confirm)
    await vi.waitFor(() => { expect(install).toHaveBeenCalledWith('loose', true) })
  })

  it('shows a refusal against its own row', async () => {
    const install = vi.fn(async () => { throw new Error('marketplace/unpinned: refused') })
    render(<MarketplaceSettingsTab {...props({ catalog: vi.fn(async () => ({ rows, failed: [] })), install })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    await screen.findByText('commit-helper')
    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]!)
    const failure = await screen.findByText('Install failed: marketplace/unpinned: refused')
    // The refusal lands on the row that caused it, and on no other.
    expect(failure.closest('li')?.textContent).toContain('commit-helper')
    expect(screen.getAllByText(/Install failed/u)).toHaveLength(1)
  })

  it('installs nothing when the acknowledgement is cancelled', async () => {
    const install = vi.fn(async () => ({ plugin: 'loose', sha: 'b'.repeat(40), warnings: [], status: status() }))
    render(<MarketplaceSettingsTab {...props({ catalog: vi.fn(async () => ({ rows, failed: [] })), install })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    await screen.findByText('loose')

    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[1]!)
    const dialog = within(await screen.findByRole('dialog', { name: /loose/u }))
    // The header close control and the footer cancel share one label and one
    // handler, so either withdraws the request.
    fireEvent.click(dialog.getAllByRole('button', { name: 'Cancel' })[0]!)

    // Cancelling withdraws the request: the entry stays uninstalled and unpinned.
    expect(screen.queryByRole('dialog', { name: /loose/u })).toBeNull()
    expect(install).not.toHaveBeenCalled()
    expect(screen.getByText('no pin')).toBeTruthy()
  })

  it('reports a refusal that arrives as a bare value', async () => {
    const install = vi.fn(async () => { throw 'marketplace/unpinned: refused' })
    render(<MarketplaceSettingsTab {...props({ catalog: vi.fn(async () => ({ rows, failed: [] })), install })} />)
    await screen.findByText('superpowers')
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    await screen.findByText('commit-helper')
    fireEvent.click(screen.getAllByRole('button', { name: 'Install' })[0]!)
    expect(await screen.findByText('Install failed: marketplace/unpinned: refused')).toBeTruthy()
  })

  it('draws no install control when the deployment refuses writes', async () => {
    render(<MarketplaceSettingsTab {...props({ catalog: vi.fn(async () => ({ rows, failed: [] })) }, status({ allowMutations: false }))} />)
    await screen.findByText(/read-only/u)
    fireEvent.click(screen.getByRole('button', { name: 'Browse available plugins' }))
    await screen.findByText('commit-helper')

    // The Host would refuse every install; offering the button would be a
    // control whose only outcome is a refusal.
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
  })
})
