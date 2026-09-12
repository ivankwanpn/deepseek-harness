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
  | 'skillsLabel'
  | 'skillsLive'
  | 'skillsParked'
  | 'skillsNone'
  | 'toggleLabel'
  | 'toggleLocked'
  | 'uninstall'
  | 'uninstallTitle'
  | 'uninstallDescription'
  | 'uninstallAcknowledge'
  | 'uninstallCancel'
  | 'uninstallConfirm'
  | 'working'
  | 'actionFailed'
  | 'readOnly'
  | 'catalogTitle'
  | 'catalogLoad'
  | 'catalogLoading'
  | 'catalogRefresh'
  | 'catalogSearchPlaceholder'
  | 'catalogEmpty'
  | 'catalogNoMatch'
  | 'catalogFailed'
  | 'catalogMarketplaceFailed'
  | 'catalogInstalled'
  | 'catalogInstall'
  | 'catalogUnpinned'

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
  skillsLabel: '技能',
  skillsLive: '已生效',
  skillsParked: '已收起',
  skillsNone: '无',
  toggleLabel: '启用状态',
  toggleLocked: '写入进行中，暂时无法切换。',
  uninstall: '卸载',
  uninstallTitle: '卸载插件',
  uninstallDescription: '这会删除该插件的内容目录、已落地的技能、挂载行与安装记录。此操作无法撤销。',
  uninstallAcknowledge: '我明白这会删除该插件的文件与技能。',
  uninstallCancel: '取消',
  uninstallConfirm: '卸载',
  working: '正在写入…',
  actionFailed: '操作失败：',
  readOnly: '此部署以只读方式提供插件市场面板，因此不提供启用、停用与卸载。',
  catalogTitle: '可安装的插件',
  catalogLoad: '浏览可安装的插件',
  catalogLoading: '正在读取插件市场…',
  catalogRefresh: '重新整理',
  catalogSearchPlaceholder: '依名称、说明、分类或标签过滤',
  catalogEmpty: '已注册的插件市场都是空的。',
  catalogNoMatch: '没有可安装的插件符合这个过滤条件。',
  catalogFailed: '无法读取已注册的插件市场。',
  catalogMarketplaceFailed: '无法读取',
  catalogInstalled: '已安装',
  catalogInstall: '安装',
  catalogUnpinned: '未钉选',
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
  skillsLabel: 'Skills',
  skillsLive: 'live',
  skillsParked: 'parked',
  skillsNone: 'none',
  toggleLabel: 'Enabled',
  toggleLocked: 'A write is in flight; the toggle is unavailable until it settles.',
  uninstall: 'Uninstall',
  uninstallTitle: 'Uninstall plugin',
  uninstallDescription: 'This deletes the plugin content directory, its materialized skills, its loader rows and its install record. It cannot be undone.',
  uninstallAcknowledge: 'I understand this deletes the plugin files and skills.',
  uninstallCancel: 'Cancel',
  uninstallConfirm: 'Uninstall',
  working: 'Writing…',
  actionFailed: 'The action failed: ',
  readOnly: 'This deployment serves the marketplace panel read-only, so it offers no enable, disable or uninstall.',
  catalogTitle: 'Available plugins',
  catalogLoad: 'Browse available plugins',
  catalogLoading: 'Reading the marketplaces…',
  catalogRefresh: 'Refresh',
  catalogSearchPlaceholder: 'Filter by name, description, category or tag',
  catalogEmpty: 'Every registered marketplace is empty.',
  catalogNoMatch: 'No available plugin matches that filter.',
  catalogFailed: 'Could not read the registered marketplaces.',
  catalogMarketplaceFailed: 'Could not read',
  catalogInstalled: 'installed',
  catalogInstall: 'Install',
  catalogUnpinned: 'no pin',
}
