import type { IterationRecord } from '../../../src/shared/types'

export class TaskTracker {
  private userMessage: string = ''
  private iterations: IterationRecord[] = []
  private maxIterations: number = 25

  setTask(message: string, maxIter: number): void {
    this.userMessage = message
    this.iterations = []
    this.maxIterations = maxIter
  }

  addIteration(record: IterationRecord): void {
    this.iterations.push(record)
  }

  getIterations(): IterationRecord[] {
    return this.iterations
  }

  getUserMessage(): string {
    return this.userMessage
  }

  /** Generate the task reinforcement block for the LLM context */
  generateReinforcement(): string {
    const currentIter = this.iterations.length + 1
    const lines = [
      '## Current Task',
      `User's request: "${this.userMessage}"`,
      `Iteration: ${currentIter} of ${this.maxIterations}`,
    ]

    if (this.iterations.length > 0) {
      lines.push('Progress so far:')
      for (const iter of this.iterations) {
        lines.push(`  - Iter ${iter.number}: ${iter.oneLinerSummary}`)
      }
    }

    return lines.join('\n')
  }

  /** Generate a progress summary for sub-call context */
  progressSummary(): string {
    if (this.iterations.length === 0) return 'Just started.'
    const recent = this.iterations.slice(-3)
    return recent.map(i => `Iter ${i.number}: ${i.oneLinerSummary}`).join('. ')
  }
}
