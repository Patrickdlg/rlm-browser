/**
 * Code block extraction with fallback chain.
 * Models frequently deviate from expected format, so we try multiple strategies.
 */

/** Extract fenced code blocks with a specific tag */
function extractFenced(response: string, tag: string): string[] {
  const regex = new RegExp('```' + tag + '\\s*\\n([\\s\\S]*?)```', 'g')
  const blocks: string[] = []
  let match
  while ((match = regex.exec(response)) !== null) {
    const trimmed = match[1].trim()
    if (trimmed) blocks.push(trimmed)
  }
  return blocks
}

/** Extract any fenced code block (```js, ```javascript, ```, etc.) */
function extractAnyFenced(response: string): string[] {
  const regex = /```(?:\w*)\s*\n([\s\S]*?)```/g
  const blocks: string[] = []
  let match
  while ((match = regex.exec(response)) !== null) {
    const trimmed = match[1].trim()
    if (trimmed) blocks.push(trimmed)
  }
  return blocks
}

/** Extract from tool-call JSON format (some models output {"code":"..."}) */
function extractFromToolCallJSON(response: string): string[] {
  try {
    const parsed = JSON.parse(response.trim())
    if (parsed.code && typeof parsed.code === 'string') {
      return [parsed.code]
    }
  } catch {
    // Not JSON
  }

  // Try to find JSON embedded in the response
  const jsonMatch = response.match(/\{[\s\S]*"code"\s*:\s*"[\s\S]*?"\s*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0])
      if (parsed.code) return [parsed.code]
    } catch {
      // Malformed JSON
    }
  }

  return []
}

/** Detect bare code lines that look like JavaScript */
function extractBareCode(response: string): string[] {
  const lines = response.split('\n')
  const codeLines: string[] = []
  let inCodeSection = false

  for (const line of lines) {
    const trimmed = line.trim()

    // Detect lines that look like JS statements
    const isCodeLine =
      /^(const |let |var |await |return |if |for |while |try |catch |function |class |env\.|log\(|setFinal\(|\/\/)/.test(trimmed) ||
      /^(execInTab|openTab|closeTab|navigate|switchTab|waitForLoad|getText|getDOM|getLinks|getInputs|querySelector|querySelectorAll|click|type|fill|scroll|keyPress|hover|select|llm_query|llm_batch|sleep)\s*\(/.test(trimmed)

    if (isCodeLine) {
      inCodeSection = true
      codeLines.push(line)
    } else if (inCodeSection && trimmed && !trimmed.startsWith('#') && !trimmed.match(/^[A-Z][a-z]+ [a-z]/)) {
      // Continue collecting code (e.g., object literals, continuation)
      codeLines.push(line)
    } else if (inCodeSection && !trimmed) {
      // Empty line might be part of code
      codeLines.push(line)
    } else {
      inCodeSection = false
    }
  }

  const code = codeLines.join('\n').trim()
  return code ? [code] : []
}

/**
 * Extract executable code blocks from an LLM response.
 * Uses a fallback chain: ```repl → any fenced → tool-call JSON → bare code
 */
export function extractCodeBlocks(response: string): string[] {
  // Strategy 1: Fenced ```repl blocks (preferred)
  let blocks = extractFenced(response, 'repl')
  if (blocks.length > 0) return blocks

  // Strategy 2: Any fenced code block
  blocks = extractAnyFenced(response)
  if (blocks.length > 0) return blocks

  // Strategy 3: Tool-call JSON format
  blocks = extractFromToolCallJSON(response)
  if (blocks.length > 0) return blocks

  // Strategy 4: Bare code detection
  blocks = extractBareCode(response)
  return blocks // May be empty — triggers continuation prompt
}
