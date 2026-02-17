import type { IterationRecord } from '../../../src/shared/types'
import { estimateTokens, HISTORY_TOKEN_BUDGET, HISTORY_COMPACTION_THRESHOLD } from './caps'

/**
 * Token-based adaptive history compaction.
 * Keeps last 3 iterations at full detail, condenses older ones.
 * Triggers at 80% of token budget.
 */
export function compactHistory(iterations: IterationRecord[]): string {
  if (iterations.length === 0) return ''

  const fullHistory = iterations.map(i => i.fullMetadata)
  const fullText = fullHistory.join('\n\n')
  const currentTokens = estimateTokens(fullText)

  // Everything fits — no compaction needed
  if (currentTokens <= HISTORY_COMPACTION_THRESHOLD) {
    return fullHistory.join('\n\n')
  }

  // Keep the last 3 iterations at full detail
  const recentCount = Math.min(3, iterations.length)
  const recent = iterations.slice(-recentCount)
  const older = iterations.slice(0, -recentCount)

  if (older.length === 0) {
    // All iterations are "recent" — just return them
    return recent.map(i => i.fullMetadata).join('\n\n')
  }

  // Summarize older iterations into condensed form
  const condensed = older.map(i =>
    `Iter ${i.number}: ${i.oneLinerSummary}`
  ).join('. ')

  const summary = `## Earlier iterations (condensed)\n${condensed}`
  const recentFull = recent.map(i => i.fullMetadata).join('\n\n')

  const combined = `${summary}\n\n${recentFull}`

  // If still too big after compaction, further truncate the condensed section
  if (estimateTokens(combined) > HISTORY_TOKEN_BUDGET) {
    const maxCondensedChars = (HISTORY_TOKEN_BUDGET - estimateTokens(recentFull)) * 4
    const truncatedSummary = `## Earlier iterations (condensed)\n${condensed.slice(0, Math.max(200, maxCondensedChars))}...`
    return `${truncatedSummary}\n\n${recentFull}`
  }

  return combined
}
