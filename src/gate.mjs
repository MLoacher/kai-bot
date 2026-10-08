// Die Tuer. Entscheidet fest im Code, bevor irgendetwas gespeichert,
// heruntergeladen oder an Claude gegeben wird, ob eine Nachricht Kai
// ueberhaupt erreicht:
//
//   - Gruppen: nur die in KAI_GROUPS eingetragenen.
//   - Direktnachrichten: nur vom Besitzer, erkannt an seiner Telefonnummer.
//   - alles andere (fremde Gruppen, fremde Direktnachrichten, Status,
//     Kanaele, Broadcasts): verworfen.
//
// Liefert die kanonische Chat-ID, unter der die Nachricht abgelegt wird,
// oder null. Der Direktchat mit dem Besitzer hat immer dieselbe ID
// (<nummer>@s.whatsapp.net), egal ob WhatsApp ihn gerade unter der
// Telefonnummer oder unter einer LID fuehrt.

export const ownerChatJid = (ownerNumber) => (ownerNumber ? `${ownerNumber}@s.whatsapp.net` : null)

export async function resolveChat(key, { groups, ownerNumber, dmNumbers = [], toPhone }) {
  const jid = key?.remoteJid
  if (!jid) return null
  if (jid.endsWith('@g.us')) return groups.includes(jid) ? jid : null
  if (!jid.endsWith('@s.whatsapp.net') && !jid.endsWith('@lid')) return null
  for (const candidate of [key.remoteJidAlt, jid]) {
    if (!candidate) continue
    const phone = await toPhone(candidate)
    if (!phone) continue
    if (ownerNumber && phone === ownerNumber) return ownerChatJid(ownerNumber)
    // Zusaetzlich freigegebene Direktchats: kanonisch unter der Telefonnummer.
    if (dmNumbers.includes(phone)) return `${phone}@s.whatsapp.net`
  }
  return null
}

export const isDirectChat = (chatJid) => !chatJid.endsWith('@g.us')

// Die zweite Tuer, nach draussen: Kai darf nur in einen Chat schreiben, aus
// dem er auch lesen darf. Jeder Versand laeuft hier durch, egal welches
// Werkzeug ihn ausloest. Eine Direktnachricht an jemand anderen als den
// Besitzer ist damit im Code ausgeschlossen, nicht nur im Prompt.
export function isAllowedRecipient(jid, { groups, ownerNumber, dmNumbers = [] }) {
  if (!jid) return false
  if (jid.endsWith('@g.us')) return groups.includes(jid)
  if (ownerNumber && jid === ownerChatJid(ownerNumber)) return true
  return dmNumbers.some((n) => jid === `${n}@s.whatsapp.net`)
}
