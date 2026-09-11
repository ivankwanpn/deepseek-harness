/**
 * Regression cover for WHERE a materialized skill lands.
 *
 * The bug these pin was invisible from the inside: `install` reported success,
 * the state recorded the `skills` capability, the settings panel showed the
 * plugin installed — and the model was never offered a single skill, because the
 * files were copied one directory deeper than the discovery provider reads.
 *
 * Every assertion therefore runs the REAL provider (`dsh-skill-filesystem` over
 * the `dsh-skill` registry) and asks it what it discovered, rather than
 * restating the layout rule as a path literal that could drift from it.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as SkillFileSystem from '@deepseek-ai/dsh-skill-filesystem'
import { uninstallPlugin } from '../src/install.ts'
import {
  materializeEntry,
  removeMaterializedSkills,
  setSkillsEnabled,
  skillEntryNames,
  skillsEnabled,
  type MaterializeOptions,
} from '../src/materialize.ts'
import { emptyState, rowIdFor, upsertInstalled, type InstalledEntry } from '../src/state.ts'
import { sync } from '../src/sync.ts'

let scratch: string

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-marketplace-skills-'))
})

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** The root both this package's materializer and the provider are pointed at. */
function options(): MaterializeOptions {
  return { harnessHome: scratch, agentsSkillsDir: join(scratch, '.agents', 'skills') }
}

/**
 * What the real discovery provider sees at that root.
 *
 * `cwd` is deliberately omitted so only the user roots are scanned: a project
 * root would make the result depend on the repository this spec runs in.
 *
 * @returns the discovered skill names, in catalog order.
 */
async function discovered(): Promise<string[]> {
  const ctx = new Context()
  await ctx.plugin(SkillRegistry)
  await ctx.plugin(SkillFileSystem, {
    dshHome: join(scratch, '.dsh'),
    agentsHome: join(scratch, '.agents'),
    watch: false,
  })
  return (await ctx.skills.list()).map(skill => skill.name)
}

/**
 * A plugin directory shipping one `SKILL.md` per named skill.
 *
 * @param plugin - directory name under the scratch install root.
 * @param skills - skill directory name to frontmatter description.
 * @returns the plugin's directory.
 */
function pluginWithSkills(plugin: string, skills: Record<string, string>): string {
  const root = join(scratch, 'plugins', plugin)
  for (const [name, description] of Object.entries(skills)) {
    const dir = join(root, 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`, 'utf8')
  }
  return root
}

/** An installed record with the `skills` capability already detected. */
function entryFor(plugin: string, installPath: string): InstalledEntry {
  return {
    id: rowIdFor(plugin),
    marketplace: 'test',
    plugin,
    sourceUrl: 'https://example.test/plugin.git',
    installPath,
    capabilities: ['skills'],
    installedAt: new Date(0).toISOString(),
  }
}

describe('skill materialization reaches discovery', () => {
  it('materializes each skill directly under the root, where the provider reads it', async () => {
    const installPath = pluginWithSkills('superpowers', {
      brainstorming: 'Explore intent before implementation.',
      'test-driven-development': 'Write the failing test first.',
    })

    const result = materializeEntry(entryFor('superpowers', installPath), options())

    expect(result.skillIds).toEqual(['brainstorming', 'test-driven-development'])
    // The assertion that fails against the plugin-scoped layout: the provider
    // reads ONE level, so `<root>/superpowers/brainstorming/SKILL.md` offered
    // the model nothing at all.
    await expect(discovered()).resolves.toEqual(['brainstorming', 'test-driven-development'])
  })

  it('leaves nothing behind for a skill the plugin stopped shipping', async () => {
    const installPath = pluginWithSkills('shrinking', { kept: 'Still here.', dropped: 'Gone next release.' })
    const withBoth = materializeEntry(entryFor('shrinking', installPath), options())
    expect(withBoth.skillIds).toEqual(['dropped', 'kept'])

    rmSync(join(installPath, 'skills', 'dropped'), { recursive: true, force: true })
    const entry: InstalledEntry = { ...entryFor('shrinking', installPath), skillIds: withBoth.skillIds }
    const result = materializeEntry(entry, options())

    expect(result.skillIds).toEqual(['kept'])
    await expect(discovered()).resolves.toEqual(['kept'])
  })

  it('reports content discovery cannot see instead of copying it silently', () => {
    const installPath = pluginWithSkills('odd', { real: 'Discoverable.' })
    // A directory without a top-level SKILL.md, and a non-Markdown file: neither
    // is a skill the provider would ever offer.
    mkdirSync(join(installPath, 'skills', 'docs'), { recursive: true })
    writeFileSync(join(installPath, 'skills', 'notes.txt'), 'not a skill', 'utf8')

    const result = materializeEntry(entryFor('odd', installPath), options())

    expect(result.skillIds).toEqual(['real'])
    expect(result.warnings.join(' ')).toContain('skills/docs ships no SKILL.md and is not discoverable')
    expect(result.warnings.join(' ')).toContain('skills/notes.txt ships no SKILL.md and is not discoverable')
  })

  it('materializes a flat Markdown skill the plugin ships as a file', async () => {
    const installPath = join(scratch, 'plugins', 'flat', 'skills')
    mkdirSync(installPath, { recursive: true })
    writeFileSync(
      join(installPath, 'single.md'),
      '---\nname: single\ndescription: One file.\n---\n\nBody.\n',
      'utf8',
    )

    const result = materializeEntry(entryFor('flat', join(scratch, 'plugins', 'flat')), options())

    expect(result.skillIds).toEqual(['single.md'])
    await expect(discovered()).resolves.toEqual(['single'])
  })
})

describe('skill ownership', () => {
  it('records the owned entries so enable, disable and uninstall can address them', async () => {
    const installPath = pluginWithSkills('recorded', { alpha: 'First.' })
    const patchLayerPath = join(scratch, 'cordis.patch.yml')
    const statePath = join(scratch, 'state.json')
    const state = upsertInstalled(emptyState(), entryFor('recorded', installPath))

    expect(sync(state, { patchLayerPath, materialize: options(), statePath }).wroteState).toBe(true)
    const recorded = JSON.parse(readFileSync(statePath, 'utf8')) as { installed: InstalledEntry[] }
    expect(recorded.installed[0]?.skillIds).toEqual(['alpha'])

    // Disable parks the entries outside the root; discovery loses them.
    expect(setSkillsEnabled(options(), 'recorded', ['alpha'], false)).toBe(true)
    await expect(discovered()).resolves.toEqual([])
    expect(existsSync(join(scratch, '.agents', 'skills', '.disabled', 'recorded', 'alpha'))).toBe(true)

    // Enable moves them back without a re-fetch.
    expect(setSkillsEnabled(options(), 'recorded', ['alpha'], true)).toBe(true)
    await expect(discovered()).resolves.toEqual(['alpha'])
  })

  it('uninstall removes the materialized skills, not just the plugin directory', async () => {
    const installPath = pluginWithSkills('removable', { solo: 'Only skill.' })
    const patchLayerPath = join(scratch, 'cordis.patch.yml')
    const statePath = join(scratch, 'state.json')
    const options_ = options()
    const state = upsertInstalled(emptyState(), entryFor('removable', installPath))
    sync(state, { patchLayerPath, materialize: options_, statePath })
    const recorded = JSON.parse(readFileSync(statePath, 'utf8')) as { installed: InstalledEntry[] }

    const result = uninstallPlugin(
      { ...state, installed: recorded.installed },
      'removable',
      { statePath, sync: { patchLayerPath, materialize: options_ } },
    )

    expect(result.removed).toBe(true)
    await expect(discovered()).resolves.toEqual([])
    expect(existsSync(join(scratch, '.agents', 'skills', 'solo'))).toBe(false)
  })

  it('cleans up skills an older record never named', async () => {
    const installPath = pluginWithSkills('legacy', { old: 'Installed before skillIds existed.' })
    const options_ = options()
    materializeEntry(entryFor('legacy', installPath), options_)

    // The unannotated shape: no recorded ids, so the names come from the plugin
    // directory while it still exists.
    expect(skillEntryNames(installPath).names).toEqual(['old'])
    expect(removeMaterializedSkills(options_, 'legacy', skillEntryNames(installPath).names)).toEqual(['old'])
    await expect(discovered()).resolves.toEqual([])
  })

  it('removes the plugin-scoped container an earlier build wrote', async () => {
    const installPath = pluginWithSkills('nested', { inner: 'Written by the old layout.' })
    expect(skillEntryNames(installPath).names).toEqual(['inner'])
    const skillsRoot = join(scratch, '.agents', 'skills')
    const legacy = join(skillsRoot, 'nested', 'inner')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'SKILL.md'), '---\nname: inner\ndescription: Old.\n---\n\nBody.\n', 'utf8')
    await expect(discovered()).resolves.toEqual([])

    removeMaterializedSkills(options(), 'nested', ['inner'])

    expect(existsSync(join(skillsRoot, 'nested'))).toBe(false)
  })

  it('keeps a discoverable directory another plugin owns', () => {
    // `<root>/<plugin>` is only a legacy container when it holds no SKILL.md;
    // when it does, it is a real entry that uninstalling this plugin must not
    // delete.
    const skillsRoot = join(scratch, '.agents', 'skills')
    const owned = join(skillsRoot, 'shared-name')
    mkdirSync(owned, { recursive: true })
    writeFileSync(join(owned, 'SKILL.md'), '---\nname: shared-name\ndescription: Mine.\n---\n\nBody.\n', 'utf8')

    removeMaterializedSkills(options(), 'shared-name', [])

    expect(existsSync(join(owned, 'SKILL.md'))).toBe(true)
  })

  it('reports the three states of a plugin that ships no skills', () => {
    const options_ = options()
    expect(skillsEnabled(options_, 'no-skills', [])).toBeUndefined()
    expect(setSkillsEnabled(options_, 'no-skills', [], true)).toBe(false)
    // Names recorded but nothing on disk: neither live nor parked.
    expect(skillsEnabled(options_, 'no-skills', ['missing'])).toBeUndefined()
  })
})

describe('two plugins claiming one skill', () => {
  it('gives the name to the first and reports the second instead of overwriting', async () => {
    const first = pluginWithSkills('first-owner', { shared: 'From the first plugin.' })
    const second = pluginWithSkills('second-owner', { shared: 'From the second plugin.' })
    const patchLayerPath = join(scratch, 'cordis.patch.yml')
    const statePath = join(scratch, 'state.json')
    const state = upsertInstalled(
      upsertInstalled(emptyState(), entryFor('first-owner', first)),
      entryFor('second-owner', second),
    )

    const result = sync(state, { patchLayerPath, materialize: options(), statePath })

    // The root is flat, so a silent second copy would replace the first
    // plugin's skill and make either uninstall delete the other's content.
    expect(result.warnings.join(' ')).toContain('skill shared is already provided by first-owner')
    const recorded = JSON.parse(readFileSync(statePath, 'utf8')) as { installed: InstalledEntry[] }
    expect(recorded.installed[0]?.skillIds).toEqual(['shared'])
    // The loser owns nothing. An empty set is recorded as no annotation at all,
    // matching how `rowIds` already treats a plugin that mounts no row.
    expect(recorded.installed[1]?.skillIds ?? []).toEqual([])
    await expect(discovered()).resolves.toEqual(['shared'])
    expect(readFileSync(join(scratch, '.agents', 'skills', 'shared', 'SKILL.md'), 'utf8')).toContain('From the first plugin.')
  })
})
