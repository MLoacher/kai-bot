// Sprachnachrichten zu Text, ueber die OpenAI-API. Claude selbst kann kein
// Audio. Der Schluessel bleibt im Bruecken-Prozess, der Claude-Prozess
// bekommt ihn nie zu sehen.

const URL = 'https://api.openai.com/v1/audio/transcriptions'
const MAX_BYTES = 25 * 1024 * 1024 // Grenze der API

export const transcriptionEnabled = () => Boolean(process.env.OPENAI_API_KEY)

// Liefert den Text. Wirft bei Fehlern, damit der Aufrufer melden kann.
export async function transcribe(buf, { mime = 'audio/ogg', filename = 'sprachnachricht.ogg', timeoutMs = 120_000 } = {}) {
  if (!transcriptionEnabled()) throw new Error('OPENAI_API_KEY fehlt')
  if (buf.length > MAX_BYTES) throw new Error(`zu gross (${Math.round(buf.length / 1024 / 1024)} MB, hoechstens 25)`)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: mime }), filename)
  form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-transcribe')
  form.append('response_format', 'text')
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.text()
  if (!res.ok) {
    const err = new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  return body.trim()
}

// Transkript MIT Zeitmarken (Segmente start/end/text). Dafuer Whisper, weil die
// gpt-4o-transcribe-Modelle kein verbose_json/Zeitmarken koennen. Damit kann Kai
// erkennen, WANN im Audio welcher Teil gesprochen wird, und gezielt schneiden.
const TIMESTAMP_MODEL = process.env.KAI_TIMESTAMP_MODEL || 'whisper-1'

export async function transcribeSegments(buf, { mime = 'audio/ogg', filename = 'audio.ogg', timeoutMs = 120_000 } = {}) {
  if (!transcriptionEnabled()) throw new Error('OPENAI_API_KEY fehlt')
  if (buf.length > MAX_BYTES) throw new Error(`zu gross (${Math.round(buf.length / 1024 / 1024)} MB, hoechstens 25)`)
  const form = new FormData()
  form.append('file', new Blob([buf], { type: mime }), filename)
  form.append('model', TIMESTAMP_MODEL)
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'segment')
  const res = await fetch(URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const body = await res.text()
  if (!res.ok) {
    const err = new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  const json = JSON.parse(body)
  return {
    duration: json.duration ?? null,
    text: (json.text || '').trim(),
    segments: (json.segments || []).map((s) => ({ start: s.start, end: s.end, text: String(s.text || '').trim() })),
  }
}
