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
  'defaults.description': '应用于新建目标。预算同时是任何 goal 可获得的最大值；留空的字段不做任何约束。',
  'defaults.rounds.label': '轮次上限',
  'defaults.rounds.hint': '自动续跑的最大轮数；留空表示轮次不受约束。',
  'defaults.tokens.label': 'token 预算',
  'defaults.tokens.hint': '单个 goal 的默认与最大提供方 token；留空不做约束。',
  'defaults.work.label': '活跃工作时长（毫秒）',
  'defaults.work.hint': '单个 goal 的默认与最大模型与工具毫秒数；留空不做约束。',
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
  'defaults.description': 'Applied to new goals. A budget is also the most any goal may be granted; an empty field bounds nothing.',
  'defaults.rounds.label': 'Round limit',
  'defaults.rounds.hint': 'Maximum automatic continuation rounds; empty leaves rounds unbounded.',
  'defaults.tokens.label': 'Token budget',
  'defaults.tokens.hint': 'Default and maximum provider tokens for one goal; empty bounds nothing.',
  'defaults.work.label': 'Active work (ms)',
  'defaults.work.hint': 'Default and maximum model-and-tool milliseconds for one goal; empty bounds nothing.',
  'defaults.invalid': 'Enter a whole number greater than zero, or leave the field empty.',
} satisfies Record<GoalKey, string>
