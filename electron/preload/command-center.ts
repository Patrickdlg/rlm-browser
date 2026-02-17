import { contextBridge, ipcRenderer } from 'electron'

function on(channel: string, cb: (data: any) => void): () => void {
  const handler = (_: any, data: any) => cb(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('electronAPI', {
  // RLM actions
  submitTask: (message: string) => ipcRenderer.invoke('rlm:submit-task', { message }),
  cancelTask: () => ipcRenderer.invoke('rlm:cancel'),
  getState: () => ipcRenderer.invoke('rlm:get-state'),
  confirmationResponse: (approved: boolean) => ipcRenderer.invoke('rlm:confirmation-resp', { approved }),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (config: any) => ipcRenderer.invoke('settings:set', config),

  // RLM events from main
  onIterationStart: (cb: (data: any) => void) => on('rlm:iteration-start', cb),
  onStreamToken: (cb: (data: any) => void) => on('rlm:stream-token', cb),
  onCodeGenerated: (cb: (data: any) => void) => on('rlm:code-generated', cb),
  onCodeResult: (cb: (data: any) => void) => on('rlm:code-result', cb),
  onSubLLMStart: (cb: (data: any) => void) => on('rlm:sub-llm-start', cb),
  onSubLLMComplete: (cb: (data: any) => void) => on('rlm:sub-llm-complete', cb),
  onPageChanges: (cb: (data: any) => void) => on('rlm:page-changes', cb),
  onLog: (cb: (data: any) => void) => on('rlm:log', cb),
  onError: (cb: (data: any) => void) => on('rlm:error', cb),
  onComplete: (cb: (data: any) => void) => on('rlm:complete', cb),
  onEnvUpdate: (cb: (data: any) => void) => on('rlm:env-update', cb),
  onConfirmationReq: (cb: (data: any) => void) => on('rlm:confirmation-req', cb),
})
