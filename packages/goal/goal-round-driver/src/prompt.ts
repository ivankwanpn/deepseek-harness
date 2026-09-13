/** Model-visible continuation prompt for one same-session goal round. */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { GoalView } from '@deepseek-ai/dsh-goal'

/**
 * Render the resource headroom this round starts with.
 *
 * A goal without a budget renders no line at all, so its prompt stays
 * byte-identical to an unbudgeted deployment's. `unknown` replaces a spend the
 * deployment stopped metering after the budget was set; the budget still
 * blocks, it simply cannot report the distance to the ceiling.
 * @param goal - exact active goal revision being admitted.
 * @returns one prompt line ending in a newline, or an empty string without a budget.
 */
function renderBudgetLine(goal: GoalView): string {
  const parts: string[] = []
  if (goal.maxGoalTokens !== null) {
    parts.push(`${goal.tokensUsed ?? 'unknown'}/${goal.maxGoalTokens} tokens`)
  }
  if (goal.maxGoalWorkMs !== null) {
    parts.push(`${goal.workMsUsed ?? 'unknown'}/${goal.maxGoalWorkMs} ms model-and-tool time`)
  }
  return parts.length === 0 ? '' : `Budget used: ${parts.join(', ')}\n`
}

/**
 * Render the complete goal-round instruction retained in session history.
 * @param goal - exact active goal revision being admitted.
 * @param round - next positive round number.
 * @returns a fresh one-block prompt for `Agent.followup()`.
 */
export function renderGoalRoundPrompt(goal: GoalView, round: number): ContentBlock[] {
  return [{
    type: 'text',
    text: '<goal_round>\n'
      + `Objective: ${JSON.stringify(goal.objective)}\n`
      + `Round: ${goal.maxGoalRounds === null ? String(round) : `${round}/${goal.maxGoalRounds}`}\n`
      + renderBudgetLine(goal)
      + '\n'
      + 'Continue working toward the objective in this same session. Treat the current workspace, '
      + 'tool results, and durable session state as authoritative; inspect them instead of assuming '
      + 'earlier narration is still current. Make concrete progress and verify the result. Before '
      + 'claiming completion, gather evidence that the whole objective is achieved, read the current '
      + 'goal, and mark it complete. If work remains, leave the goal active for the next round. Follow '
      + 'the configured goal-tool policy before reporting a blocker.\n'
      + '</goal_round>',
  }]
}
