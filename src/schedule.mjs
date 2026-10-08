// Zeitrechnung fuer geplante Aufgaben. Alles in der Ortszeit des Containers
// (TZ=Europe/Berlin), damit "morgen um 7" auch nach der Zeitumstellung 7 ist.

export const REPEATS = ['einmal', 'taeglich', 'werktags', 'woechentlich']

// "2026-09-25 07:00" -> Unix-Sekunden, oder null.
export function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(s).trim())
  if (!m) return null
  const [, y, mo, d, h, mi] = m.map(Number)
  const date = new Date(y, mo - 1, d, h, mi)
  if (date.getMonth() !== mo - 1 || date.getDate() !== d || date.getHours() !== h) return null
  return Math.floor(date.getTime() / 1000)
}

export function formatLocal(sec) {
  const d = new Date(sec * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Naechster Termin nach `prev`, der nicht in der Vergangenheit liegt.
// Rechnet mit Kalendertagen, nicht mit 24 Stunden.
export function nextRun(prev, repeat, now = Math.floor(Date.now() / 1000)) {
  if (repeat === 'einmal') return null
  const d = new Date(prev * 1000)
  do {
    d.setDate(d.getDate() + (repeat === 'woechentlich' ? 7 : 1))
    if (repeat === 'werktags') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  } while (d.getTime() / 1000 <= now)
  return Math.floor(d.getTime() / 1000)
}

// Tagesrunde: eine zufaellige Uhrzeit am Tag, zwischen 5:00 und 23:59 Uhr.
// Startet der Server erst spaeter am Tag, liegt die Zeit zwischen jetzt (plus
// eine Minute) und Mitternacht. Nach 23:59 gibt es fuer heute keine mehr.
export function pickDailyTime(day, now = Math.floor(Date.now() / 1000), rand = Math.random) {
  const from = Math.max(parseLocal(`${day} 05:00`), now + 60)
  const to = parseLocal(`${day} 23:59`)
  if (from > to) return null
  return from + Math.floor(rand() * (to - from))
}
