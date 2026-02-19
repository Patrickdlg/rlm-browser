import ivm from 'isolated-vm'
import { parseHTML as linkedomParseHTML } from 'linkedom'
import type { TabManager } from '../tabs/TabManager'
import { capResult, SLEEP_CAP_MS, EXEC_TIMEOUT_MS, ISOLATE_MEMORY_LIMIT_MB, LOG_MAX_CHARS } from './caps'

/** Serialize a DOM element to a plain object for transfer into the isolate */
function serializeElement(el: any): object {
  return {
    tag: (el.tagName || '').toLowerCase(),
    id: el.id || '',
    className: el.className || '',
    text: (el.textContent || '').trim().slice(0, 500),
    attrs: Object.fromEntries([...(el.attributes || [])].map((a: any) => [a.name, a.value])),
  }
}

/** Serialize with innerHTML and childCount for single-element queries */
function serializeElementFull(el: any): object {
  return {
    ...serializeElement(el),
    innerHTML: (el.innerHTML || '').slice(0, 2000),
    childCount: el.children ? el.children.length : 0,
  }
}

export interface REPLCallbacks {
  onLog: (message: string) => void
  onSetFinal: (value: unknown) => void
  onSubCall: (prompt: string, data?: unknown) => Promise<string>
  onSubBatch: (prompts: Array<{ prompt: string; data?: unknown }>) => Promise<Array<{ status: string; value?: string; error?: string }>>
}

export class REPLRuntime {
  private isolate: ivm.Isolate | null = null
  private context: ivm.Context | null = null
  private tabManager: TabManager
  private callbacks: REPLCallbacks
  private finalValue: unknown = undefined
  private finalCalled = false
  private docMap: Map<string, any> = new Map()
  private docCounter = 0

  constructor(tabManager: TabManager, callbacks: REPLCallbacks) {
    this.tabManager = tabManager
    this.callbacks = callbacks
  }

  async initialize(): Promise<void> {
    this.isolate = new ivm.Isolate({ memoryLimit: ISOLATE_MEMORY_LIMIT_MB })
    this.context = await this.isolate.createContext()

    const jail = this.context.global

    // --- Expose host function references ---

    // execInTab(tabId, code) -> result
    await jail.set('_execInTab', new ivm.Reference(async (tabId: string, code: string) => {
      const result = await this.tabManager.exec(tabId, code)
      return new ivm.ExternalCopy(capResult(result)).copyInto()
    }))

    // openTab(url?) -> tabId — opens in background so it doesn't steal focus from Command Center
    await jail.set('_openTab', new ivm.Reference(async (url?: string) => {
      return this.tabManager.openTab(url || undefined, { background: true })
    }))

    // closeTab(tabId)
    await jail.set('_closeTab', new ivm.Reference((tabId: string) => {
      this.tabManager.closeTab(tabId)
    }))

    // navigate(tabId, url)
    await jail.set('_navigate', new ivm.Reference((tabId: string, url: string) => {
      this.tabManager.navigate(tabId, url)
    }))

    // switchTab(tabId)
    await jail.set('_switchTab', new ivm.Reference((tabId: string) => {
      this.tabManager.switchTab(tabId)
    }))

    // waitForLoad(tabId, timeout?)
    await jail.set('_waitForLoad', new ivm.Reference(async (tabId: string, timeout?: number) => {
      await this.tabManager.waitForLoad(tabId, timeout)
    }))

    // waitForSelector(tabId, selector, timeout?)
    await jail.set('_waitForSelector', new ivm.Reference(async (tabId: string, selector: string, timeout?: number) => {
      await this.tabManager.waitForSelector(tabId, selector, timeout)
    }))

    // sleep(ms) — host-side, since setTimeout is not available in isolated-vm
    await jail.set('_sleep', new ivm.Reference(async (ms: number) => {
      const capped = Math.min(ms, SLEEP_CAP_MS)
      return new Promise<void>(resolve => setTimeout(resolve, capped))
    }))

    // getTabs() -> TabInfo[]
    await jail.set('_getTabs', new ivm.Reference(() => {
      return new ivm.ExternalCopy(this.tabManager.getAllTabs()).copyInto()
    }))

    // getActiveTab() -> tabId
    await jail.set('_getActiveTab', new ivm.Reference(() => {
      return this.tabManager.getActiveTabId()
    }))

    // log(message) — auto-truncated to LOG_MAX_CHARS
    await jail.set('_log', new ivm.Reference((message: string) => {
      const str = String(message)
      const truncated = str.length > LOG_MAX_CHARS
        ? str.slice(0, LOG_MAX_CHARS) + `\n... (truncated, ${str.length} chars total)`
        : str
      this.callbacks.onLog(truncated)
    }))

    // setFinal(value)
    await jail.set('_setFinal', new ivm.Reference((value: unknown) => {
      this.finalCalled = true
      this.finalValue = value
      this.callbacks.onSetFinal(value)
    }))

    // llm_query(prompt, data?) -> string — MUST never reject, always return a string
    await jail.set('_llm_query', new ivm.Reference(async (prompt: string, data?: unknown) => {
      try {
        return await this.callbacks.onSubCall(prompt, data)
      } catch (err: any) {
        return `[SUB-CALL ERROR] ${err.message || String(err)}`
      }
    }))

    // llm_batch(prompts) -> Array<{status, value?, error?}> — MUST never reject
    await jail.set('_llm_batch', new ivm.Reference(async (prompts: Array<{ prompt: string; data?: unknown }>) => {
      try {
        const results = await this.callbacks.onSubBatch(prompts)
        return new ivm.ExternalCopy(results).copyInto()
      } catch (err: any) {
        return new ivm.ExternalCopy([{ status: 'rejected', error: err.message || String(err) }]).copyInto()
      }
    }))

    // --- Host-side DOM parsing (linkedom) ---

    // parseHTML(html) → docHandle
    await jail.set('_parseHTML', new ivm.Reference((html: string) => {
      const handle = `doc_${this.docCounter++}`
      const { document } = linkedomParseHTML(String(html))
      this.docMap.set(handle, document)
      return handle
    }))

    // parsePage(tabId, selector?) → docHandle
    await jail.set('_parsePage', new ivm.Reference(async (tabId: string, selector?: string) => {
      const sel = selector ? JSON.stringify(selector) : 'null'
      const code = `(() => { const el = ${sel} ? document.querySelector(${sel}) : document.documentElement; return el ? el.outerHTML : ''; })()`
      const html = await this.tabManager.exec(tabId, code)
      const handle = `doc_${this.docCounter++}`
      const { document } = linkedomParseHTML(String(html))
      this.docMap.set(handle, document)
      return handle
    }))

    // domQueryAll(handle, selector) → serialized elements
    await jail.set('_domQueryAll', new ivm.Reference((handle: string, selector: string) => {
      const doc = this.docMap.get(handle)
      if (!doc) throw new Error(`Document not found: ${handle}`)
      const els = [...doc.querySelectorAll(selector)]
      return new ivm.ExternalCopy(els.map(serializeElement)).copyInto()
    }))

    // domQueryOne(handle, selector) → serialized element or null
    await jail.set('_domQueryOne', new ivm.Reference((handle: string, selector: string) => {
      const doc = this.docMap.get(handle)
      if (!doc) throw new Error(`Document not found: ${handle}`)
      const el = doc.querySelector(selector)
      if (!el) return null
      return new ivm.ExternalCopy(serializeElementFull(el)).copyInto()
    }))

    // domText(handle, selector) → string[]
    await jail.set('_domText', new ivm.Reference((handle: string, selector: string) => {
      const doc = this.docMap.get(handle)
      if (!doc) throw new Error(`Document not found: ${handle}`)
      const els = [...doc.querySelectorAll(selector)]
      return new ivm.ExternalCopy(els.map((el: any) => (el.textContent || '').trim().slice(0, 500))).copyInto()
    }))

    // freeDoc(handle)
    await jail.set('_freeDoc', new ivm.Reference((handle: string) => {
      this.docMap.delete(handle)
    }))

    // --- Bootstrap the REPL environment inside the isolate ---
    await this.context.eval(`
      // env object for user variable storage
      const env = {};

      // Tab management
      async function execInTab(tabId, code) {
        return _execInTab.apply(undefined, [tabId, code], { arguments: { copy: true }, result: { promise: true, copy: true } });
      }
      async function openTab(url) {
        return _openTab.apply(undefined, [url || ''], { arguments: { copy: true }, result: { promise: true, copy: true } });
      }
      function closeTab(tabId) {
        _closeTab.applySync(undefined, [tabId], { arguments: { copy: true } });
      }
      function navigate(tabId, url) {
        _navigate.applySync(undefined, [tabId, url], { arguments: { copy: true } });
      }
      function switchTab(tabId) {
        _switchTab.applySync(undefined, [tabId], { arguments: { copy: true } });
      }
      async function waitForLoad(tabId, timeout) {
        return _waitForLoad.apply(undefined, [tabId, timeout || 30000], { arguments: { copy: true }, result: { promise: true } });
      }
      async function waitForSelector(tabId, selector, timeout) {
        return _waitForSelector.apply(undefined, [tabId, selector, timeout || 30000], { arguments: { copy: true }, result: { promise: true } });
      }

      // Tab getters (evaluated fresh each call via Reference)
      Object.defineProperty(globalThis, 'tabs', {
        get() { return _getTabs.applySync(undefined, [], { result: { copy: true } }); }
      });
      Object.defineProperty(globalThis, 'activeTab', {
        get() { return _getActiveTab.applySync(undefined, [], { result: { copy: true } }); }
      });

      // DOM introspection convenience wrappers (all via execInTab)
      async function getText(tabId, selector) {
        const sel = selector ? JSON.stringify(selector) : 'null';
        return execInTab(tabId, \`
          (() => {
            const el = \${sel} ? document.querySelector(\${sel}) : document.body;
            return el ? el.innerText : null;
          })()
        \`);
      }

      async function getDOM(tabId, selector) {
        const sel = selector ? JSON.stringify(selector) : 'null';
        return execInTab(tabId, \`
          (() => {
            const el = \${sel} ? document.querySelector(\${sel}) : document.documentElement;
            return el ? el.outerHTML : null;
          })()
        \`);
      }

      async function getLinks(tabId) {
        return execInTab(tabId, \`
          [...document.querySelectorAll('a[href]')].map(a => ({
            text: a.innerText.trim().slice(0, 100),
            href: a.href
          }))
        \`);
      }

      async function getSearchResults(tabId) {
        const code = '(' + function() {
          var results = [];
          var container = document.querySelector('#search') || document.body;
          var h3s = container.querySelectorAll('h3');
          for (var i = 0; i < h3s.length; i++) {
            var h3 = h3s[i];
            var a = h3.closest('a');
            if (!a || !a.href) continue;
            // Walk up to find a snippet near this result
            var block = a.closest('[data-hveid]') || a.parentElement && a.parentElement.parentElement;
            var snippet = '';
            if (block) {
              var textNodes = block.querySelectorAll('span, em');
              var parts = [];
              for (var j = 0; j < textNodes.length; j++) {
                var t = textNodes[j].innerText;
                if (t && t.length > 40 && t !== h3.innerText) {
                  parts.push(t.trim());
                }
              }
              snippet = parts.join(' ').slice(0, 300);
            }
            results.push({ title: h3.innerText.trim(), url: a.href, snippet: snippet });
          }
          return results;
        } + ')()';
        return execInTab(tabId, code);
      }

      async function getWikiTables(tabId) {
        const code = '(' + function() {
          function clean(s) { return s.trim().split(String.fromCharCode(10)).join(' '); }
          var tables = document.querySelectorAll('table.wikitable');
          var result = [];
          for (var t = 0; t < tables.length && t < 5; t++) {
            var table = tables[t];
            var caption = table.querySelector('caption');
            var capText = caption ? clean(caption.innerText) : '';
            var headerRow = table.querySelector('tr');
            if (!headerRow) continue;
            var ths = headerRow.querySelectorAll('th');
            var headers = [];
            for (var h = 0; h < ths.length; h++) {
              headers.push(clean(ths[h].innerText));
            }
            if (headers.length === 0) continue;
            var bodyRows = table.querySelectorAll('tr');
            var rows = [];
            for (var r = 1; r < bodyRows.length && r <= 50; r++) {
              var cells = bodyRows[r].querySelectorAll('td, th');
              var row = {};
              for (var c = 0; c < cells.length && c < headers.length; c++) {
                row[headers[c]] = clean(cells[c].innerText);
              }
              if (Object.keys(row).length > 0) rows.push(row);
            }
            result.push({ caption: capText, headers: headers, rowCount: bodyRows.length - 1, rows: rows });
          }
          return result;
        } + ')()';
        return execInTab(tabId, code);
      }

      async function getInputs(tabId) {
        return execInTab(tabId, \`
          [...document.querySelectorAll('input, textarea, select')].map(el => ({
            id: el.id || '',
            name: el.name || '',
            type: el.type || el.tagName.toLowerCase(),
            value: el.value || '',
            placeholder: el.placeholder || ''
          }))
        \`);
      }

      async function querySelector(tabId, sel) {
        return execInTab(tabId, \`
          (() => {
            const el = document.querySelector(\${JSON.stringify(sel)});
            if (!el) return null;
            return {
              tagName: el.tagName,
              id: el.id || '',
              className: el.className || '',
              innerText: (el.innerText || '').slice(0, 200),
              href: el.href || '',
              src: el.src || '',
              value: el.value || '',
              type: el.type || ''
            };
          })()
        \`);
      }

      async function querySelectorAll(tabId, sel) {
        return execInTab(tabId, \`
          [...document.querySelectorAll(\${JSON.stringify(sel)})].map(el => ({
            tagName: el.tagName,
            id: el.id || '',
            className: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
            innerText: (el.innerText || '').slice(0, 200),
            href: el.href || '',
            src: el.src || ''
          }))
        \`);
      }

      // Browser actions
      async function click(tabId, selector) {
        return execInTab(tabId, \`
          (() => {
            const el = document.querySelector(\${JSON.stringify(selector)});
            if (!el) throw new Error('Element not found: ' + \${JSON.stringify(selector)});
            el.click();
            return true;
          })()
        \`);
      }

      async function type(tabId, selector, text) {
        return execInTab(tabId, \`
          (() => {
            const el = document.querySelector(\${JSON.stringify(selector)});
            if (!el) throw new Error('Element not found: ' + \${JSON.stringify(selector)});
            el.focus();
            el.value = \${JSON.stringify(text)};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()
        \`);
      }

      // Utility functions
      function log(message) {
        _log.applySync(undefined, [String(message)], { arguments: { copy: true } });
      }

      async function sleep(ms) {
        return _sleep.apply(undefined, [ms], { arguments: { copy: true }, result: { promise: true } });
      }

      function setFinal(value) {
        const serializable = JSON.parse(JSON.stringify(value));
        _setFinal.applySync(undefined, [serializable], { arguments: { copy: true } });
      }

      // Recursive LLM calls — data is passed as-is, no JSON.stringify wrapper
      async function llm_query(prompt, data) {
        // Unwrap truncated results — sub-agents just need the string content
        let clean = data;
        if (clean && typeof clean === 'object' && clean.__truncated) {
          clean = clean.data;
        }
        const args = clean !== undefined ? [prompt, clean] : [prompt];
        return _llm_query.apply(undefined, args, { arguments: { copy: true }, result: { promise: true, copy: true } });
      }

      async function llm_batch(prompts) {
        const normalized = prompts.map(p => {
          let d = p.data;
          if (d && typeof d === 'object' && d.__truncated) d = d.data;
          return { prompt: p.prompt || p, data: d !== undefined ? d : undefined };
        });
        return _llm_batch.apply(undefined, [normalized], { arguments: { copy: true }, result: { promise: true, copy: true } });
      }

      // Host-side DOM parsing (linkedom)
      async function parseHTML(html) {
        return _parseHTML.apply(undefined, [html], { arguments: { copy: true }, result: { copy: true } });
      }
      async function parsePage(tabId, selector) {
        return _parsePage.apply(undefined, [tabId, selector || ''], { arguments: { copy: true }, result: { promise: true, copy: true } });
      }
      async function domQueryAll(doc, selector) {
        return _domQueryAll.apply(undefined, [doc, selector], { arguments: { copy: true }, result: { copy: true } });
      }
      async function domQueryOne(doc, selector) {
        return _domQueryOne.apply(undefined, [doc, selector], { arguments: { copy: true }, result: { copy: true } });
      }
      async function domText(doc, selector) {
        return _domText.apply(undefined, [doc, selector], { arguments: { copy: true }, result: { copy: true } });
      }
      function freeDoc(doc) {
        _freeDoc.applySync(undefined, [doc], { arguments: { copy: true } });
      }

      // Stubs for deferred APIs
      async function getAccessibilityTree() { throw new Error('getAccessibilityTree not yet implemented'); }
      async function screenshot() { throw new Error('screenshot not yet implemented'); }
      async function getCookies() { throw new Error('getCookies not yet implemented'); }
      async function setCookie() { throw new Error('setCookie not yet implemented'); }
      async function getLocalStorage() { throw new Error('getLocalStorage not yet implemented'); }
      async function getSessionStorage() { throw new Error('getSessionStorage not yet implemented'); }
      async function clearStorage() { throw new Error('clearStorage not yet implemented'); }
      async function getRecentRequests() { throw new Error('getRecentRequests not yet implemented'); }
      async function interceptRequests() { throw new Error('interceptRequests not yet implemented'); }
      async function getResponseBody() { throw new Error('getResponseBody not yet implemented'); }
      async function getConsoleLog() { throw new Error('getConsoleLog not yet implemented'); }
      async function getErrors() { throw new Error('getErrors not yet implemented'); }
      async function fill() { throw new Error('fill not yet implemented'); }
      async function scroll(tabId, direction, amount) {
        const amt = amount || 500;
        const dir = direction === 'up' ? -amt : amt;
        return execInTab(tabId, \`window.scrollBy(0, \${dir})\`);
      }
      async function keyPress() { throw new Error('keyPress not yet implemented'); }
      async function hover() { throw new Error('hover not yet implemented'); }
      async function select() { throw new Error('select not yet implemented'); }
      async function store() { throw new Error('store not yet implemented — will be wired in Phase 6'); }
      async function retrieve() { throw new Error('retrieve not yet implemented — will be wired in Phase 6'); }
    `)
  }

  /**
   * Hoist top-level const/let/var declarations to globalThis so they persist
   * across execute() calls. The IIFE wrapper scopes these otherwise.
   * Transforms: `const x = value` → `x = value` (with `var x;` pre-declared globally)
   */
  private hoistVariables(code: string): { declarations: string; transformedCode: string } {
    const varNames: string[] = []
    // Match top-level declarations: const/let/var followed by identifier and =
    // Skip lines inside for/while loops by checking context
    const transformed = code.replace(
      /^([ \t]*)(const|let|var)\s+(\w+)\s*=/gm,
      (match, indent, _keyword, name, offset) => {
        // Don't hoist if this is inside a for(...) statement
        const before = code.slice(Math.max(0, offset - 30), offset)
        if (/for\s*\(/.test(before)) return match
        varNames.push(name)
        return `${indent}${name} =`
      }
    )
    return {
      declarations: varNames.length > 0 ? `var ${varNames.join(', ')};` : '',
      transformedCode: transformed,
    }
  }

  /** Execute LLM-generated code in the isolate */
  async execute(code: string): Promise<unknown> {
    if (!this.context) throw new Error('REPL not initialized')

    this.finalCalled = false

    // Hoist variable declarations to global scope so they persist between executions
    const { declarations, transformedCode } = this.hoistVariables(code)
    if (declarations) {
      try {
        await this.context.eval(declarations, { timeout: 1000 })
      } catch {
        // Variable may already exist — that's fine
      }
    }

    const wrappedCode = `(async () => { ${transformedCode} })()`
    try {
      const result = await this.context.eval(wrappedCode, {
        timeout: EXEC_TIMEOUT_MS,
        promise: true,
        copy: true,
      })
      return capResult(result)
    } catch (err: any) {
      return { __rlm_error: true, message: err.message, stack: err.stack?.slice(0, 500) }
    }
  }

  /** Check if setFinal() was called during the last execution */
  isFinalCalled(): boolean {
    return this.finalCalled
  }

  /** Get the value passed to setFinal() */
  getFinalValue(): unknown {
    return this.finalValue
  }

  /** Get env variables AND top-level user variables metadata for context building */
  async getEnvMetadata(): Promise<Record<string, unknown>> {
    if (!this.context) return {}
    try {
      const result = await this.context.eval(`
        (() => {
          const BUILTIN_NAMES = new Set([
            'env', 'execInTab', 'openTab', 'closeTab', 'navigate', 'switchTab',
            'waitForLoad', 'waitForSelector', 'getText', 'getDOM', 'getLinks', 'getSearchResults', 'getWikiTables', 'getInputs',
            'querySelector', 'querySelectorAll', 'click', 'type', 'scroll',
            'parseHTML', 'parsePage', 'domQueryAll', 'domQueryOne', 'domText', 'freeDoc',
            'log', 'sleep', 'setFinal', 'llm_query', 'llm_batch',
            'getAccessibilityTree', 'screenshot', 'getCookies', 'setCookie',
            'getLocalStorage', 'getSessionStorage', 'clearStorage',
            'getRecentRequests', 'interceptRequests', 'getResponseBody',
            'getConsoleLog', 'getErrors', 'fill', 'keyPress', 'hover', 'select',
            'store', 'retrieve',
            '_execInTab', '_openTab', '_closeTab', '_navigate', '_switchTab',
            '_waitForLoad', '_waitForSelector', '_sleep', '_getTabs', '_getActiveTab', '_log', '_setFinal',
            '_llm_query', '_llm_batch',
            '_parseHTML', '_parsePage', '_domQueryAll', '_domQueryOne', '_domText', '_freeDoc',
            'globalThis', 'undefined', 'NaN', 'Infinity',
          ]);

          function describeVar(val) {
            if (val === null) return { type: 'null', value: 'null' };
            if (val === undefined) return { type: 'undefined', value: 'undefined' };
            const type = Array.isArray(val) ? 'Array' : typeof val;
            if (Array.isArray(val)) {
              const elemType = val.length > 0 ? (typeof val[0] === 'object' && val[0] !== null ? 'Object' : typeof val[0]) : 'unknown';
              const desc = { type: 'Array<' + elemType + '>', length: val.length, size: JSON.stringify(val).length };
              if (val.length > 0 && typeof val[0] === 'object' && val[0] !== null) {
                desc.schema = Object.keys(val[0]).join(', ');
              }
              desc.preview = JSON.stringify(val).slice(0, 200);
              return desc;
            } else if (type === 'object') {
              const keys = Object.keys(val);
              return { type: 'Object', keys: keys.length, keyNames: keys.join(', '), size: JSON.stringify(val).length, preview: JSON.stringify(val).slice(0, 200) };
            } else if (type === 'string') {
              return { type: 'string', length: val.length, preview: val.slice(0, 200) };
            } else {
              return { type, value: String(val).slice(0, 200) };
            }
          }

          const meta = {};

          // Env variables
          for (const key of Object.keys(env)) {
            meta['env.' + key] = describeVar(env[key]);
          }

          // Top-level user variables (hoisted from const/let/var)
          const globalKeys = Object.getOwnPropertyNames(globalThis);
          for (const key of globalKeys) {
            if (BUILTIN_NAMES.has(key)) continue;
            if (key.startsWith('_')) continue;
            if (key === 'tabs' || key === 'activeTab') continue;
            try {
              const val = globalThis[key];
              if (typeof val === 'function') continue;
              meta[key] = describeVar(val);
            } catch {}
          }

          return meta;
        })()
      `, { copy: true, timeout: 5000 })
      return result as Record<string, unknown>
    } catch {
      return {}
    }
  }

  /** Destroy the isolate and free resources */
  dispose(): void {
    this.docMap.clear()
    this.docCounter = 0
    if (this.isolate) {
      try {
        this.isolate.dispose()
      } catch {
        // Already disposed
      }
      this.isolate = null
      this.context = null
    }
  }
}
