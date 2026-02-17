import { useState, useEffect } from 'react'
import type { LLMConfig, LLMProvider } from '../shared/types'

interface SettingsProps {
  onClose: () => void
}

const DEFAULT_CONFIG: LLMConfig = {
  provider: 'anthropic',
  apiKey: '',
  baseURL: '',
  primaryModel: 'claude-sonnet-4-20250514',
  subModel: 'claude-haiku-4-5-20251001',
  maxIterations: 25,
  maxSubCalls: 50,
}

export default function Settings({ onClose }: SettingsProps) {
  const [config, setConfig] = useState<LLMConfig>(DEFAULT_CONFIG)
  const [saved, setSaved] = useState(false)
  const [apiKeyChanged, setApiKeyChanged] = useState(false)
  const [maskedKey, setMaskedKey] = useState('')

  useEffect(() => {
    window.electronAPI.getSettings().then((settings) => {
      if (settings) {
        setMaskedKey(settings.apiKey || '')
        setConfig({ ...DEFAULT_CONFIG, ...settings, apiKey: '' })
      }
    })
  }, [])

  const handleSave = async () => {
    const toSave = { ...config }
    // Only send API key if user actually changed it
    if (!apiKeyChanged && maskedKey) {
      // Tell backend to keep existing key
      toSave.apiKey = '__KEEP_EXISTING__'
    }
    await window.electronAPI.setSettings(toSave)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const update = (key: keyof LLMConfig, value: string | number) => {
    if (key === 'apiKey') setApiKeyChanged(true)
    setConfig(prev => ({ ...prev, [key]: value }))
  }

  return (
    <div className="flex flex-col h-screen bg-[#11111b] text-[#cdd6f4]">
      <div className="flex items-center justify-between border-b border-[#313244]" style={{ padding: '12px 24px' }}>
        <h1 className="text-sm font-semibold text-[#89b4fa]">Settings</h1>
        <button
          onClick={onClose}
          className="text-xs text-[#6c7086] hover:text-[#cdd6f4] px-2 py-1 rounded hover:bg-[#313244]"
        >
          Back
        </button>
      </div>

      <div className="flex-1 overflow-y-auto space-y-4" style={{ padding: '20px 24px' }}>
        {/* Provider */}
        <div>
          <label className="block text-xs text-[#a6adc8] mb-1">Provider</label>
          <div className="flex gap-2">
            {(['anthropic', 'openai'] as LLMProvider[]).map(p => (
              <button
                key={p}
                onClick={() => update('provider', p)}
                className={`px-3 py-1.5 rounded text-xs ${
                  config.provider === p
                    ? 'bg-[#89b4fa] text-[#11111b]'
                    : 'bg-[#313244] text-[#6c7086] hover:text-[#cdd6f4]'
                }`}
              >
                {p === 'anthropic' ? 'Anthropic' : 'OpenAI-Compatible'}
              </button>
            ))}
          </div>
        </div>

        {/* API Key */}
        <div>
          <label className="block text-xs text-[#a6adc8] mb-1">API Key</label>
          <input
            type="password"
            value={config.apiKey}
            onChange={(e) => update('apiKey', e.target.value)}
            placeholder={maskedKey ? `Current: ${maskedKey}` : 'sk-...'}
            className="w-full bg-[#1e1e2e] text-[#cdd6f4] text-sm px-3 py-2 rounded border border-[#313244]
              focus:border-[#89b4fa] focus:outline-none placeholder:text-[#45475a]"
          />
        </div>

        {/* Base URL (for OpenAI-compatible) */}
        {config.provider === 'openai' && (
          <div>
            <label className="block text-xs text-[#a6adc8] mb-1">Base URL</label>
            <input
              type="text"
              value={config.baseURL}
              onChange={(e) => update('baseURL', e.target.value)}
              placeholder="http://localhost:8000/v1"
              className="w-full bg-[#1e1e2e] text-[#cdd6f4] text-sm px-3 py-2 rounded border border-[#313244]
                focus:border-[#89b4fa] focus:outline-none placeholder:text-[#45475a]"
            />
            <p className="text-[10px] text-[#45475a] mt-1">For vLLM, Ollama, or other OpenAI-compatible servers</p>
          </div>
        )}

        {/* Primary Model */}
        <div>
          <label className="block text-xs text-[#a6adc8] mb-1">Primary Model (main loop)</label>
          <input
            type="text"
            value={config.primaryModel}
            onChange={(e) => update('primaryModel', e.target.value)}
            className="w-full bg-[#1e1e2e] text-[#cdd6f4] text-sm px-3 py-2 rounded border border-[#313244]
              focus:border-[#89b4fa] focus:outline-none"
          />
        </div>

        {/* Sub Model */}
        <div>
          <label className="block text-xs text-[#a6adc8] mb-1">Sub Model (llm_query/llm_batch)</label>
          <input
            type="text"
            value={config.subModel}
            onChange={(e) => update('subModel', e.target.value)}
            className="w-full bg-[#1e1e2e] text-[#cdd6f4] text-sm px-3 py-2 rounded border border-[#313244]
              focus:border-[#89b4fa] focus:outline-none"
          />
          <p className="text-[10px] text-[#45475a] mt-1">Used for sub-calls. Faster/cheaper models recommended.</p>
        </div>

        {/* Max Iterations */}
        <div className="flex gap-4">
          <div className="flex-1">
            <label className="block text-xs text-[#a6adc8] mb-1">Max Iterations</label>
            <input
              type="number"
              value={config.maxIterations}
              onChange={(e) => update('maxIterations', parseInt(e.target.value) || 25)}
              min={1}
              max={100}
              className="w-full bg-[#1e1e2e] text-[#cdd6f4] text-sm px-3 py-2 rounded border border-[#313244]
                focus:border-[#89b4fa] focus:outline-none"
            />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-[#a6adc8] mb-1">Max Sub-Calls</label>
            <input
              type="number"
              value={config.maxSubCalls}
              onChange={(e) => update('maxSubCalls', parseInt(e.target.value) || 50)}
              min={1}
              max={200}
              className="w-full bg-[#1e1e2e] text-[#cdd6f4] text-sm px-3 py-2 rounded border border-[#313244]
                focus:border-[#89b4fa] focus:outline-none"
            />
          </div>
        </div>

        {/* Save Button */}
        <button
          onClick={handleSave}
          className="w-full px-4 py-2 bg-[#89b4fa] text-[#11111b] rounded-lg text-sm font-medium
            hover:bg-[#b4d0fb]"
        >
          {saved ? 'Saved!' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
