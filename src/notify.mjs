import { config } from './config.mjs'

// Meldung an ntfy. Darf den Aufrufer nie zu Fall bringen: Zeitlimit, ein
// zweiter Versuch, und wenn ntfy nicht erreichbar ist, landet die Meldung
// wenigstens im Containerlog.
export async function notify(title, message, { priority = 'high', tags = 'warning' } = {}) {
  const line = `[ntfy] ${title}: ${message}`
  if (!config.ntfy.url || !config.ntfy.token) {
    console.error(line, '(ntfy nicht konfiguriert)')
    return false
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`${config.ntfy.url}/${config.ntfy.topic}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.ntfy.token}`,
          Title: encodeHeader(title),
          Priority: priority,
          Tags: tags,
        },
        body: message,
        signal: AbortSignal.timeout(10_000),
      })
      if (res.ok) return true
      console.error(line, `(ntfy HTTP ${res.status})`)
    } catch (err) {
      console.error(line, `(ntfy nicht erreichbar: ${err.message})`)
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  return false
}

// HTTP-Header duerfen nur Latin-1 tragen; ntfy versteht RFC-2047-kodierte Titel.
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`
}

// Dieselbe Meldung nicht im Minutentakt wiederholen.
const lastSent = new Map()
export async function notifyOnce(key, everyMs, title, message, opts) {
  const now = Date.now()
  if (now - (lastSent.get(key) || 0) < everyMs) return false
  lastSent.set(key, now)
  return notify(title, message, opts)
}
