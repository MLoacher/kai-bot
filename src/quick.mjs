import { query } from '@anthropic-ai/claude-agent-sdk'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { config } from './config.mjs'

// Ein kleiner Claude-Aufruf ohne Werkzeuge und ohne Session: Inhalt rein,
// Text raus. Fuer Nebenaufgaben wie Sticker beschreiben oder den Vorfilter,
// die nichts mit Kais eigentlicher Unterhaltung zu tun haben.
export async function quickClaude({ content, system, model = 'haiku' }) {
  const home = join(config.dataDir, 'claude')
  const workspace = join(config.dataDir, 'workspace')
  mkdirSync(workspace, { recursive: true })

  async function* prompt() {
    yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content } }
  }

  let result = null
  for await (const m of query({
    prompt: prompt(),
    options: {
      systemPrompt: system,
      model,
      maxTurns: 1,
      cwd: workspace,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      skills: [],
      plugins: [],
      persistSession: false,
      canUseTool: async () => ({ behavior: 'deny', message: 'keine Werkzeuge' }),
      env: {
        PATH: process.env.PATH,
        HOME: home,
        CLAUDE_CONFIG_DIR: home,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
        DISABLE_AUTOUPDATER: '1',
        TZ: process.env.TZ || 'Europe/Berlin',
      },
    },
  })) {
    if (m.type === 'result') result = m
  }
  if (!result || result.subtype !== 'success' || result.is_error) throw new Error(`Claude-Kurzaufruf fehlgeschlagen: ${result?.subtype || 'kein Ergebnis'}`)
  return (result.result || '').trim()
}
