// Ist Kai gerade selbst im Gespraech? Dann sind neue Nachrichten oft
// Folgefragen an ihn ("echt? und was sagt Merz dazu?"), auch ohne dass
// sein Name faellt. Kriterium: Kais letzte Nachricht ist juenger als
// `minutes` und hoechstens `withinLast` Nachrichten her.
// rows: die letzten Nachrichten des Chats, zeitlich sortiert.
export function inConversation(rows, { now = Date.now() / 1000, minutes = 10, withinLast = 6 } = {}) {
  let idx = -1
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].from_me) { idx = i; break }
  if (idx < 0) return false
  const after = rows.length - 1 - idx
  return after > 0 && after <= withinLast && now - rows[idx].ts <= minutes * 60
}

// Wie Kai eine Runde liest, in der ihn niemand angesprochen hat:
//   fresh: nach einer Pause von mindestens `freshMinutes` kommt etwas Neues
//          (hoechstens drei Nachrichten). Schnell hinschauen, sonst verpufft es.
//   busy:  mehrere schreiben gerade schnell hin und her. Erst bei einer
//          Pause hinschauen, nicht mitten hinein.
//   normal: alles dazwischen.
// Liefert auch, wie lange es vorher still war (Sekunden, null = unbekannt).
export function lurkMode(rows, { now = Date.now() / 1000, freshMinutes = 20, busyWindow = 60, busyCount = 3 } = {}) {
  if (!rows.length) return { mode: 'normal', idleBefore: null }
  let i = rows.length - 1
  while (i > 0 && rows[i].ts - rows[i - 1].ts < freshMinutes * 60) i--
  const burst = rows.length - i
  const idleBefore = i > 0 ? rows[i].ts - rows[i - 1].ts : null
  if (burst <= 3 && (idleBefore == null || idleBefore >= freshMinutes * 60)) return { mode: 'fresh', idleBefore }
  const recent = rows.filter((r) => !r.from_me && now - r.ts <= busyWindow).length
  return { mode: recent >= busyCount ? 'busy' : 'normal', idleBefore }
}
