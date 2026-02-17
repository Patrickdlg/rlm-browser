import type { TabInfo, TabSnapshot } from '../../../src/shared/types'

export class TabState {
  id: string
  url: string = 'about:blank'
  title: string = 'New Tab'
  status: 'loading' | 'loaded' | 'error' = 'loading'
  favicon: string = ''
  canGoBack: boolean = false
  canGoForward: boolean = false

  constructor(id: string) {
    this.id = id
  }

  toInfo(): TabInfo {
    return {
      id: this.id,
      url: this.url,
      title: this.title,
      status: this.status,
      favicon: this.favicon,
      canGoBack: this.canGoBack,
      canGoForward: this.canGoForward,
    }
  }

  snapshot(): TabSnapshot {
    return {
      url: this.url,
      title: this.title,
      status: this.status,
    }
  }
}
