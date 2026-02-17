export const IPC = {
  // Renderer → Main (invoke)
  TAB_OPEN: 'tab:open',
  TAB_CLOSE: 'tab:close',
  TAB_SWITCH: 'tab:switch',
  TAB_NAVIGATE: 'tab:navigate',
  TAB_GO_BACK: 'tab:go-back',
  TAB_GO_FORWARD: 'tab:go-forward',
  TAB_RELOAD: 'tab:reload',
  TAB_GET_ALL: 'tab:get-all',
  TAB_GET_ACTIVE: 'tab:get-active',

  // RLM Renderer → Main (invoke)
  RLM_SUBMIT_TASK: 'rlm:submit-task',
  RLM_CANCEL: 'rlm:cancel',
  RLM_GET_STATE: 'rlm:get-state',
  RLM_CONFIRMATION_RESP: 'rlm:confirmation-resp',

  // Settings
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',

  // Main → Renderer (send / on)
  TAB_UPDATED: 'tab:updated',
  TAB_ACTIVE_CHANGED: 'tab:active-changed',
  TAB_CLOSED: 'tab:closed',

  RLM_ITERATION_START: 'rlm:iteration-start',
  RLM_STREAM_TOKEN: 'rlm:stream-token',
  RLM_CODE_GENERATED: 'rlm:code-generated',
  RLM_CODE_RESULT: 'rlm:code-result',
  RLM_SUB_LLM_START: 'rlm:sub-llm-start',
  RLM_SUB_LLM_COMPLETE: 'rlm:sub-llm-complete',
  RLM_PAGE_CHANGES: 'rlm:page-changes',
  RLM_LOG: 'rlm:log',
  RLM_ERROR: 'rlm:error',
  RLM_COMPLETE: 'rlm:complete',
  RLM_ENV_UPDATE: 'rlm:env-update',
  RLM_CONFIRMATION_REQ: 'rlm:confirmation-req',
} as const
