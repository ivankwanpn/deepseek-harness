/** `goal` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'phase.active': '进行中的目标',
  'phase.active.disarmed': '未运行的目标',
  'phase.paused': '已暂停的目标',
  'phase.blocked': '受阻的目标',
  'objective.aria': '目标内容',
  'commandInput.aria': '指令输入',
  'action.save': '保存目标',
  'action.cancel': '取消编辑',
  'action.pause': '暂停目标',
  'action.resume': '恢复目标',
  'action.edit': '编辑目标',
  'action.clear': '清除目标',
  'defaults.title': '目标上限',
  'defaults.description': '应用于新建目标。留空的字段回退到默认：轮次上限回到内置值，预算则视为不限。',
  'defaults.rounds.label': '轮次上限',
  'defaults.rounds.hint': '自动续跑的最大轮数。',
  'defaults.tokens.label': 'token 预算',
  'defaults.tokens.hint': '整个目标可用的提供方 token；留空表示不限。',
  'defaults.work.label': '活跃工作时长（毫秒）',
  'defaults.work.hint': '整个目标可用的模型与工具毫秒数；留空表示不限。',
  'defaults.invalid': '请输入正整数，或留空。',
} satisfies Record<string, string>

/** The goal namespace key union. */
export type GoalKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'phase.active': 'Ongoing Goal',
  'phase.active.disarmed': 'Inactive Goal',
  'phase.paused': 'Paused Goal',
  'phase.blocked': 'Blocked Goal',
  'objective.aria': 'Goal objective',
  'commandInput.aria': 'Command input',
  'action.save': 'Save goal',
  'action.cancel': 'Cancel edit',
  'action.pause': 'Pause goal',
  'action.resume': 'Resume goal',
  'action.edit': 'Edit goal',
  'action.clear': 'Clear goal',
  'defaults.title': 'Goal limits',
  'defaults.description': 'Applied to new goals. An empty field falls back: the round limit returns to its built-in value, and an empty budget leaves the goal unbounded.',
  'defaults.rounds.label': 'Round limit',
  'defaults.rounds.hint': 'Maximum automatic continuation rounds.',
  'defaults.tokens.label': 'Token budget',
  'defaults.tokens.hint': 'Provider tokens available to the whole goal; empty means unbounded.',
  'defaults.work.label': 'Active work (ms)',
  'defaults.work.hint': 'Model and tool milliseconds available to the whole goal; empty means unbounded.',
  'defaults.invalid': 'Enter a whole number greater than zero, or leave the field empty.',
} satisfies Record<GoalKey, string>
