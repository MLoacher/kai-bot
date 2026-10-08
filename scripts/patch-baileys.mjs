// Baileys 7.0.0-rc14 setzt das Attribut decrypt-fail="hide" nur bei Reaktionen
// und Pins, nicht bei Umfrage-Stimmen (pollUpdateMessage) -- im Code steht dazu
// sogar "todo: expand ... for other types". Ohne das Attribut verwerfen die
// anderen Clients Kais Stimme, sie zaehlt nicht. Dieser Patch erweitert die
// Bedingung um pollUpdateMessage. Er laeuft beim Docker-Bau und bricht ab,
// wenn er die Stelle nicht findet (etwa nach einem Baileys-Update), damit der
// Fehler auffaellt, statt still zu verschwinden.
import { readFileSync, writeFileSync } from 'node:fs'

const file = 'node_modules/baileys/lib/Socket/messages-send.js'
const src = readFileSync(file, 'utf8')

const needle = "normalizeMessageContent(message)?.pinInChatMessage || normalizeMessageContent(message)?.reactionMessage) {"
const already = 'normalizeMessageContent(message)?.pollUpdateMessage'

if (src.includes(already)) {
  console.log('patch-baileys: pollUpdateMessage bereits behandelt, nichts zu tun')
  process.exit(0)
}
if (!src.includes(needle)) {
  console.error('patch-baileys: Stelle fuer decrypt-fail nicht gefunden -- Baileys geaendert?')
  process.exit(1)
}

const patched = src.replace(
  needle,
  "normalizeMessageContent(message)?.pinInChatMessage || normalizeMessageContent(message)?.reactionMessage || normalizeMessageContent(message)?.pollUpdateMessage) {",
)
writeFileSync(file, patched)
console.log('patch-baileys: decrypt-fail="hide" auch fuer Umfrage-Stimmen gesetzt')
