import { normalizeMessageContent, getContentType } from 'baileys'

// Macht aus einer WhatsApp-Nachricht etwas, das sich als eine Zeile im
// Verlauf lesen laesst. Medien werden hier nur beschrieben, geladen wird
// spaeter. Liefert null fuer Nachrichten ohne Inhalt (Schluesselaustausch,
// Lesebestaetigungen und aehnliches).
export function describe(msg) {
  const content = normalizeMessageContent(msg.message)
  if (!content) return null
  const type = getContentType(content)
  if (!type) return null
  const inner = content[type]
  const ctx = (inner && typeof inner === 'object' && inner.contextInfo) || {}
  const base = {
    quotedWaId: ctx.stanzaId || null,
    quotedParticipant: ctx.participant || null,
    mentionedJids: ctx.mentionedJid || [],
  }

  switch (type) {
    case 'conversation':
      return { ...base, kind: 'text', text: content.conversation }
    case 'extendedTextMessage':
      return { ...base, kind: 'text', text: inner.text }
    case 'imageMessage':
      return { ...base, kind: 'image', text: inner.caption || '', media: 'image' }
    case 'stickerMessage':
      return {
        ...base, kind: 'sticker', text: inner.isAnimated ? '(animiert)' : '', media: 'sticker',
        animated: Boolean(inner.isAnimated),
        hash: inner.fileSha256?.length ? Buffer.from(inner.fileSha256).toString('base64') : null,
      }
    case 'videoMessage':
    case 'ptvMessage': // runde Videonachricht
      // Geladen und zerlegt wird spaeter (video.mjs). Klappt das nicht,
      // bleibt wenigstens das Vorschaubild.
      return {
        ...base, kind: inner.gifPlayback ? 'gif' : 'video',
        text: [inner.seconds ? `${inner.seconds} s` : '', inner.caption || ''].filter(Boolean).join(', '),
        media: 'video', gif: Boolean(inner.gifPlayback),
        bytes: Number(inner.fileLength) || 0,
        thumbnail: Boolean(inner.jpegThumbnail?.length),
      }
    case 'audioMessage':
      return { ...base, kind: inner.ptt ? 'voice' : 'audio', text: inner.seconds ? `${inner.seconds} s` : '', media: 'audio', mime: inner.mimetype || 'audio/ogg' }
    case 'documentMessage':
      return {
        ...base, kind: 'document',
        text: [inner.fileName || 'Datei', inner.caption || ''].filter(Boolean).join(': '),
        media: inner.mimetype === 'application/pdf' ? 'pdf' : 'document',
        fileName: inner.fileName || '',
        mime: inner.mimetype || 'application/octet-stream',
      }
    case 'reactionMessage':
      return { ...base, kind: 'reaction', text: inner.text || '', quotedWaId: inner.key?.id || null }
    case 'locationMessage':
    case 'liveLocationMessage':
      return {
        ...base, kind: 'location',
        text: [inner.name, inner.address, `${inner.degreesLatitude}, ${inner.degreesLongitude}`].filter(Boolean).join(', '),
      }
    case 'contactMessage':
      return { ...base, kind: 'contact', text: inner.displayName || '' }
    case 'contactsArrayMessage':
      return { ...base, kind: 'contact', text: (inner.contacts || []).map((c) => c.displayName).join(', ') }
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3': {
      // Das messageSecret braucht Kai spaeter, um mitabzustimmen. Es steht
      // nicht im Umfrage-Knoten selbst, sondern im messageContextInfo.
      const secret = content.messageContextInfo?.messageSecret || inner.contextInfo?.messageSecret
      return {
        ...base, kind: 'poll',
        text: `${inner.name}: ${(inner.options || []).map((o) => o.optionName).join(' / ')}`,
        poll: {
          frage: inner.name || '',
          optionen: (inner.options || []).map((o) => o.optionName),
          mehrfach: (inner.selectableOptionsCount ?? 0) !== 1,
          secret: secret ? Buffer.from(secret).toString('base64') : null,
        },
      }
    }
    case 'pollUpdateMessage':
      return {
        ...base, kind: 'vote', text: '',
        vote: inner.vote ? { encPayload: inner.vote.encPayload, encIv: inner.vote.encIv } : null,
        pollId: inner.pollCreationMessageKey?.id || null,
      }
    case 'protocolMessage':
      if (inner.type === 0 /* REVOKE */) return { ...base, kind: 'deleted', text: '', quotedWaId: inner.key?.id || null }
      if (inner.type === 14 /* MESSAGE_EDIT */) {
        const edited = describe({ message: inner.editedMessage })
        return edited && { ...base, kind: 'edit', text: edited.text, quotedWaId: inner.key?.id || null }
      }
      return null
    default:
      return null
  }
}
