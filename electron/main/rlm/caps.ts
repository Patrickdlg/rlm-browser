/** Max characters returned from execInTab before truncation */
export const EXEC_RESULT_CAP = 100_000

/** Maximum sleep duration in ms (LLMs will write sleep(60000) if you let them) */
export const SLEEP_CAP_MS = 10_000

/** Per-code-block execution timeout in ms */
export const EXEC_TIMEOUT_MS = 30_000

/** Per-execInTab timeout in ms */
export const EXEC_IN_TAB_TIMEOUT_MS = 10_000

/** Maximum RLM loop iterations per run */
export const MAX_ITERATIONS = 25

/** Maximum sub-LLM calls per run */
export const MAX_SUB_CALLS = 50

/** Maximum consecutive iterations with no code before bailing */
export const MAX_NO_CODE_CONTINUATIONS = 3

/** Token estimation: ~4 chars per token */
export const CHARS_PER_TOKEN = 4

/** Token budget for action history section */
export const HISTORY_TOKEN_BUDGET = 8000

/** Token budget trigger for compaction (80% of budget) */
export const HISTORY_COMPACTION_THRESHOLD = HISTORY_TOKEN_BUDGET * 0.8

/** Max preview chars in metadata summaries */
export const PREVIEW_MAX_CHARS = 400

/** Max chars for variable preview in env metadata */
export const VAR_PREVIEW_MAX_CHARS = 200

/** Max chars for log() messages before truncation */
export const LOG_MAX_CHARS = 5_000

/** Memory limit for isolated-vm in MB */
export const ISOLATE_MEMORY_LIMIT_MB = 128

/** Estimate token count from character length */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Cap a result to the max character limit */
export function capResult(result: unknown, maxChars: number = EXEC_RESULT_CAP): unknown {
  const serialized = JSON.stringify(result)
  if (serialized && serialized.length > maxChars) {
    return {
      __truncated: true,
      originalLength: serialized.length,
      data: typeof result === 'string'
        ? result.slice(0, maxChars)
        : (() => {
            try {
              return JSON.parse(serialized.slice(0, maxChars))
            } catch {
              return serialized.slice(0, maxChars)
            }
          })(),
    }
  }
  return result
}
