import Store from 'electron-store'
import { safeStorage } from 'electron'
import type { LLMConfig } from '../../../src/shared/types'

const store = new Store({
  name: 'ouroboros-settings',
  defaults: {
    llmConfig: null as LLMConfig | null,
    replStore: {} as Record<string, unknown>,
  },
})

/** Encrypt a string using Electron's safeStorage */
function encrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(value).toString('base64')
  }
  return value // Fallback: plaintext (dev mode)
}

/** Decrypt a string using Electron's safeStorage */
function decrypt(value: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'))
    } catch {
      return value // Fallback if decryption fails
    }
  }
  return value
}

export function getSettings(): LLMConfig | null {
  const config = store.get('llmConfig') as LLMConfig | null
  if (config && config.apiKey) {
    return { ...config, apiKey: decrypt(config.apiKey) }
  }
  return config
}

export function setSettings(config: LLMConfig): void {
  const toStore = { ...config }
  if (toStore.apiKey === '__KEEP_EXISTING__') {
    // Preserve the existing encrypted key
    const existing = store.get('llmConfig') as LLMConfig | null
    toStore.apiKey = existing?.apiKey || ''
  } else if (toStore.apiKey) {
    toStore.apiKey = encrypt(toStore.apiKey)
  }
  store.set('llmConfig', toStore)
}

/** REPL persistent key-value store */
export function replStore(key: string, value: unknown): void {
  const current = store.get('replStore') as Record<string, unknown>
  current[key] = value
  store.set('replStore', current)
}

export function replRetrieve(key: string): unknown {
  const current = store.get('replStore') as Record<string, unknown>
  return current[key] ?? null
}

export function getReplStoreKeys(): string[] {
  const current = store.get('replStore') as Record<string, unknown>
  return Object.keys(current)
}
