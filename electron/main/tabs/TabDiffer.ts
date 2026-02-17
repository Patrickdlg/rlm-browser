import type { TabSnapshot, TabChange } from '../../../src/shared/types'

export class TabDiffer {
  private snapshots: Map<string, TabSnapshot> = new Map()

  /** Take a snapshot of all tabs for later diffing */
  capture(tabs: Map<string, { url: string; title: string; status: string }>): void {
    this.snapshots.clear()
    for (const [id, tab] of tabs) {
      this.snapshots.set(id, { url: tab.url, title: tab.title, status: tab.status })
    }
  }

  /** Diff current tab state against the last snapshot */
  diff(tabs: Map<string, { url: string; title: string; status: string }>): TabChange[] {
    const changes: TabChange[] = []

    for (const [id, current] of tabs) {
      const prev = this.snapshots.get(id)
      if (!prev) continue

      if (prev.url !== current.url) {
        changes.push({ tabId: id, field: 'url', old: prev.url, new: current.url })
      }
      if (prev.title !== current.title) {
        changes.push({ tabId: id, field: 'title', old: prev.title, new: current.title })
      }
      if (prev.status !== current.status) {
        changes.push({ tabId: id, field: 'status', old: prev.status, new: current.status })
      }
    }

    return changes
  }
}
