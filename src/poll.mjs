import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { proto } from 'baileys'

// Bei WhatsApp-Umfragen mitstimmen und mitlesen. WhatsApp verschluesselt jede
// Stimme mit einem Geheimnis, das nur in der Umfrage-Nachricht steht
// (messageSecret). Baileys 7 kann Stimmen zwar entschluesseln, aber nicht
// senden, und in Gruppen mit LID-Adressierung sogar das Entschluesseln nicht
// zuverlaessig. Deshalb bauen wir beides hier selbst.
//
// Der Knackpunkt ist die Adressierung: In die Schluesselableitung gehen die
// JIDs von Ersteller und Waehler ein, und sie muessen exakt so lauten, wie die
// anderen Clients sie verwenden. In LID-Gruppen ist das die Telefon-JID
// (…@s.whatsapp.net), nicht die LID. Deshalb probieren wir beim Lesen beide
// Varianten, und beim Senden nehmen wir die Telefon-JID zuerst.

const bin = (s) => Buffer.from(String(s))
export const optionHash = (name) => createHash('sha256').update(bin(name)).digest()

function voteKey({ pollEncKey, pollMsgId, pollCreatorJid, voterJid }) {
  const sign = Buffer.concat([bin(pollMsgId), bin(pollCreatorJid), bin(voterJid), bin('Poll Vote'), Buffer.from([1])])
  const key0 = createHmac('sha256', Buffer.alloc(32)).update(pollEncKey).digest()
  return createHmac('sha256', key0).update(sign).digest()
}

export function encryptPollVote(selectedNames, ctx) {
  const payload = proto.Message.PollVoteMessage.encode({ selectedOptions: selectedNames.map(optionHash) }).finish()
  const key = voteKey(ctx)
  const iv = randomBytes(12)
  const aad = bin(`${ctx.pollMsgId}\u0000${ctx.voterJid}`)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(aad)
  const enc = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()])
  return { encPayload: enc, encIv: iv }
}

// Entschluesselt eine Stimme, wirft bei falschem Schluessel/Adressierung.
// Liefert die Liste der gewaehlten Options-Hashes (hex).
export function decryptPollVote({ encPayload, encIv }, ctx) {
  const key = voteKey(ctx)
  const aad = bin(`${ctx.pollMsgId}\u0000${ctx.voterJid}`)
  const data = Buffer.from(encPayload)
  const tag = data.subarray(data.length - 16)
  const body = data.subarray(0, data.length - 16)
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(encIv))
  d.setAAD(aad)
  d.setAuthTag(tag)
  const plain = Buffer.concat([d.update(body), d.final()])
  const msg = proto.Message.PollVoteMessage.decode(plain)
  return (msg.selectedOptions || []).map((o) => Buffer.from(o).toString('hex'))
}

export function pollVoteMessage(selectedNames, { pollMsgId, pollCreatorJid, voterJid, pollEncKey, creationKey }) {
  const vote = encryptPollVote(selectedNames, { pollMsgId, pollCreatorJid, voterJid, pollEncKey })
  return {
    pollUpdateMessage: { pollCreationMessageKey: creationKey, vote, metadata: {}, senderTimestampMs: Date.now() },
  }
}

// JID ohne Geraete-Suffix (…:12@… -> …@…).
export const normJid = (j) => (j ? j.split(':')[0].split('@')[0] + '@' + j.split('@')[1] : null)

// Alle JIDs, mit denen eine Nachrichten-Kennung ihren Absender benennen kann:
// participant/remoteJid (die eigentliche Adressierung) und ihre *Alt-Formen.
// LID zuerst, weil WhatsApp in LID-Chats damit verschluesselt.
export function keyJids(key) {
  const out = []
  for (const j of [key?.participant, key?.remoteJid, key?.participantAlt, key?.remoteJidAlt]) {
    const n = normJid(j)
    if (n && !out.includes(n)) out.push(n)
  }
  return out
}

// Die JID des Umfrage-Erstellers in der Adressierung des Chats: in LID-Chats
// die LID (aus participant oder remoteJid), sonst die Telefon-JID.
export function pollCreatorJidOf(pollKey) {
  const lid = keyJids(pollKey).find((j) => j.endsWith('@lid'))
  return (pollKey.addressingMode === 'lid' && lid) || normJid(pollKey.participant || pollKey.remoteJid)
}
