/**
 * Copy dictionaries for the marketplace Settings section.
 *
 * The key union is declared FIRST so both dictionaries are checked against it:
 * a key added to one language and forgotten in the other is a type error rather
 * than a blank string at runtime. Simplified Chinese is the source of truth for
 * wording, matching every other zh dictionary in this repository.
 */

/** Every key the marketplace section translates. */
export type MarketplaceLocaleKey =
  | 'tab'
  | 'loading'
  | 'error'
  | 'retry'
  | 'marketplacesTitle'
  | 'marketplacesEmpty'
  | 'installedTitle'
  | 'installedEmpty'
  | 'pinLabel'
  | 'noPin'
  | 'capabilitiesLabel'
  | 'noCapabilities'
  | 'rowsLabel'
  | 'stateEnabled'
  | 'stateDisabled'
  | 'stateNoRows'
  | 'stateNotMounted'
  | 'stateEnabledDetail'
  | 'stateDisabledDetail'
  | 'stateNoRowsDetail'
  | 'stateNotMountedDetail'
  | 'contentLabel'

/** Simplified Chinese dictionary. */
export const zh: Record<MarketplaceLocaleKey, string> = {
  tab: '插件市场',
  loading: '正在读取插件市场…',
  error: '读取插件市场失败。',
  retry: '重试',
  marketplacesTitle: '已注册的插件市场',
  marketplacesEmpty: '尚未注册任何插件市场。可在终端运行 `dsh plugin marketplace add official`。',
  installedTitle: '已安装的插件',
  installedEmpty: '尚未从插件市场安装任何插件。',
  pinLabel: '版本',
  noPin: '未记录',
  capabilitiesLabel: '能力',
  noCapabilities: '无可挂载能力',
  rowsLabel: '挂载行',
  stateEnabled: '已启用',
  stateDisabled: '已停用',
  stateNoRows: '仅技能',
  stateNotMounted: '未挂载',
  stateEnabledDetail: '挂载行存在且已启用。',
  stateDisabledDetail: '挂载行存在且已停用。',
  stateNoRowsDetail: '该插件不挂载任何加载器行；技能由文件系统发现。',
  stateNotMountedDetail: '状态中有记录，但补丁层没有对应的挂载行；下次同步会修复。',
  contentLabel: '内容目录',
}

/** English dictionary. */
export const en: Record<MarketplaceLocaleKey, string> = {
  tab: 'Marketplace',
  loading: 'Reading the plugin marketplace…',
  error: 'Could not read the plugin marketplace.',
  retry: 'Retry',
  marketplacesTitle: 'Registered marketplaces',
  marketplacesEmpty: 'No marketplace is registered yet. Run `dsh plugin marketplace add official` in a terminal.',
  installedTitle: 'Installed plugins',
  installedEmpty: 'Nothing has been installed from a marketplace yet.',
  pinLabel: 'Pinned',
  noPin: 'not recorded',
  capabilitiesLabel: 'Carries',
  noCapabilities: 'nothing mountable',
  rowsLabel: 'Rows',
  stateEnabled: 'enabled',
  stateDisabled: 'disabled',
  stateNoRows: 'skills only',
  stateNotMounted: 'not mounted',
  stateEnabledDetail: 'Its loader row exists and is enabled.',
  stateDisabledDetail: 'Its loader row exists and is disabled.',
  stateNoRowsDetail: 'This plugin mounts no loader row; its skills are discovered from the filesystem.',
  stateNotMountedDetail: 'Recorded in state, but the patch layer has no matching row; the next sync repairs it.',
  contentLabel: 'Content',
}
