// Text zu Sprache, ueber die OpenAI-API. Gegenstueck zu transcribe.mjs. Der
// Schluessel bleibt im Bruecken-Prozess, der Claude-Prozess bekommt ihn nie zu
// sehen. Fuer Sprachnachrichten im Chat und fuer Erklaer-Ton in Videos.
const URL = 'https://api.openai.com/v1/audio/speech'
const MAX_CHARS = 4000 // API-Grenze ~4096

export const ttsEnabled = () => Boolean(process.env.OPENAI_API_KEY)

// Die Stimmen, die OpenAI anbietet.
export const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse']

// Grundton: professionell und eher zuegig, nicht langsam, nicht monoton. Gilt
// fuer alle Ausgaben, solange kein eigener Stil mitgegeben wird.
export const DEFAULT_STYLE = 'Sprich professionell, klar und selbstbewusst, in einem natürlichen, eher zügigen Tempo. Nicht langsam und nicht monoton, sondern wach und verständlich, wie ein guter Erklärsprecher.'

// format: 'opus' fuer Sprachnachrichten (Ogg/Opus), 'mp3' als Datei. `stil`
// steuert Tempo und Ton (nur bei gpt-4o-mini-tts; tts-1 kennt nur `speed`).
// Liefert einen Buffer. Wirft bei Fehlern (mit .status), damit der Aufrufer melden kann.
export async function speak(text, { voice = 'alloy', format = 'opus', stil, timeoutMs = 120_000 } = {}) {
  if (!ttsEnabled()) throw new Error('OPENAI_API_KEY fehlt')
  const input = String(text || '').slice(0, MAX_CHARS)
  if (!input.trim()) throw new Error('kein Text')
  const v = VOICES.includes(String(voice)) ? String(voice) : 'alloy'
  const model = process.env.KAI_TTS_MODEL || 'gpt-4o-mini-tts'
  const body = { model, input, voice: v, response_format: format }
  if (model.startsWith('tts-1')) body.speed = 1.1 // zuegig; tts-1 kann keinen Stil
  else body.instructions = String(stil || DEFAULT_STYLE).slice(0, 1500)
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const body = await res.text()
    const err = new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  return Buffer.from(await res.arrayBuffer())
}
