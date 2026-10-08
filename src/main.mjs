import makeWASocket, {
  Browsers, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion,
  generateMessageIDV2, getKeyAuthor, jidNormalizedUser, makeCacheableSignalKeyStore, normalizeMessageContent, getContentType,
  useMultiFileAuthState,
} from 'baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import QRCode from 'qrcode'
import sharp from 'sharp'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { config } from './config.mjs'
import { Store } from './store.mjs'
import { describe } from './extract.mjs'
import { isAddressed } from './trigger.mjs'
import { buildContent } from './transcript.mjs'
import { runTurn, runSubagent, SILENCE, resolveModel, MODEL_NAMES } from './agent.mjs'
import { notify, notifyOnce } from './notify.mjs'
import { Logs } from './logs.mjs'
import { Memory } from './memory.mjs'
import { resolveChat, ownerChatJid, isDirectChat, isAllowedRecipient } from './gate.mjs'
import { transcribe, transcribeSegments, transcriptionEnabled } from './transcribe.mjs'
import { describeSticker, stickerScore, pixelHash, isRefusal, BLOCKED_DESCRIPTION, stickerView } from './stickers.mjs'
import { probe, contactSheet, extractAudio, clock, MAX_AUDIO_SECONDS } from './video.mjs'
import { pollVoteMessage, decryptPollVote, optionHash, keyJids, pollCreatorJidOf, normJid } from './poll.mjs'
import { createZip, safeEntryName } from './zip.mjs'
import { findSecret } from './secrets.mjs'
import { checkSvg, renderSvg } from './draw.mjs'
import { makeSticker } from './cutout.mjs'
import { runSandbox, sandboxFile, sandboxReady, cleanupSandbox } from './sandbox.mjs'
import { speak, ttsEnabled } from './tts.mjs'
import { humanize, isOnlyDecoration } from './text.mjs'
import { inConversation, lurkMode } from './conversation.mjs'
import { parseLocal, formatLocal, nextRun, pickDailyTime } from './schedule.mjs'

const HOUR = 3600_000
const DAY = 24 * HOUR
const logger = pino({ level: process.env.KAI_LOG_LEVEL || 'warn' })
const store = new Store(config.dataDir)
const logs = new Logs(config.dataDir)
const memory = new Memory(config.dataDir)
const log = (...a) => console.log('[kai]', ...a)

let sock = null
let botJids = new Set()
let loggedOut = false
let connected = false
let lastOpen = Date.now()
const recent = new Map()      // wa_id -> WAMessage, fuer Zitate und Wiederholungen
const groupState = new Map()  // group_jid -> { running, pending, triggerNr, runs: [], failures }

if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
  console.error('[kai] CLAUDE_CODE_OAUTH_TOKEN fehlt. Mit `claude setup-token` erzeugen und in die .env eintragen.')
  process.exit(1)
}

// ---------------------------------------------------------------- WhatsApp

async function connect() {
  const { state, saveCreds } = await useMultiFileAuthState(join(config.dataDir, 'auth'))
  let version
  try { ({ version } = await fetchLatestBaileysVersion()) } catch { /* Standard der Bibliothek */ }
  let pairingRequested = false

  sock = makeWASocket({
    version,
    logger,
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    // Eine gewoehnliche Browser-Kennung: mit einem Fantasienamen lehnt
    // WhatsApp die Kopplung per Code ab.
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: true,
    getMessage: async (key) => recent.get(key.id)?.message || undefined,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (config.phone && !pairingRequested) {
        pairingRequested = true
        try {
          const code = await sock.requestPairingCode(config.phone)
          log(`Kopplungscode fuer +${config.phone}: ${code}`)
          log('WhatsApp auf Kais Telefon > Einstellungen > Verknuepfte Geraete > Geraet hinzufuegen > "Stattdessen mit Telefonnummer verknuepfen"')
        } catch (err) { log('Kopplungscode fehlgeschlagen, bitte QR-Code verwenden:', err.message) }
      }
      // Den QR-Code gibt es immer auch als Bild, er erneuert sich etwa alle
      // 20 Sekunden. Scannen: Kais WhatsApp > Verknuepfte Geraete > Geraet hinzufuegen.
      QRCode.toFile(join(config.dataDir, 'qr.png'), qr, { width: 480, margin: 2 }).catch(() => {})
      if (!config.phone) {
        log('QR-Code mit Kais WhatsApp scannen (Verknuepfte Geraete > Geraet hinzufuegen), auch als /data/qr.png:')
        qrcode.generate(qr, { small: true })
      }
    }
    if (connection === 'open') {
      rmSync(join(config.dataDir, 'qr.png'), { force: true })
      connected = true
      lastOpen = Date.now()
      botJids = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map(jidNormalizedUser))
      log(`verbunden als ${[...botJids].join(', ')}`)
      await listGroups()
      backfillStickers().catch((err) => log('Sticker-Bestand nicht bereinigt:', err.message))
    }
    if (connection === 'close') {
      connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      // Noch nie fertig gekoppelt (Code verfallen, abgebrochen): kein Alarm,
      // sondern frisch anfangen und einen neuen Code holen.
      if (!state.creds.registered) {
        log(`Kopplung nicht abgeschlossen (${code ?? 'unbekannt'}), neuer Code in 10 s`)
        rmSync(join(config.dataDir, 'auth'), { recursive: true, force: true })
        setTimeout(() => connect().catch((e) => log('Verbindungsaufbau fehlgeschlagen:', e.message)), 10_000)
        return
      }
      if (code === DisconnectReason.loggedOut) {
        loggedOut = true
        log('WhatsApp hat Kai abgemeldet. Neu koppeln: siehe README.')
        await notify('Kai abgemeldet', 'WhatsApp hat Kais Geraet abgemeldet, Kai liest und antwortet nicht mehr. Neu koppeln laut kai/README.md.', { priority: 'high' })
        return
      }
      log(`Verbindung getrennt (${code ?? 'unbekannt'}), neuer Versuch in 5 s`)
      setTimeout(() => connect().catch((e) => log('Verbindungsaufbau fehlgeschlagen:', e.message)), 5000)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      try { await handle(msg, { live: type === 'notify' }) } catch (err) { log('Nachricht nicht verarbeitet:', err.message) }
    }
  })

  // Beim ersten Koppeln schickt WhatsApp den vorhandenen Verlauf nach.
  sock.ev.on('messaging-history.set', async ({ messages }) => {
    let n = 0
    for (const msg of messages) {
      try { if (await handle(msg, { live: false })) n++ } catch { /* einzelne kaputte Nachricht */ }
    }
    if (n) log(`${n} Nachrichten aus dem bestehenden Verlauf uebernommen`)
  })
}

async function listGroups() {
  const all = await sock.groupFetchAllParticipating()
  log(`Kai ist in ${Object.keys(all).length} Gruppe(n):`)
  for (const g of Object.values(all)) {
    const active = config.groups.includes(g.id)
    log(`  ${active ? '[aktiv]' : '       '} ${g.id}  ${g.subject}`)
    if (active) store.updateGroup(g.id, { subject: g.subject })
  }
  const dm = ownerChatJid(config.owner.number)
  if (dm) store.updateGroup(dm, { subject: `Direktchat mit ${config.owner.name}` })
  for (const n of config.dmNumbers) { store.updateGroup(`${n}@s.whatsapp.net`, { subject: 'Direktchat' }); log(`  [aktiv] Direktchat mit +${n} freigegeben`) }
  if (!config.groups.length) log('KAI_GROUPS ist leer: Einrichtungsmodus, in Gruppen bleibt Kai still (Direktchat mit dem Besitzer geht). Gewuenschte ID in die .env eintragen.')
}

// Telefonnummer (nur Ziffern) zu einer JID, auch zu einer LID ueber die
// Zuordnung, die WhatsApp mitliefert. Leer, wenn sie sich nicht sicher
// bestimmen laesst: dann gilt der Absender eben nicht als Besitzer.
async function toPhone(jid) {
  if (!jid) return ''
  if (jid.endsWith('@s.whatsapp.net')) return jidNormalizedUser(jid).split('@')[0]
  if (jid.endsWith('@lid')) {
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null)
    if (pn?.endsWith('@s.whatsapp.net')) return jidNormalizedUser(pn).split('@')[0]
  }
  return ''
}

async function senderPhone(key) {
  for (const j of [key.participantAlt, key.participant]) {
    const p = await toPhone(j)
    if (p) return p
  }
  return ''
}

// Jeder Sticker aus einem freigegebenen Chat kommt in Kais Sammlung, ohne
// Dubletten. Im Verlauf steht dann "S<id>", damit Kai ihn zuordnen kann.
// Schickt ihn ein Mensch, zaehlt das fuer die Beliebtheit. Neue Sticker
// werden sofort einmal beschrieben, danach muss niemand mehr hinsehen.
//
// Doppelt ist ein Sticker, wenn eines davon gleich ist:
//   - WhatsApps eigener Fingerabdruck (fileSha256)
//   - die Datei byte-genau (SHA-256)
//   - das Bild pixel-genau, alle Einzelbilder dekodiert. Das faengt denselben
//     Sticker mit anderen Metadaten oder anders verpackt.
// Ein bekannter Sticker wird nicht noch einmal abgelegt: die Nachricht zeigt
// auf die Dateien, die schon in der Sammlung liegen.
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

async function knownSticker(buf, waHash) {
  const byteHash = sha256(buf)
  let known = store.findSticker({ hash: waHash, byteHash })
  let pix = known?.pixel_hash || null
  if (!known) {
    pix = await pixelHash(buf).catch(() => null)
    if (pix) known = store.findSticker({ pixelHash: pix })
  }
  const usable = known && existsSync(known.orig_path) && existsSync(known.view_path)
  return { known: usable ? known : null, byteHash, pixelHash: pix }
}

function linkSticker(nr, t, animated, { fromMe = false, ts = Math.floor(Date.now() / 1000) } = {}) {
  store.setText(nr, `S${t.id}${animated ?? t.animated ? ' (animiert)' : ''}`)
  if (!fromMe) store.seeSticker(t.id, ts)
  if (!t.description) queueDescription(t.id)
  return t.id
}

function collectSticker(nr, { hash, byteHash, pixelHash: pix }, animated, opts) {
  const base = join(store.mediaDir, String(nr))
  const id = store.addSticker({ hash: hash || byteHash, byteHash, pixelHash: pix, origPath: `${base}.orig.webp`, viewPath: `${base}.png`, animated })
  let t = store.sticker(id)
  // Bekannter Sticker, dessen Dateien fehlen: die neuen uebernehmen.
  if (!existsSync(t.orig_path) || !existsSync(t.view_path)) store.setStickerFiles(id, `${base}.orig.webp`, `${base}.png`)
  if (!t.byte_hash && byteHash) store.setStickerHashes(id, byteHash, pix || t.pixel_hash)
  t = store.sticker(id)
  return linkSticker(nr, t, animated, opts)
}

// Beschreibungen nacheinander, nicht alle gleichzeitig.
const describeQueue = []
let describing = false
function queueDescription(id) {
  if (!describeQueue.includes(id)) describeQueue.push(id)
  if (describing) return
  describing = true
  ;(async () => {
    while (describeQueue.length) {
      const next = describeQueue.shift()
      const t = store.sticker(next)
      if (!t || t.description || !existsSync(t.view_path)) continue
      try {
        const text = await describeSticker(readFileSync(t.view_path).toString('base64'), { animated: Boolean(t.animated) })
        if (text && isRefusal(text)) { store.blockSticker(next, BLOCKED_DESCRIPTION); log(`S${next} gesperrt, Beschreibung verweigert`) }
        else if (text) { store.describeSticker(next, text); log(`S${next} beschrieben: ${text}`) }
      } catch (err) {
        log(`S${next} nicht beschrieben:`, err.message)
      }
    }
    describing = false
  })()
}

// Sticker aus der Zeit vor der Sammlung nachtragen, fehlende Beschreibungen nachholen.
// Einmal fuer den Bestand: Fingerabdruecke nachtragen, gleiche Sticker in der
// Sammlung zusammenfuehren, und Kopien auf der Platte, die nur eine weitere
// Nachricht mit demselben Sticker angelegt hat, auf das Original umbiegen und
// loeschen. Idempotent, laeuft bei jedem Start und findet dann nichts mehr.
async function dedupeStickers() {
  for (const t of store.stickers()) {
    if (t.byte_hash && t.pixel_hash) continue
    if (!existsSync(t.orig_path)) continue
    const buf = readFileSync(t.orig_path)
    store.setStickerHashes(t.id, sha256(buf), await pixelHash(buf).catch(() => null))
  }
  // Verweigerte Beschreibungen aus der Zeit vor der Sperre nachziehen.
  for (const t of store.stickers()) {
    if (!t.blocked && t.description && isRefusal(t.description)) { store.blockSticker(t.id, BLOCKED_DESCRIPTION); log(`S${t.id} gesperrt, Beschreibung war verweigert`) }
  }
  // Gleiche zusammenfuehren: der aelteste bleibt.
  let merged = 0
  const keep = new Map()
  for (const t of store.stickers()) {
    const first = (t.byte_hash && keep.get('b' + t.byte_hash)) || (t.pixel_hash && keep.get('p' + t.pixel_hash))
    if (!first) {
      if (t.byte_hash) keep.set('b' + t.byte_hash, t)
      if (t.pixel_hash) keep.set('p' + t.pixel_hash, t)
      continue
    }
    store.mergeSticker(t.id, first.id)
    merged++
  }
  // Kopien auf der Platte.
  const inUse = new Set(store.stickers().flatMap((t) => [t.orig_path, t.view_path]))
  let removed = 0
  for (const m of store.stickerMessages()) {
    const id = Number((/^S(\d+)/.exec(m.text || '') || [])[1])
    const t = id && store.sticker(id)
    if (!t || !existsSync(t.view_path)) continue
    const own = [join(store.mediaDir, `${m.nr}.orig.webp`), join(store.mediaDir, `${m.nr}.png`)]
    if (m.media_path !== t.view_path) store.setMedia(m.nr, t.view_path, 'image/png')
    for (const f of own) if (!inUse.has(f) && existsSync(f)) { rmSync(f); removed++ }
  }
  if (merged || removed) log(`Sticker entdoppelt: ${merged} zusammengefuehrt, ${removed} Kopien geloescht, ${store.stickers().length} in der Sammlung`)
}

async function backfillStickers() {
  let n = 0
  for (const m of store.stickerMessages()) {
    if (/^S\d+/.test(m.text || '')) continue
    const orig = join(store.mediaDir, `${m.nr}.orig.webp`)
    if (!existsSync(orig)) continue
    const buf = readFileSync(orig)
    const k = await knownSticker(buf, null)
    const opts = { fromMe: Boolean(m.from_me), ts: m.ts }
    if (k.known) linkSticker(m.nr, k.known, (m.text || '').includes('animiert'), opts)
    else collectSticker(m.nr, k, (m.text || '').includes('animiert'), opts)
    n++
  }
  await dedupeStickers()
  if (n) log(`${n} Sticker in die Sammlung uebernommen, ${store.stickers().length} insgesamt`)
  // Einmalig: Beliebtheit aus dem vorhandenen Verlauf nachzaehlen.
  if (!store.get('sticker_seen_v1')) {
    store.db.exec('UPDATE stickers SET seen = 0, last_seen = NULL')
    for (const m of store.stickerMessages()) {
      const id = Number((/^S(\d+)/.exec(m.text || '') || [])[1])
      if (id && !m.from_me) store.seeSticker(id, m.ts)
    }
    store.set('sticker_seen_v1', '1')
  }
  // Einmalig: animierte Sticker zeigten nur ihr erstes Bild. Jetzt die ganze
  // Bildfolge, und neu beschreiben, damit der Ablauf drinsteht.
  if (!store.get('sticker_anim_v1')) {
    let redone = 0
    for (const t of store.stickers()) {
      if (!existsSync(t.orig_path)) continue
      const r = await stickerView(readFileSync(t.orig_path), t.view_path).catch((err) => { log(`S${t.id} Bildfolge nicht erstellt:`, err.message); return null })
      if (r?.frames > 1) {
        if (!t.animated) store.db.prepare('UPDATE stickers SET animated = 1 WHERE id = ?').run(t.id)
        if (!t.blocked) store.describeSticker(t.id, null)
        redone++
      }
    }
    store.set('sticker_anim_v1', '1')
    if (redone) log(`${redone} animierte Sticker: Bildfolge erstellt, werden neu beschrieben`)
  }
  // Einmalig: die animierten noch einmal mit dem staerkeren Modell.
  if (!store.get('sticker_anim_v2')) {
    for (const t of store.stickers()) if (t.animated && !t.blocked) store.describeSticker(t.id, null)
    store.set('sticker_anim_v2', '1')
  }
  for (const t of store.stickers()) if (!t.description) queueDescription(t.id)
}

// Jeder Versand geht hier durch. Ziel ausserhalb der Freigabe: nicht
// senden, melden. Das darf nie passieren, also ist es ein Alarm.
async function send(jid, content, opts, { notice = false } = {}) {
  if (!isAllowedRecipient(jid, { groups: config.groups, ownerNumber: config.owner.number, dmNumbers: config.dmNumbers })) {
    log(`VERSAND BLOCKIERT an ${jid}`)
    await notifyOnce(`blocked:${jid}`, HOUR, 'Kai: Versand blockiert', `Kai wollte an ${jid} senden, das ist kein freigegebener Chat. Nichts wurde gesendet.`)
    throw new Error('Ziel nicht freigegeben')
  }
  // Gesperrte Sticker gehen nie raus, egal auf welchem Weg.
  if (content?.sticker?.url && store.isBlockedStickerFile(content.sticker.url)) {
    log(`VERSAND BLOCKIERT an ${jid}: gesperrter Sticker`)
    throw new Error('Dieser Sticker ist gesperrt')
  }
  // Kein Schluessel verlaesst den Server, egal wie er in Text, Bildunterschrift
  // oder Datei geraten ist. ZIPs werden schon beim Packen geprueft.
  const leak = findSecret([content?.text, content?.caption, content?.fileName, content?.mimetype === 'application/zip' ? null : content?.document])
  if (leak) {
    log(`VERSAND BLOCKIERT an ${jid}: enthielt ${leak}`)
    await notifyOnce(`leak:${jid}`, HOUR, 'Kai: Versand blockiert, Schluessel im Inhalt',
      `Kai wollte etwas senden, das ${leak} enthielt. Nichts wurde gesendet. Log pruefen und den Schluessel vorsorglich erneuern.`, { priority: 'urgent' })
    throw new Error('Inhalt enthaelt einen Zugangsschluessel, nicht gesendet')
  }
  // Tageslimit. Nur Hinweise der Bruecke selbst (Limit-Meldung, !kai-Befehle)
  // duerfen noch raus.
  if (!notice && limitReached()) {
    await reportLimit()
    throw new Error(`Tageslimit von ${config.maxMessagesPerDay} Nachrichten erreicht`)
  }
  const sent = await sock.sendMessage(jid, content, opts)
  store.set(`sent:${Logs.today()}`, sentToday() + 1)
  return sent
}

// ---------------------------------------------------------------- Tageslimit

const sentToday = () => Number(store.get(`sent:${Logs.today()}`) || 0)
const limitReached = () => sentToday() >= config.maxMessagesPerDay

async function reportLimit() {
  await notifyOnce(`daylimit:${Logs.today()}`, DAY, 'Kai: Tageslimit erreicht',
    `${sentToday()} von ${config.maxMessagesPerDay} Nachrichten heute verschickt. Kai antwortet bis Mitternacht nur noch mit dem Limit-Hinweis.`)
}

// Statt der KI: ein fester Hinweis, hoechstens einmal pro Stunde und Chat.
async function limitNotice(jid) {
  const key = `limitnote:${jid}`
  if (Date.now() - Number(store.get(key) || 0) < HOUR) return
  store.set(key, Date.now())
  log(`${jid}: Tageslimit erreicht, Hinweis statt Antwort`)
  await reportLimit()
  await send(jid, { text: `Tageslimit von ${config.maxMessagesPerDay} Nachrichten für heute erreicht. Ab Mitternacht bin ich wieder da.` }, undefined, { notice: true })
    .catch((err) => log('Limit-Hinweis nicht gesendet:', err.message))
}

// Legt eine Nachricht im Verlauf ab und weckt Kai, wenn er gemeint ist.
// Liefert die Verlaufsnummer, oder null wenn nichts abgelegt wurde.
async function handle(msg, { live }) {
  // Die Tuer: alles, was nicht aus einer freigegebenen Gruppe oder aus dem
  // Direktchat mit dem Besitzer kommt, endet hier. Nichts davon wird
  // gespeichert, geladen oder an Claude gegeben.
  const jid = await resolveChat(msg.key, { groups: config.groups, ownerNumber: config.owner.number, dmNumbers: config.dmNumbers, toPhone })
  if (!jid) return null
  const direct = isDirectChat(jid)
  const d = describe(msg)
  if (!d) return null

  const fromMe = Boolean(msg.key.fromMe)
  // Im Direktchat hat die Tuer die Nummer schon geprueft. In Gruppen zaehlt
  // allein die Absendernummer, nie der Name.
  const phone = fromMe ? '' : direct ? config.owner.number : await senderPhone(msg.key)
  const isOwner = Boolean(config.owner.number) && phone === config.owner.number
  const nr = store.addMessage({
    groupJid: jid, waId: msg.key.id, key: msg.key,
    senderJid: fromMe ? [...botJids][0] : direct ? jid : (msg.key.participantAlt || msg.key.participant),
    senderName: isOwner ? config.owner.name : (msg.pushName || null),
    isOwner, fromMe,
    ts: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
    kind: d.kind, text: d.text, quotedWaId: d.quotedWaId,
  })
  if (!nr) return null
  recent.set(msg.key.id, msg)
  if (recent.size > 2000) recent.delete(recent.keys().next().value)

  if (d.poll) store.setPoll(nr, d.poll)
  if (d.kind === 'vote' && d.vote && d.pollId) recordIncomingVote(jid, msg, d)
  if (d.media === 'audio') {
    const said = await track(jid, transcribeVoice(msg, nr, d).catch((err) => { log(`Sprachnachricht #${nr} nicht transkribiert:`, err.message); return '' }))
    // Damit "Kai" auch gesprochen zaehlt und !kai-Befehle nicht versehentlich greifen
    if (said) d.text = said
  } else if (d.media) {
    await track(jid, saveMedia(msg, nr, d.media, { ...d, live }).catch((err) => log(`Anhang von #${nr} nicht geladen:`, err.message)))
  }

  if (!live || fromMe) return nr
  if (isOwner && d.kind === 'text' && /^!kai\b/i.test(d.text || '')) { await ownerCommand(jid, d.text, msg); return nr }
  if (store.group(jid).paused) return nr
  if (direct || isAddressed({ text: d.text, mentionedJids: d.mentionedJids, quotedParticipant: d.quotedParticipant, botJids, names: config.names })) {
    // Reihenfolge: Tuer (oben), dann Tageslimit, erst dann die KI.
    if (limitReached()) { await limitNotice(jid); return nr }
    cancelProactive(jid)
    schedule(jid, { nr })
  } else if (!direct && !limitReached()) {
    // Nicht angesprochen: vielleicht trotzdem mitreden. Erst wenn Ruhe ist.
    queueProactive(jid)
  }
  return nr
}

// Anhaenge, die gerade noch geladen oder zerlegt werden. Kommt waehrenddessen
// eine Ansprache, wartet Kai, bis sie fertig sind (hoechstens fuenf Minuten),
// statt ein halbes Video zu sehen.
const pendingMedia = new Map()
function track(jid, p) {
  if (!pendingMedia.has(jid)) pendingMedia.set(jid, new Set())
  const set = pendingMedia.get(jid)
  set.add(p)
  p.finally(() => set.delete(p)).catch(() => {})
  return p
}
async function mediaSettled(jid) {
  const set = pendingMedia.get(jid)
  if (!set?.size) return
  let timer
  await Promise.race([Promise.allSettled([...set]), new Promise((r) => { timer = setTimeout(r, 5 * 60_000) })])
  clearTimeout(timer)
}

// Transkription mit Stoermeldung, wenn OpenAI den Zugang verweigert.
async function transcribeOrNotify(buf, opts) {
  try {
    return await transcribe(buf, opts)
  } catch (err) {
    if (err.status === 401 || err.status === 403 || err.status === 429) {
      await notifyOnce('openai', 6 * HOUR, 'Kai: Sprachnachrichten gehen nicht',
        `OpenAI lehnt die Transkription ab (HTTP ${err.status}). Schluessel oder Guthaben pruefen, OPENAI_API_KEY in der .env.`)
    }
    throw err
  }
}

// Eine fremde Stimme entschluesseln und festhalten. WhatsApp schickt bei jeder
// Aenderung die komplette Auswahl, also ersetzt die neue Stimme die alte. Die
// Adressierung (Telefon-JID oder LID) probieren wir durch, bis es aufgeht.
function recordIncomingVote(jid, msg, d) {
  const poll = store.pollByWaId(jid, d.pollId)
  if (!poll?.poll_json) return
  let secret
  try { secret = Buffer.from(JSON.parse(poll.poll_json).secret, 'base64') } catch { return }
  const pollKey = JSON.parse(poll.key_json)
  const voteKey = msg.key
  const creators = keyJids(pollKey)
  const voters = voteKey.fromMe ? [normJid(sock.user.lid), normJid(sock.user.id)] : keyJids(voteKey)
  for (const pollCreatorJid of creators) for (const voterJid of voters) {
    try {
      const hashes = decryptPollVote(d.vote, { pollEncKey: secret, pollMsgId: d.pollId, pollCreatorJid, voterJid })
      const who = (voteKey.participantAlt || voteKey.participant || voterJid).split('@')[0].split(':')[0]
      store.recordVote(poll.nr, who, msg.pushName || null, hashes, Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000))
      const cf = pollCreatorJid.endsWith('@lid') ? 'LID' : 'TEL'
      const vf = voterJid.endsWith('@lid') ? 'LID' : 'TEL'
      log(`Umfrage #${poll.nr}: Stimme von ${msg.pushName || who} gelesen (Ersteller ${cf}, Waehler ${vf}${voteKey.fromMe ? ', eigene' : ''})`)
      return
    } catch { /* naechste Variante */ }
  }
  log(`Stimme bei Umfrage #${poll.nr} nicht entschluesselt`)
}

// Sprachnachricht laden, ablegen und transkribieren. Das Transkript steht
// danach im Verlauf in der zweiten Zeile des Texts.
async function transcribeVoice(msg, nr, d) {
  if (!transcriptionEnabled()) return ''
  const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  const ext = d.mime.includes('ogg') ? 'ogg' : d.mime.includes('mp4') || d.mime.includes('m4a') ? 'm4a' : d.mime.includes('mpeg') ? 'mp3' : 'ogg'
  const path = join(store.mediaDir, `${nr}.${ext}`)
  writeFileSync(path, buf)
  // Die Datei liegt schon auf Platte - sie auch in der DB verknuepfen, damit Kai
  // sie per Nummer lesen kann (code_ausfuehren, audio_transkript, medien).
  store.setMedia(nr, path, d.mime.split(';')[0] || 'audio/ogg')
  const said = await transcribeOrNotify(buf, { mime: d.mime.split(';')[0], filename: `${nr}.${ext}` })
  store.setText(nr, `${d.text || ''}\n${said}`)
  return said
}

// Video laden und fuer Claude zerlegen: Standbilder als Raster (media_path)
// und die Tonspur als Transkript (video_json). Das Video selbst wird danach
// geloescht, es ist nur Rohstoff. Klappt etwas nicht, bleibt das
// Vorschaubild, wie vorher.
async function saveVideo(msg, nr, d, base) {
  const limit = config.videoMaxMb * 1024 * 1024
  // Aus dem nachgeladenen Verlauf beim Koppeln keine Videos ziehen: das
  // koennten Hunderte sein, und jedes kostet Transkription.
  if (d.live && !(d.bytes > limit)) {
    const file = `${base}.video`
    const ogg = `${base}.ton.ogg`
    try {
      const stream = await downloadMediaMessage(msg, 'stream', {}, { logger, reuploadRequest: sock.updateMediaMessage })
      let n = 0
      await pipeline(stream, async function* (src) {
        for await (const chunk of src) {
          n += chunk.length
          if (n > limit) throw new Error(`groesser als ${config.videoMaxMb} MB`)
          yield chunk
        }
      }, createWriteStream(file))
      const info = await probe(file)
      const v = { frames: [], sound: 'stumm' }
      if (info.hasVideo) {
        v.frames = (await contactSheet(file, `${base}.jpg`, info.duration)).map(clock)
      }
      if (d.gif) v.sound = 'stumm'
      else if (info.hasAudio && !transcriptionEnabled()) v.sound = 'fehlt'
      else if (info.hasAudio) {
        try {
          await extractAudio(file, ogg)
          const said = await transcribeOrNotify(readFileSync(ogg), { mime: 'audio/ogg', filename: `${nr}.ogg`, timeoutMs: 300_000 })
          v.sound = said ? 'text' : 'leer'
          if (said) v.transcript = said
          if (info.duration > MAX_AUDIO_SECONDS) v.cut = true
        } catch (err) {
          log(`Ton von Video #${nr} nicht transkribiert:`, err.message)
          v.sound = 'fehlt'
        }
      }
      store.setVideo(nr, v)
      if (v.frames.length) store.setMedia(nr, `${base}.jpg`, 'image/jpeg')
      log(`Video #${nr}: ${Math.round(info.duration)} s, ${v.frames.length} Standbilder, Ton ${v.sound}`)
      if (v.frames.length) return
    } catch (err) {
      log(`Video #${nr} nicht zerlegt, nehme das Vorschaubild:`, err.message)
    } finally {
      rmSync(file, { force: true })
      rmSync(ogg, { force: true })
    }
  }
  if (d.thumbnail) {
    const content = normalizeMessageContent(msg.message)
    writeFileSync(`${base}.jpg`, Buffer.from(content[getContentType(content)].jpegThumbnail))
    store.setMedia(nr, `${base}.jpg`, 'image/jpeg')
  }
}

async function saveMedia(msg, nr, kind, d = {}) {
  const base = join(store.mediaDir, String(nr))
  if (kind === 'video') return saveVideo(msg, nr, d, base)
  if (kind === 'thumbnail') {
    const content = normalizeMessageContent(msg.message)
    const thumb = content[getContentType(content)].jpegThumbnail
    writeFileSync(`${base}.jpg`, Buffer.from(thumb))
    return store.setMedia(nr, `${base}.jpg`, 'image/jpeg')
  }
  const buf = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage })
  if (kind === 'pdf') {
    if (buf.length > 8 * 1024 * 1024) return
    writeFileSync(`${base}.pdf`, buf)
    return store.setMedia(nr, `${base}.pdf`, 'application/pdf')
  }
  if (kind === 'document') {
    if (buf.length > config.fileMaxMb * 1024 * 1024) { log(`Dokument #${nr} zu groß (${Math.round(buf.length/1024/1024)} MB), nicht gespeichert`); return }
    const safe = (d.fileName || 'datei').replace(/[^\w.\- ]+/g, '_').slice(-60) || 'datei'
    writeFileSync(`${base}__${safe}`, buf)
    return store.setMedia(nr, `${base}__${safe}`, d.mime || 'application/octet-stream')
  }
  if (kind === 'sticker') {
    const opts = { fromMe: Boolean(msg.key.fromMe), ts: Number(msg.messageTimestamp) || undefined }
    const k = await knownSticker(buf, d.hash)
    if (k.known) {
      // Schon in der Sammlung: keine zweite Kopie ablegen.
      store.setMedia(nr, k.known.view_path, 'image/png')
      linkSticker(nr, k.known, d.animated, opts)
      return
    }
    // Das Original zum Zurueckschicken, ein PNG fuer Claude: das Bild, oder
    // bei animierten die Bildfolge ueber die ganze Animation.
    writeFileSync(`${base}.orig.webp`, buf)
    await stickerView(buf, `${base}.png`)
    store.setMedia(nr, `${base}.png`, 'image/png')
    collectSticker(nr, { hash: d.hash, byteHash: k.byteHash, pixelHash: k.pixelHash }, d.animated, opts)
    return
  }
  // Bilder auf die Groesse bringen, die Claude ohnehin verwendet.
  await sharp(buf).rotate().resize(1568, 1568, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(`${base}.jpg`)
  store.setMedia(nr, `${base}.jpg`, 'image/jpeg')
}

// ---------------------------------------------------------------- Mitreden

// Kai liest alles und entscheidet selbst, ob er ungefragt etwas sagt.
//   1. Neue Nachricht, Kai nicht angesprochen: Zeitgeber starten. Jede
//      weitere Nachricht startet ihn neu.
//   2. Ist so lange Ruhe, bekommt Kai die Runde zu sehen, mit dem Hinweis,
//      dass ihn niemand angesprochen hat. Wie lange, haengt vom Chat ab:
//      3 s im Gespraech mit ihm, 4 s wenn nach langer Stille etwas Neues
//      kommt, 15 s wenn gerade mehrere schnell hin und her schreiben,
//      sonst 8 s (alles in config.proactive).
//   3. Er schreibt etwas oder schweigt, meistens schweigt er.
// Das Tageslimit prueft vorher der Code.
const proactiveTimers = new Map()

function proactiveOn(jid) {
  const v = store.get(`proactive:${jid}`)
  return v ? v === 'an' : config.proactive.enabled
}

function cancelProactive(jid) {
  clearTimeout(proactiveTimers.get(jid))
  proactiveTimers.delete(jid)
}

function queueProactive(jid) {
  if (!proactiveOn(jid) || store.group(jid).paused) return
  cancelProactive(jid)
  // Im Gespraech (Kai hat eben noch geschrieben): Folgefragen sofort
  // aufgreifen, nur kurz warten, damit ein schneller Nachsatz mitkommt.
  // Sonst abwarten, bis Ruhe ist, um nicht in fremde Gespraeche zu platzen.
  const rows = store.since(jid, 0, 12)
  const p = config.proactive
  const mode = inConversation(rows, { minutes: p.followupMinutes })
    ? 'followup'
    : lurkMode(rows, { freshMinutes: p.freshMinutes }).mode
  const delay = { followup: p.followupSeconds, fresh: p.freshSeconds, busy: p.busySeconds, normal: p.quietSeconds }[mode] * 1000
  proactiveTimers.set(jid, setTimeout(() => {
    proactiveTimers.delete(jid)
    proactiveCheck(jid, mode).catch((err) => log(`${jid}: Mitlesen fehlgeschlagen:`, err.message))
  }, delay))
}

// Kommt nach laengerer Stille etwas Neues, sagt Kai das dazu: dann antwortet
// oft niemand sofort, und ein kurzer, guter Beitrag ist eher willkommen.
function freshNote(jid) {
  const { idleBefore } = lurkMode(store.since(jid, 0, 12), { freshMinutes: config.proactive.freshMinutes })
  const h = idleBefore == null ? null : idleBefore / 3600
  const how = h == null ? 'eine Weile' : h >= 24 ? `${Math.round(h / 24)} Tag${Math.round(h / 24) === 1 ? '' : 'e'}` : h >= 1 ? `${Math.round(h)} Stunde${Math.round(h) === 1 ? '' : 'n'}` : `${Math.round(idleBefore / 60)} Minuten`
  return `\nDer Chat war vorher ${how} still, jetzt kommt etwas Neues. Nach so einer Pause antwortet oft niemand sofort. Kannst du etwas wirklich Gutes beitragen, eine Antwort, eine Info oder einen Witz, der sitzt, dann tu es jetzt, kurz. Die Messlatte unten gilt trotzdem.`
}

async function proactiveCheck(jid, mode = 'normal') {
  if (limitReached()) return
  const latest = store.latestNr(jid)
  if (latest <= store.group(jid).last_nr) return // nichts Neues seit Kais letztem Blick
  const newest = store.byNr(jid, latest)
  if (!newest || newest.from_me) return
  schedule(jid, { nr: latest, proactive: mode === 'followup' ? 'followup' : mode === 'fresh' ? 'fresh' : 'lurk' })
}

// ---------------------------------------------------------------- Kai denkt

function stateOf(jid) {
  if (!groupState.has(jid)) groupState.set(jid, { running: false, triggerNr: 0, tasks: [], runs: [], failures: 0 })
  return groupState.get(jid)
}

// Ein Auftrag ist entweder eine Ansprache (Verlaufsnummer) oder eine faellige
// geplante Aufgabe. Waehrend Kai antwortet, laufen weitere Ansprachen auf und
// werden danach in einem Durchgang beantwortet, nicht einzeln.
function schedule(jid, job) {
  const st = stateOf(jid)
  if (job.subagent) st.subagentWake = true
  else if (job.task) st.tasks.push(job.task)
  else {
    // Eine echte Ansprache hebt den "nicht angesprochen"-Hinweis auf.
    st.proactive = job.proactive && (!st.triggerNr || st.proactive) ? job.proactive : false
    st.triggerNr = job.nr
  }
  if (st.running) return
  st.running = true
  ;(async () => {
    try {
      while (st.triggerNr || st.tasks.length || st.subagentWake) {
        let next
        if (st.tasks.length) next = { task: st.tasks.shift() }
        else if (st.triggerNr) { next = { nr: st.triggerNr, proactive: st.proactive }; st.triggerNr = 0; st.proactive = false }
        else { next = { subagent: true }; st.subagentWake = false }
        await turn(jid, next)
      }
    } finally { st.running = false }
  })()
}

async function turn(jid, job) {
  const st = stateOf(jid)
  const label = job.task ? `Aufgabe ${job.task.id}` : job.subagent ? 'Hintergrund-Auftrag' : `#${job.nr}`
  st.runs = st.runs.filter((t) => Date.now() - t < HOUR)
  // Das Stundenlimit zaehlt nur echte Ansprachen. Mitlesen (proactive) und das
  // Melden von Hintergrund-Auftraegen sollen Antworten nicht blockieren.
  if (!job.task && !job.proactive && !job.subagent && st.runs.length >= config.maxRunsPerHour) {
    log(`${jid}: Stundenlimit von ${config.maxRunsPerHour} Antworten erreicht, ${label} bleibt unbeantwortet`)
    await notifyOnce(`limit:${jid}`, HOUR, 'Kai: Stundenlimit erreicht',
      `${config.maxRunsPerHour} Antworten in einer Stunde in "${store.group(jid).subject}", Kai pausiert bis die Stunde um ist.`)
    return
  }
  if (limitReached()) { if (!job.proactive) await limitNotice(jid); return }
  if (!job.proactive) st.runs.push(Date.now())

  // Schreibsymbol durchlaufen lassen: WhatsApp blendet "tippt..." nach ~10 s
  // aus, also alle 8 s auffrischen, solange der (evtl. mehrstufige) Durchgang
  // laeuft. Wird im finally wieder abgestellt.
  sock.sendPresenceUpdate('composing', jid).catch(() => {})
  const typing = setInterval(() => sock.sendPresenceUpdate('composing', jid).catch(() => {}), 8000)
  try {
    await mediaSettled(jid)
    let result
    try {
      result = await think(jid, job, store.group(jid).session_id)
    } catch (err) {
      if (!store.group(jid).session_id) throw err
      // Session kaputt oder weg: frisch beginnen, mit Logs und Verlauf als Vorlauf.
      log(`${jid}: Session laesst sich nicht fortsetzen (${err.message}), beginne neu`)
      result = await think(jid, job, null)
    }
    st.failures = 0
    await deliver(jid, job, result)
  } catch (err) {
    st.failures++
    log(`${jid}: Fehler bei ${label}:`, err.message)
    if (/auth|401|403|oauth|token|log.?in|credit|limit/i.test(err.message)) {
      await notifyOnce('claude-auth', 6 * HOUR, 'Kai erreicht Claude nicht',
        `Anmeldung oder Kontingent: ${err.message.slice(0, 200)}. Setup-Token pruefen, siehe kai/README.md.`)
    } else if (st.failures >= 3) {
      await notifyOnce(`fail:${jid}`, 6 * HOUR, 'Kai antwortet nicht',
        `${st.failures} Fehlschlaege in Folge in "${store.group(jid).subject}": ${err.message.slice(0, 200)}`)
    }
    if (job.task) await notify('Kai: geplante Aufgabe gescheitert', `Aufgabe ${job.task.id} ("${job.task.instruction.slice(0, 80)}") in "${store.group(jid).subject}": ${err.message.slice(0, 150)}`)
  } finally {
    clearInterval(typing)
    sock.sendPresenceUpdate('paused', jid).catch(() => {})
  }
}

function nowLine() {
  const d = new Date()
  return `Jetzt ist ${d.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}, ${d.toTimeString().slice(0, 5)} Uhr (Europe/Berlin).`
}

// ---------------------------------------------------------------- Hintergrund-Auftraege
// Ein Sub-Agent laeuft nebenlaeufig, damit Kai im Chat ansprechbar bleibt. Er
// sendet selbst nichts in WhatsApp: Ergebnis und Rueckfragen gehen ueber Kai,
// der sie durch die uebliche Tuer (send) schickt. Schwere Rechenarbeit laeuft
// weiter in der Sandbox. Nur im Speicher; ein Neustart von Kai verwirft laufende
// Auftraege (die Sandbox-Jobs selbst ueberleben, aber der Orchestrator nicht).
const subJobs = new Map() // id -> job

function wakeSub(jid) { schedule(jid, { subagent: true }) }

function pruneSubJobs() {
  const now = Date.now()
  for (const [id, j] of subJobs) {
    const terminal = j.status === 'fertig' || j.status === 'fehler' || j.status === 'abgebrochen'
    if (terminal && !j.pendingEvent && now - j.updatedAt > 2 * HOUR) subJobs.delete(id)
  }
}

function subRunningCount(jid) {
  let n = 0
  for (const j of subJobs.values()) if (j.jid === jid && (j.status === 'läuft' || j.status === 'frage')) n++
  return n
}

function finishSub(job, status, text) {
  if (job.timer) { clearTimeout(job.timer); job.timer = null }
  job.status = status
  if (text) job.result = text
  job.updatedAt = Date.now()
  // Abbruch hat Kai selbst ausgeloest, der weiss davon. Fertig/Fehler weckt ihn.
  if (status === 'fertig' || status === 'fehler') { job.pendingEvent = status; wakeSub(job.jid) }
}

function startSubagent(jid, instruktion) {
  pruneSubJobs()
  if (subRunningCount(jid) >= config.subagentMax) {
    return { error: `Es laufen schon ${config.subagentMax} Hintergrund-Aufträge in diesem Chat. Warte, bis einer fertig ist, oder brich einen mit auftrag_abbrechen ab.` }
  }
  const id = `auf_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
  const abort = new AbortController()
  const t = tools(jid, { jid: null, name: 'Auftrag', isOwner: false })
  const job = { id, jid, instruktion, status: 'läuft', frage: null, result: null, deliverables: [], abort, cancelled: false, answerResolve: null, answerReject: null, pendingEvent: null, createdAt: Date.now(), updatedAt: Date.now(), timer: null }

  const sa = {
    frage: (frage) => new Promise((resolve, reject) => {
      job.frage = String(frage)
      job.status = 'frage'
      job.pendingEvent = 'frage'
      job.updatedAt = Date.now()
      job.answerResolve = (txt) => { job.answerResolve = null; job.answerReject = null; job.frage = null; job.status = 'läuft'; job.updatedAt = Date.now(); resolve(txt) }
      job.answerReject = (err) => { job.answerResolve = null; job.answerReject = null; reject(err) }
      wakeSub(jid)
    }),
    runCode: async (a) => { const r = await runSandbox(a); return { ok: r.ok, jobId: r.id, stdout: (r.stdout || '').slice(-2000), stderr: (r.stderr || '').slice(-800), dateien: r.dateien } },
    verlaufSuchen: ({ suchbegriff }) => t.searchHistory({ suchbegriff }),
    verlaufLesen: ({ ab_nr, anzahl }) => t.readHistory({ nr: ab_nr, davor: 0, danach: anzahl || 30 }),
    gedaechtnisLesen: ({ datei }) => memory.read(jid, datei) ?? `${datei} gibt es nicht.`,
    anhaengen: ({ jobId, pfad, als, beschriftung }) => { job.deliverables.push({ jobId: String(jobId), pfad: String(pfad), als: als || 'datei', beschriftung: beschriftung || null }); return `Angehängt: ${pfad}` },
  }

  job.timer = setTimeout(() => { job.timedOut = true; try { abort.abort() } catch { /* egal */ } if (job.answerReject) job.answerReject(new Error('Zeitüberschreitung')) }, config.subagentTimeoutMin * 60_000)
  subJobs.set(id, job)
  const model = store.get(`model:${jid}`) || config.model
  runSubagent({ instruktion, groupSubject: store.group(jid).subject, model, sa, abortController: abort })
    .then((res) => finishSub(job, 'fertig', res.text))
    .catch((err) => finishSub(job, job.cancelled ? 'abgebrochen' : 'fehler', job.cancelled ? null : (job.timedOut ? 'Zeitüberschreitung' : err.message)))
  log(`${jid}: Hintergrund-Auftrag ${id} gestartet`)
  return { id }
}

function cancelSubagent(id) {
  const job = subJobs.get(id)
  if (!job) return `Auftrag ${id} gibt es nicht.`
  if (job.status !== 'läuft' && job.status !== 'frage') return `Auftrag ${id} läuft nicht mehr (${job.status}).`
  job.cancelled = true
  if (job.answerReject) job.answerReject(new Error('abgebrochen'))
  try { job.abort.abort() } catch { /* egal */ }
  job.status = 'abgebrochen'
  job.updatedAt = Date.now()
  return `Auftrag ${id} abgebrochen.`
}

function answerSubagent(id, antwort) {
  const job = subJobs.get(id)
  if (!job) return `Auftrag ${id} gibt es nicht.`
  if (job.status !== 'frage' || !job.answerResolve) return `Auftrag ${id} wartet gerade nicht auf eine Antwort.`
  job.answerResolve(String(antwort))
  return `Antwort an Auftrag ${id} weitergegeben, er arbeitet weiter.`
}

function subStatusText(jid) {
  const mine = [...subJobs.values()].filter((j) => j.jid === jid).sort((a, b) => a.createdAt - b.createdAt)
  if (!mine.length) return 'Keine Hintergrund-Aufträge in diesem Chat.'
  return mine.map((j) => `${j.id}: ${j.status}${j.status === 'frage' ? ` (Frage: ${j.frage})` : ''} — ${j.instruktion.slice(0, 80)}`).join('\n')
}

// Fuer think(): offene Ereignisse (fertig/frage/fehler) einmalig melden, dazu
// den Stand laufender Auftraege als Kontext. Verbraucht die pendingEvents.
function subagentNote(jid) {
  const mine = [...subJobs.values()].filter((j) => j.jid === jid)
  if (!mine.length) return ''
  const lines = []
  for (const j of mine) {
    if (j.pendingEvent === 'fertig') { lines.push(`Auftrag ${j.id} ist FERTIG. Ergebnis: ${j.result || '(ohne Text)'}.${j.deliverables.length ? ` Dateien zum Verschicken: ${j.deliverables.map((d) => `[job=${d.jobId} pfad=${d.pfad} als=${d.als}]`).join(' ')} — schick jede mit datei_aus_sandbox (job und pfad genau so).` : ''} Gib dem Chat das Ergebnis kurz und natürlich weiter.`); j.pendingEvent = null }
    else if (j.pendingEvent === 'fehler') { lines.push(`Auftrag ${j.id} ist FEHLGESCHLAGEN: ${j.result || 'unbekannt'}. Sag es dem Chat knapp und biete an, es neu zu versuchen.`); j.pendingEvent = null }
    else if (j.pendingEvent === 'frage') { lines.push(`Auftrag ${j.id} hat eine RÜCKFRAGE: „${j.frage}“. Gib sie im Chat natürlich weiter. Kommt die Antwort, reich sie mit auftrag_antwort(id="${j.id}", antwort=...) zurück.`); j.pendingEvent = null }
    else if (j.status === 'läuft') lines.push(`Auftrag ${j.id} läuft noch (${j.instruktion.slice(0, 60)}).`)
    else if (j.status === 'frage') lines.push(`Auftrag ${j.id} wartet auf deine Antwort (auftrag_antwort) zu: „${j.frage}“.`)
  }
  return lines.length ? `\n(Hintergrund-Aufträge:\n${lines.join('\n')})` : ''
}

async function think(jid, job, sessionId) {
  const g = store.group(jid)
  const fresh = !sessionId
  const afterNr = fresh ? 0 : g.last_nr
  const limit = fresh ? config.historyOnNewSession : config.maxMessagesPerTurn
  const rows = store.since(jid, afterNr, limit)
  if (!rows.length && !job.task && !job.subagent) return null
  const skipped = store.countSince(jid, afterNr) - rows.length

  // Wer hat Kai diesmal gerufen? Bestimmt, was er anlegen und loeschen darf.
  const requester = job.task
    ? { jid: job.task.creator_jid, name: job.task.creator_name, isOwner: Boolean(job.task.creator_jid) && job.task.creator_jid === ownerJid() }
    : job.subagent
    ? { jid: null, name: 'Hintergrund-Auftrag', isOwner: false }
    : (() => { const r = store.byNr(jid, job.nr); return { jid: r?.sender_jid, name: r?.sender_name, isOwner: Boolean(r?.is_owner) } })()

  const content = [{ type: 'text', text: nowLine() + '\n\n' }]
  for (const n of NOTICES) {
    if (store.get(`notice:${jid}:${n.id}`)) continue
    content.push({ type: 'text', text: `(Hinweis vom System, einmalig: ${n.text})\n\n` })
    store.set(`notice:${jid}:${n.id}`, '1')
  }
  if (fresh) {
    const past = logs.latest(jid, 3)
    content.push({ type: 'text', text: past
      ? `Das sind deine Logs der letzten Tage, von dir selbst geschrieben:\n\n${past}\n\n`
      : 'Du hast für diese Gruppe noch keine Logs.\n\n' })
  }
  if (rows.length) {
    content.push({ type: 'text', text: fresh
      ? `Der bisherige Verlauf der Gruppe${skipped > 0 ? ` (die ${skipped} älteren Nachrichten davor sind nicht dabei)` : ''}:\n`
      : skipped > 0
        ? `Seit deiner letzten Antwort kamen ${skipped + rows.length} Nachrichten. Hier die letzten ${rows.length}, die ${skipped} davor liest du bei Bedarf mit verlauf_lesen (ab #${rows[0].nr} rückwärts):\n`
        : `Neu seit deiner letzten Antwort:\n` })
    content.push(...buildContent(rows, { ownerName: config.owner.name, nrOf: (waId) => store.nrOf(jid, waId), maxImages: config.maxImagesPerTurn }))
  }
  content.push({ type: 'text', text: job.subagent
    ? `\nEin Hintergrund-Auftrag meldet sich (siehe unten). Gib dem Chat weiter, was ansteht: ein Ergebnis liefern, eine Rückfrage stellen oder einen Fehler melden. Sonst nichts.`
    : job.task?.daily
    ? `\n${job.task.instruction}`
    : job.task
    ? `\nGeplante Aufgabe ${job.task.id}, angelegt von ${job.task.creator_name || 'unbekannt'}${job.task.repeat !== 'einmal' ? ` (wiederholt sich ${job.task.repeat})` : ''}. Führe sie jetzt aus:\n${job.task.instruction}`
    : job.proactive === 'followup'
      ? `\nDu bist gerade selbst in diesem Gespräch, deine letzte Nachricht ist erst ein paar Nachrichten her. Prüf, ob die neuen Nachrichten an dich gehen oder an deine Aussage anknüpfen, etwa eine Rückfrage, ein „echt?“ oder eine Folgefrage, auch ohne deinen Namen. Dann antworte ganz normal. Reden die anderen nur untereinander weiter, ${SILENCE}.`
      : job.proactive
      ? `${job.proactive === 'fresh' ? freshNote(jid) : ''}\nNiemand hat dich angesprochen, du liest nur mit. Entscheide selbst, ob du etwas sagst. Meistens nicht: ${SILENCE}. Schreib nur, wenn es wirklich natürlich wäre, zum Beispiel wenn jemand auf eine Frage oder Aussage von dir antwortet, eine Frage gestellt wird, zu der du etwas beitragen kannst (dann ganz kurz: ein Satz mit der knackigen Antwort, oder ein kurzes Angebot wie „soll ich dir da helfen?“, keine langen Erklärungen ungefragt), nach langer Stille ein Bild oder eine Neuigkeit kommt, auf die niemand reagiert, oder ein Moment einfach zu gut ist. Nicht, wenn Leute sich untereinander unterhalten, es privat oder ernst ist, schon jemand passend reagiert hat oder du zuletzt etwas gesagt hast, worauf keiner einging. Manchmal passt statt Worten auch einfach ein Sticker als Reaktion, allein, ohne Text. Erwähne nie, dass du „mitgelesen“ hast.
Die Messlatte, bevor du ungefragt etwas schreibst: Bringt deine Nachricht der Gruppe wirklich etwas? Also ein Witz, über den jemand lacht, eine Info, die jemand nicht hatte, oder ein Sticker, der den Moment trifft. Kein Füllkommentar: nicht nacherzählen, was gerade passiert ist, keine allgemeine Zustimmung, kein „Klassiker“, „haha stimmt“ oder „kenn ich“. Wenn dir nichts wirklich Gutes einfällt, ${SILENCE}. Ein lauer Satz ist schlechter als Schweigen.`
      : `\nAngesprochen wurdest du in #${job.nr}.` })
  const w = activeWatch(jid)
  if (w) {
    content.push({ type: 'text', text: `\n(Du wartest in diesem Chat auf eine Antwort auf deine Nachricht #${w.nr}. Hintergrund, vertraulich: ${w.auftrag}. Steht die Antwort in den neuen Nachrichten (oder findest du sie mit verlauf_suchen), fasse sie mit besitzer_informieren für ${config.owner.name} zusammen und beende das Warten mit warten_beenden. Das Warten endet von selbst am ${formatLocal(w.until)}.)` })
  }
  const saNote = subagentNote(jid)
  if (saNote) content.push({ type: 'text', text: saNote })

  const mem = {
    soul: memory.read(jid, 'Soul.md'), index: memory.read(jid, 'CLAUDE.md'),
    personen: memory.read(jid, 'Personen.md'), insider: memory.read(jid, 'Insider.md'), feedback: memory.read(jid, 'Feedback.md'),
  }
  // Was erst nach der Textantwort raus soll (Sticker), sammelt sich hier.
  const outbox = []
  const model = store.get(`model:${jid}`) || config.model
  const res = await runTurn({ content, sessionId, groupSubject: g.subject, memory: mem, wa: tools(jid, requester, outbox), model })
  res.outbox = outbox
  if (rows.length) store.updateGroup(jid, { session_id: res.sessionId, last_nr: rows.at(-1).nr })
  else store.updateGroup(jid, { session_id: res.sessionId })
  return res
}

const ownerJid = () => (config.owner.number ? `${config.owner.number}@s.whatsapp.net` : null)
const MAX_TASKS_PER_GROUP = 20
const MAX_TASKS_PER_PERSON = 3

// Was Kai in dieser Gruppe tun kann. Alles ist an die Gruppe gebunden: aus
// Gruppe A kommt er weder an den Verlauf noch an die Logs von Gruppe B.
const TEXT_FILE = /\.(md|markdown|txt|json|csv|tsv|js|mjs|cjs|ts|tsx|jsx|py|sh|html|htm|css|xml|yml|yaml|toml|ini|sql|svg|ics|vcf|log|env\.example)$/i
const FILE_MAX = 1024 * 1024
const ZIP_MAX_FILES = 100
const ZIP_MAX_BYTES = 20 * 1024 * 1024
function mimeFor(name) {
  const ext = name.toLowerCase().split('.').pop()
  return ({ md: 'text/markdown', markdown: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html', htm: 'text/html', css: 'text/css', xml: 'application/xml', svg: 'image/svg+xml', ics: 'text/calendar', vcf: 'text/vcard', js: 'text/javascript', mjs: 'text/javascript', yml: 'application/yaml', yaml: 'application/yaml', pdf: 'application/pdf', zip: 'application/zip', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })[ext] || 'application/octet-stream'
}

// Welcher Dateiname gehoert zu einer empfangenen Nachricht mit Anhang?
function receivedName(row) {
  const m = /__(.+)$/.exec(row.media_path || '')
  if (m) return m[1]
  const ext = (row.media_mime || '').split('/')[1]?.split(';')[0] || 'bin'
  return `#${row.nr}.${ext === 'jpeg' ? 'jpg' : ext}`
}
// Welcher letzte Sandbox-Auftrag gehoert zu welchem Chat (fuer Folgeaktionen).
const lastJob = new Map()

function tools(jid, requester, outbox = null) {
  return {
    row: (nr) => store.byNr(jid, nr),
    react: async (nr, emoji) => {
      const row = store.byNr(jid, nr)
      if (!row) return `#${nr} gibt es nicht.`
      await send(jid, { react: { text: emoji, key: JSON.parse(row.key_json) } })
      return `Reaktion ${emoji} auf #${nr} gesetzt.`
    },
    // Eine kurze Nachricht SOFORT in diesen Chat, mitten im Durchgang. Fuer eine
    // Eingangsbestaetigung bei laenglichen Aufgaben, damit niemand im Ungewissen
    // wartet. Die eigentliche Antwort/das Ergebnis kommt danach.
    zwischenmeldung: async ({ text }) => {
      const t = String(text || '').trim()
      if (!t) return 'Leer, nichts gesendet.'
      try { await send(jid, { text: t.slice(0, 1000) }) }
      catch (err) { return `Nicht gesendet: ${err.message}` }
      return 'Kurze Zwischenmeldung ist raus. Jetzt mach die eigentliche Arbeit und schick am Ende das Ergebnis.'
    },
    // Hintergrund-Auftrag starten/verwalten. Laeuft nebenlaeufig, Kai bleibt frei.
    auftragStarten: ({ instruktion }) => {
      const r = startSubagent(jid, instruktion)
      if (r.error) return r.error
      return `Hintergrund-Auftrag ${r.id} gestartet. Ich bleibe hier ansprechbar und melde mich, sobald er fertig ist oder etwas von dir braucht. Mit auftrag_status siehst du den Stand, mit auftrag_abbrechen stoppst du ihn (z. B. um ihn geändert neu zu starten).`
    },
    auftragStatus: () => subStatusText(jid),
    auftragAbbrechen: ({ id }) => cancelSubagent(String(id)),
    auftragAntwort: ({ id, antwort }) => answerSubagent(String(id), antwort),
    stickerList: ({ suchbegriff, anzahl = 30 } = {}) => {
      const every = store.stickers()
      let all = every.filter((t) => !t.blocked)
      if (!all.length) return 'Deine Sammlung ist noch leer.'
      const total = all.length
      const blocked = every.length - all.length
      if (suchbegriff) {
        const words = suchbegriff.toLowerCase().split(/\s+/).filter(Boolean)
        all = all.filter((t) => words.some((w) => (t.description || '').toLowerCase().includes(w)))
      }
      all.sort((a, b) => stickerScore(b) - stickerScore(a))
      const shown = all.slice(0, Math.min(anzahl, 100))
      const lines = shown.map((t) => `S${t.id}: ${t.description || '(Beschreibung folgt)'}${t.animated ? ' [animiert]' : ''} · Leute ${t.seen || 0}x, du ${t.uses || 0}x${t.rating ? ` · deine Wertung ${t.rating}/5` : ''}`)
      return `${total} Sticker insgesamt${blocked ? ` (dazu ${blocked} gesperrte, die du nie verschickst)` : ''}, ${suchbegriff ? `${all.length} passen zu "${suchbegriff}", ` : ''}beliebteste zuerst:\n${lines.join('\n')}`
    },
    // Jede Angabe ist eine Nummer aus der zentralen Sammlung (S30 = 30), egal
    // unter welchem Namen sie kommt. Nie eine Nachrichtennummer: das hatte zur
    // Folge, dass "nr: 30" die Nachricht #30 traf und einen anderen Sticker schickte.
    resolveSticker: ({ id, sticker, nr }) => {
      for (const v of [id, sticker, nr]) {
        const n = Number((/S?(\d+)/i.exec(String(v ?? '')) || [])[1])
        if (n && store.sticker(n)) return n
      }
      return null
    },
    stickerView: (id) => {
      const t = store.sticker(id)
      return t && existsSync(t.view_path) ? readFileSync(t.view_path).toString('base64') : null
    },
    stickerDescribe: (id, text, rating) => {
      if (!store.sticker(id)) return `S${id} gibt es nicht.`
      if (text) store.describeSticker(id, text.trim().slice(0, 300))
      if (rating) store.rateSticker(id, rating)
      return `S${id} aktualisiert.`
    },
    sendSticker: async (id) => {
      const t = store.sticker(id)
      if (!t || !existsSync(t.orig_path)) return `S${id} gibt es nicht in deiner Sammlung.`
      if (t.blocked) return `S${id} ist gesperrt und wird nie verschickt. Nimm einen anderen.`
      // Sticker kommen immer nach dem Text. Waehrend einer Antwort wird er
      // deshalb nur vorgemerkt und nach der Textnachricht verschickt.
      if (outbox) {
        if (outbox.some((o) => o.sticker)) return 'Ein Sticker pro Antwort reicht, der erste ist schon vorgemerkt.'
        outbox.push({ sticker: id })
        return `Sticker S${id} ist vorgemerkt und geht direkt nach deiner Textantwort raus. Soll der Sticker allein die Antwort sein, antworte mit ${SILENCE}.`
      }
      await send(jid, { sticker: { url: t.orig_path } })
      store.useSticker(id)
      return `Sticker S${id} geschickt.`
    },
    sendImage: async (url, caption) => {
      await send(jid, { image: { url }, caption })
      return `Bild geschickt. Willst du nichts weiter dazu sagen, antworte nur mit ${SILENCE}.`
    },
    // Kai zeichnet selbst: SVG rein, Bild raus. Liefert das Bild auch an Kai
    // zurueck, damit er sieht, was er geschickt hat (oder erst eine Vorschau).
    drawImage: async ({ svg, bildunterschrift, nur_vorschau }) => {
      const images = new Map()
      for (const m of String(svg || '').matchAll(/verlauf:(\d+)/g)) {
        const row = store.byNr(jid, Number(m[1]))
        if (row?.media_path && /^image\/(jpeg|png)$/.test(row.media_mime || '') && existsSync(row.media_path)) {
          images.set(row.nr, { data: readFileSync(row.media_path), mime: row.media_mime })
        }
      }
      const checked = checkSvg(svg, images)
      if (checked.error) return { error: checked.error }
      const leak = findSecret([svg, bildunterschrift])
      if (leak) return { error: 'Nicht gezeichnet: das SVG enthielt einen Zugangsschlüssel.' }
      let png
      try { png = await renderSvg(checked.svg) } catch (err) { return { error: `Ließ sich nicht zeichnen: ${err.message}` } }
      if (nur_vorschau) return { png, text: 'Vorschau, noch nicht geschickt. Passt es, ruf bild_zeichnen ohne nur_vorschau auf.' }
      await send(jid, { image: png, caption: bildunterschrift || undefined })
      return { png, text: `Geschickt, so sieht es aus. Das Bild ist schon im Chat. Willst du nichts weiter dazu sagen, antworte nur mit ${SILENCE}.` }
    },
    // Transkript MIT Zeitmarken einer Sprach-/Videonachricht. Damit erkennt Kai,
    // was Anweisung an ihn ist und was in den Film soll (die Person sagt es in
    // der Aufnahme), und an welchen Sekunden er schneiden muss.
    audio_transkript: async ({ nr }) => {
      if (!transcriptionEnabled()) return 'Transkript geht gerade nicht (kein OpenAI-Schlüssel hinterlegt).'
      const row = store.byNr(jid, nr)
      if (!row?.media_path || !existsSync(row.media_path)) return `#${nr} hat keine Audio-/Videodatei, die ich einlesen kann.`
      if (!/^(audio|video)\//.test(row.media_mime || '') && !['audio', 'video'].includes(row.kind)) return `#${nr} ist keine Sprach- oder Videonachricht.`
      let r
      try { r = await transcribeSegments(readFileSync(row.media_path), { mime: row.media_mime || 'audio/ogg' }) }
      catch (err) {
        if (err.status === 401 || err.status === 403) await notifyOnce('openai-ts', 6 * HOUR, 'Kai: Transkript geht nicht', `OpenAI lehnt ab (HTTP ${err.status}). OPENAI_API_KEY prüfen.`)
        return `Transkript mit Zeitmarken fehlgeschlagen: ${err.message}`
      }
      if (!r.segments.length) return { dauer: r.duration, transkript: '(keine Sprache erkannt)', hinweis: 'Schneide dann nichts.' }
      const transkript = r.segments.map((s) => `[${(s.start ?? 0).toFixed(1)}–${(s.end ?? 0).toFixed(1)} s] ${s.text}`).join('\n')
      return { dauer: r.duration, transkript }
    },
    // Aus Text gesprochene Sprache erzeugen (OpenAI-TTS) und schicken. Der
    // Schluessel bleibt in der Bruecke. als "sprachnachricht" (Ogg/Opus, ptt)
    // oder "datei" (MP3 zum Herunterladen, z. B. fuer Erklaer-Ton im Video).
    sprache_erzeugen: async ({ text, stimme, als = 'sprachnachricht', beschriftung, stil }) => {
      if (!ttsEnabled()) return 'Sprachausgabe geht gerade nicht (kein OpenAI-Schlüssel hinterlegt).'
      const t = String(text || '').trim()
      if (!t) return 'Kein Text angegeben.'
      if (t.length > 4000) return `Zu lang (${t.length} Zeichen, höchstens 4000). Teil es auf.`
      const format = als === 'datei' ? 'mp3' : 'opus'
      let buf
      try { buf = await speak(t, { voice: stimme, format, stil }) }
      catch (err) {
        if (err.status === 401 || err.status === 403) {
          await notifyOnce('openai-tts', 6 * HOUR, 'Kai: Sprachausgabe geht nicht', `OpenAI lehnt die Sprachausgabe ab (HTTP ${err.status}). Schlüssel oder Guthaben prüfen, OPENAI_API_KEY in der .env.`)
        }
        return `Sprachausgabe fehlgeschlagen: ${err.message}`
      }
      try {
        if (als === 'datei') {
          const name = (String(beschriftung || 'sprache').replace(/[^\w.\- ]+/g, '_').slice(0, 60).trim() || 'sprache') + '.mp3'
          await send(jid, { document: buf, fileName: name, mimetype: 'audio/mpeg', caption: beschriftung || undefined })
        } else {
          await send(jid, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true })
        }
      } catch (err) { return `Erzeugt, aber Senden ging nicht: ${err.message}` }
      return `Sprachausgabe ${als === 'datei' ? 'als MP3-Datei' : 'als Sprachnachricht'} geschickt. Willst du nichts weiter dazu sagen, antworte nur mit ${SILENCE}.`
    },
    // Kais eigenes WhatsApp-Profilbild setzen. Quelle: ein Bild aus dem Chat
    // (nr) ODER ein SVG, das Kai selbst zeichnet (gleiche Sicherheitspruefung
    // wie bild_zeichnen). Wird mittig auf ein Quadrat beschnitten.
    profilbild_setzen: async ({ nr, svg }) => {
      let quelle
      if (svg != null) {
        const images = new Map()
        for (const m of String(svg || '').matchAll(/verlauf:(\d+)/g)) {
          const row = store.byNr(jid, Number(m[1]))
          if (row?.media_path && /^image\/(jpeg|png)$/.test(row.media_mime || '') && existsSync(row.media_path)) {
            images.set(row.nr, { data: readFileSync(row.media_path), mime: row.media_mime })
          }
        }
        const checked = checkSvg(svg, images)
        if (checked.error) return `Nicht gesetzt: ${checked.error}`
        if (findSecret([svg])) return 'Nicht gesetzt: das SVG enthielt einen Zugangsschlüssel.'
        try { quelle = await renderSvg(checked.svg) } catch (err) { return `Ließ sich nicht zeichnen: ${err.message}` }
      } else if (nr != null) {
        const row = store.byNr(jid, nr)
        if (!row?.media_path || !existsSync(row.media_path)) return `#${nr} hat kein Bild, das ich nehmen kann.`
        if (!/^image\//.test(row.media_mime || '')) return `#${nr} ist kein Bild.`
        quelle = readFileSync(row.media_path)
      } else {
        return 'Gib entweder nr (ein Bild aus dem Chat) oder svg (selbst gezeichnet) an.'
      }
      let jpg
      try { jpg = await sharp(quelle).rotate().resize(640, 640, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer() }
      catch (err) { return `Bild ließ sich nicht verarbeiten: ${err.message}` }
      try {
        const meId = sock.user?.id
        if (!meId) return 'Ich bin gerade nicht mit WhatsApp verbunden.'
        await sock.updateProfilePicture(meId, jpg)
      } catch (err) { return `Profilbild setzen ging nicht: ${err.message}` }
      return `Profilbild geändert. Willst du nichts weiter dazu sagen, antworte nur mit ${SILENCE}.`
    },
    // Eine Textdatei, deren Inhalt Kai selbst schreibt. Nie ein Pfad auf dem
    // Server: Kai kann nur verschicken, was er selbst formuliert hat.
    sendFile: async ({ dateiname, inhalt, beschriftung }) => {
      const name = safeEntryName(dateiname)?.split('/').pop()
      if (!name || !TEXT_FILE.test(name)) return `Dateiname "${dateiname}" geht nicht. Erlaubt sind Textdateien wie .md, .txt, .json, .csv, .js oder .html.`
      const buf = Buffer.from(inhalt, 'utf8')
      if (buf.length > FILE_MAX) return `Zu groß (${Math.round(buf.length / 1024)} kB, höchstens ${FILE_MAX / 1024} kB).`
      await send(jid, { document: buf, fileName: name, mimetype: mimeFor(name), caption: beschriftung || undefined })
      return `${name} geschickt. Willst du nichts weiter dazu sagen, antworte nur mit ${SILENCE}.`
    },
    // Ein ZIP aus selbst geschriebenen Dateien und Anhaengen aus dem Verlauf
    // dieses Chats. Auch hier: kein Pfad auf dem Server.
    // Code in der Sandbox ausfuehren: beliebige Dateiarbeit, ohne Geheimnisse,
    // ohne Netz. Eingaben sind Dateien aus diesem Chat (per Nummer), Ausgaben
    // legt der Code in out/ ab und kann sie danach verschickt werden.
    runCode: async ({ sprache = 'bash', code, dateien = [], timeout = 60 }) => {
      if (!sandboxReady()) return { error: 'Die Sandbox ist gerade nicht verfügbar.' }
      const inputs = []
      for (const nr of dateien) {
        const row = store.byNr(jid, nr)
        if (!row?.media_path || !existsSync(row.media_path)) return { error: `#${nr} hat keine Datei, die ich einlesen kann.` }
        inputs.push({ name: receivedName(row), data: readFileSync(row.media_path) })
      }
      const res = await runSandbox({ sprache, code, timeout, inputs })
      if (res.id) lastJob.set(jid, res.id)
      return res
    },
    // Eine von der Sandbox erzeugte Datei in den Chat schicken.
    sendSandboxFile: async ({ pfad, als = 'datei', beschriftung, job }) => {
      const id = job || lastJob.get(jid)
      if (!id) return 'Kein Sandbox-Ergebnis vorhanden. Führ erst Code aus.'
      const buf = sandboxFile(id, pfad)
      if (!buf) return `Die Datei "${pfad}" gibt es im Ergebnis nicht (oder sie ist zu groß).`
      const name = String(pfad).split('/').pop().replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'datei'
      const leak = findSecret([buf, beschriftung])
      if (leak) return 'Nicht gesendet: die Datei enthielt einen Zugangsschlüssel.'
      try {
        if (als === 'bild') await send(jid, { image: buf, caption: beschriftung || undefined })
        else if (als === 'video') await send(jid, { video: buf, caption: beschriftung || undefined })
        else if (als === 'audio') await send(jid, { audio: buf, mimetype: 'audio/mp4', ptt: false })
        else if (als === 'sprachnachricht') await send(jid, { audio: buf, mimetype: 'audio/ogg; codecs=opus', ptt: true })
        else await send(jid, { document: buf, fileName: name, mimetype: mimeFor(name), caption: beschriftung || undefined })
      } catch (err) { return `Nicht gesendet: ${err.message}` }
      return `"${name}" als ${als} geschickt. Willst du nichts weiter dazu sagen, antworte nur mit ${SILENCE}.`
    },
    // Bei einer Umfrage mitstimmen. nr = die Umfrage-Nachricht, optionen = die
    // Namen der gewaehlten Antworten (genau wie im Verlauf geschrieben).
    votePoll: async ({ nr, optionen }) => {
      const row = store.byNr(jid, nr)
      if (!row || row.kind !== 'poll' || !row.poll_json) return `#${nr} ist keine Umfrage in diesem Chat.`
      let poll
      try { poll = JSON.parse(row.poll_json) } catch { poll = null }
      if (!poll?.secret) return `Bei #${nr} kann ich nicht mitstimmen, der Schlüssel der Umfrage fehlt (zu alt oder beim Koppeln nachgeladen).`
      // Die genannten Optionen auf die echten Namen abbilden (Gross/Klein egal).
      const chosen = []
      for (const name of optionen) {
        const hit = poll.optionen.find((o) => o.toLowerCase() === String(name).toLowerCase().trim())
        if (!hit) return `Die Option "${name}" gibt es in dieser Umfrage nicht. Zur Auswahl: ${poll.optionen.join(', ')}.`
        if (!chosen.includes(hit)) chosen.push(hit)
      }
      if (!chosen.length) return 'Keine Option angegeben.'
      if (chosen.length > 1 && !poll.mehrfach) return 'Diese Umfrage lässt nur eine Antwort zu, wähl eine.'
      const pollKey = JSON.parse(row.key_json)
      // Den Original-Schluessel der Umfrage unveraendert mitschicken, damit die
      // anderen Clients die Stimme der Umfrage zuordnen. Die Verschluesselung
      // nutzt dieselbe Adressierung wie der Schluessel (LID oder Telefon).
      const isLid = pollKey.addressingMode === 'lid' || /@lid$/.test(pollKey.remoteJid || '') || /@lid$/.test(pollKey.participant || '')
      const meId = isLid && sock.user?.lid ? normJid(sock.user.lid) : normJid(sock.user.id)
      const pollCreatorJid = pollCreatorJidOf(pollKey)
      const voterJid = meId
      const creationKey = { remoteJid: pollKey.remoteJid, fromMe: Boolean(pollKey.fromMe), id: pollKey.id }
      if (pollKey.participant) creationKey.participant = pollKey.participant
      const voteMsg = pollVoteMessage(chosen, {
        pollMsgId: pollKey.id, pollCreatorJid, voterJid,
        pollEncKey: Buffer.from(poll.secret, 'base64'), creationKey,
      })
      // An die Adresse schicken, auf der die Umfrage liegt (in LID-Chats die
      // LID), nicht an die kanonische Chat-JID.
      const target = pollKey.remoteJid || jid
      try {
        const mid = generateMessageIDV2(sock.user?.id)
        // Wie ein echtes Handy: <meta polltype="vote"/> anhaengen, damit die
        // Clients die Nachricht als Umfrage-Stimme behandeln.
        await sock.relayMessage(target, voteMsg, { messageId: mid, additionalNodes: [{ tag: 'meta', attrs: { polltype: 'vote' } }] })
        log(`Umfrage #${row.nr}: Stimme gesendet an ${target}, Ersteller ${pollCreatorJid}, Waehler ${voterJid}, Optionen ${chosen.join('/')}`)
      } catch (err) { return `Stimme nicht abgegeben: ${err.message}` }
      store.set(`sent:${Logs.today()}`, sentToday() + 1)
      store.recordVote(row.nr, voterJid.split('@')[0], config.names[0], chosen.map((n) => optionHash(n).toString('hex')), Math.floor(Date.now() / 1000))
      return `Ich hab für "${chosen.join(', ')}" gestimmt. Sag mir bitte, ob meine Stimme bei dir auftaucht. Es kann sein, dass WhatsApp sie in dieser Gruppe nicht übernimmt, das lässt sich von meiner Seite nicht sicher prüfen. Behaupte nicht, es sei erledigt, bevor jemand bestätigt, dass die Stimme zählt.`
    },
    // Zwischenstand einer Umfrage: wer wofuer gestimmt hat.
    pollState: ({ nr }) => {
      const row = store.byNr(jid, nr)
      if (!row || row.kind !== 'poll' || !row.poll_json) return `#${nr} ist keine Umfrage in diesem Chat.`
      let poll
      try { poll = JSON.parse(row.poll_json) } catch { return 'Umfrage nicht lesbar.' }
      const byHash = new Map(poll.optionen.map((o) => [optionHash(o).toString('hex'), o]))
      const tally = new Map(poll.optionen.map((o) => [o, []]))
      for (const v of store.votesFor(nr)) for (const h of v.options) {
        const name = byHash.get(h)
        if (name) tally.get(name).push(v.name || `+${v.voter}`)
      }
      const lines = poll.optionen.map((o) => `${o}: ${tally.get(o).length}${tally.get(o).length ? ' (' + tally.get(o).join(', ') + ')' : ''}`)
      const total = store.votesFor(nr).length
      return `Umfrage "${poll.frage}" (${total} ${total === 1 ? 'Stimme' : 'Stimmen'}):\n${lines.join('\n')}`
    },
    // Sticker aus einem Bild dieses Chats: ganz, Ausschnitt oder freigestellt.
    // Der verschickte Sticker kommt ueber den eigenen Verlauf von selbst in die
    // Sammlung und wird dort beschrieben.
    makeSticker: async ({ nr, modus = 'ganz', ausschnitt, text, text_position, rand = true, nur_vorschau }) => {
      const row = store.byNr(jid, nr)
      if (!row?.media_path || !/^image\/(jpeg|png)$/.test(row.media_mime || '') || !existsSync(row.media_path)) {
        return { error: `#${nr} ist kein Bild in diesem Chat, aus dem ich einen Sticker machen kann.` }
      }
      if (text && findSecret([text])) return { error: 'Nicht gemacht: der Text enthielt einen Zugangsschlüssel.' }
      let r
      try { r = await makeSticker(readFileSync(row.media_path), { modus, ausschnitt, text, textPos: text_position, rand }) } catch (err) { return { error: `Kein Sticker: ${err.message}` } }
      if (nur_vorschau) return { png: r.preview, text: 'Vorschau (grau = durchsichtig), noch nicht geschickt. Passt es, ruf sticker_erstellen ohne nur_vorschau auf.' }
      await send(jid, { sticker: r.webp })
      return { png: r.preview, text: `Sticker geschickt, er landet auch in deiner Sammlung. Willst du nichts weiter dazu sagen, antworte nur mit ${SILENCE}.` }
    },
    sendZip: async ({ dateiname, dateien = [], aus_verlauf = [], beschriftung }) => {
      const zipName = (safeEntryName(dateiname)?.split('/').pop() || 'dateien').replace(/\.zip$/i, '') + '.zip'
      const entries = []
      const seen = new Set()
      const add = (path, data) => {
        const name = safeEntryName(path)
        if (!name) throw new Error(`Pfad "${path}" geht nicht: nur relative Pfade ohne ".."`)
        if (seen.has(name.toLowerCase())) throw new Error(`"${name}" kommt doppelt vor`)
        seen.add(name.toLowerCase())
        entries.push({ name, data })
      }
      try {
        for (const f of dateien) add(f.pfad, Buffer.from(f.inhalt, 'utf8'))
        for (const a of aus_verlauf) {
          const row = store.byNr(jid, a.nr)
          if (!row?.media_path || !existsSync(row.media_path)) throw new Error(`#${a.nr} hat keinen Anhang, den ich einpacken kann`)
          const ext = row.media_path.split('.').pop()
          add(a.pfad || `anhang-${a.nr}.${ext}`, readFileSync(row.media_path))
        }
      } catch (err) { return `Nicht gepackt: ${err.message}.` }
      if (!entries.length) return 'Das ZIP wäre leer.'
      if (entries.length > ZIP_MAX_FILES) return `Zu viele Dateien (${entries.length}, höchstens ${ZIP_MAX_FILES}).`
      const total = entries.reduce((n, e) => n + e.data.length, 0)
      if (total > ZIP_MAX_BYTES) return `Zu groß (${Math.round(total / 1024 / 1024)} MB, höchstens ${ZIP_MAX_BYTES / 1024 / 1024} MB).`
      const leak = findSecret(entries.map((e) => e.data))
      if (leak) {
        log(`ZIP BLOCKIERT fuer ${jid}: enthielt ${leak}`)
        await notifyOnce(`leak:${jid}`, HOUR, 'Kai: ZIP blockiert, Schluessel im Inhalt',
          `Kai wollte ein ZIP senden, das ${leak} enthielt. Nichts wurde gesendet.`, { priority: 'urgent' })
        return 'Nicht gesendet: der Inhalt enthielt einen Zugangsschlüssel. Solche Daten verschickst du nie.'
      }
      await send(jid, { document: createZip(entries), fileName: zipName, mimetype: 'application/zip', caption: beschriftung || undefined })
      return `${zipName} mit ${entries.length} Datei${entries.length === 1 ? '' : 'en'} geschickt. Willst du nichts weiter dazu sagen, antworte nur mit ${SILENCE}.`
    },
    searchHistory: ({ suchbegriff, von, bis, gruppe }) => {
      const target = historyTarget(jid, requester, gruppe)
      if (target.error) return target.error
      const from = von ? parseLocal(`${von} 00:00`) : null
      const to = bis ? parseLocal(`${bis} 00:00`) + 86400 : null
      if ((von && !from) || (bis && !to)) return 'Datum nicht verstanden, Format YYYY-MM-DD.'
      const rows = store.search(target.jid, { query: suchbegriff, from, to, limit: 30 })
      if (!rows.length) return 'Nichts gefunden.'
      return historyText(target.jid, rows)
    },
    readHistory: ({ nr, davor = 10, danach = 10, gruppe }) => {
      const target = historyTarget(jid, requester, gruppe)
      if (target.error) return target.error
      const rows = store.around(target.jid, nr, davor, danach)
      return rows.length ? historyText(target.jid, rows) : `Um #${nr} gibt es nichts.`
    },
    postToGroup: async ({ gruppe, text, erwaehnen, warten, sticker }) => {
      // Nur der Besitzer, nur aus seinem Direktchat. Das prueft der Code, nicht die KI.
      if (!isDirectChat(jid) || !requester.isOwner) return 'In andere Gruppen schreiben geht nur auf Auftrag des Besitzers im Direktchat.'
      const target = historyTarget(jid, requester, gruppe)
      if (target.error) return target.error
      text = humanize(text)
      let content = { text }
      if (erwaehnen) {
        const person = store.findSender(target.jid, erwaehnen)
        if (!person) return `In "${store.group(target.jid).subject}" hat noch niemand namens "${erwaehnen}" geschrieben, ich kann ihn nicht erwähnen. Ohne erwaehnen schicken oder den Namen prüfen.`
        content = { text: `@${person.sender_jid.split('@')[0]} ${text}`, mentions: [person.sender_jid] }
      }
      const sent = await send(target.jid, content)
      const nr = sent && await handle(sent, { live: false })
      // Sticker aus der gemeinsamen Sammlung, nach dem Text.
      let stickerNote = ''
      if (sticker) {
        const sid = Number((/S?(\d+)/i.exec(sticker) || [])[1])
        const t = sid && store.sticker(sid)
        if (t?.blocked) stickerNote = ` Sticker S${sid} ist gesperrt, nur der Text ging raus.`
        else if (t && existsSync(t.orig_path)) {
          await send(target.jid, { sticker: { url: t.orig_path } })
          store.useSticker(sid)
          stickerNote = ` Sticker S${sid} hinterher.`
        } else stickerNote = ` Sticker "${sticker}" gibt es nicht, nur der Text ging raus.`
      }
      logs.append(target.jid, `(Vertraulich, nie erwähnen) Auf Bitte von ${config.owner.name} aus dem Direktchat geschrieben (#${nr}): ${text.slice(0, 200)}`)
      if (warten !== false && nr) {
        const until = Math.floor(Date.now() / 1000) + 24 * 3600
        store.set(`watch:${target.jid}`, JSON.stringify({ nr, until, auftrag: `${config.owner.name} wollte wissen: ${text.slice(0, 300)}` }))
      }
      return `In "${store.group(target.jid).subject}" geschrieben (#${nr}).${stickerNote}${warten !== false ? ' Ich warte 24 Stunden auf eine Antwort und melde sie dir.' : ''}`
    },
    notifyOwner: async (text) => {
      if (isDirectChat(jid)) return 'Du bist schon im Direktchat, antworte einfach.'
      const day = new Date().toISOString().slice(0, 10)
      const key = `owner-notes:${jid}:${day}`
      const count = Number(store.get(key) || 0)
      if (count >= 20) return 'Heute schon 20 Nachrichten an den Besitzer aus dieser Gruppe, mehr nicht.'
      const dm = ownerChatJid(config.owner.number)
      const sent = await send(dm, { text: `Aus „${store.group(jid).subject}“: ${humanize(text)}` })
      if (sent) await handle(sent, { live: false })
      store.set(key, count + 1)
      return 'An den Besitzer geschickt.'
    },
    endWatch: () => { store.set(`watch:${jid}`, ''); return 'Warten beendet.' },
    appendLog: (text) => logs.append(jid, text),
    memRead: (file) => {
      if (!file) return `Dateien: ${memory.list(jid).join(', ')}`
      return memory.read(jid, file) ?? `${file} gibt es nicht. Vorhanden: ${memory.list(jid).join(', ')}`
    },
    memAppend: (file, text) => memory.append(jid, file, text),
    memWrite: (file, content) => {
      const res = memory.write(jid, file, content)
      // Aenderungen an der Persoenlichkeit sollen nachvollziehbar bleiben.
      if (file === 'Soul.md' && res.endsWith('gespeichert.')) {
        logs.append(jid, `Soul.md geändert (angestoßen von ${requester.name || 'unbekannt'}${requester.isOwner ? ', Besitzer' : ''}).`)
        log(`${jid}: Soul.md geaendert, angestossen von ${requester.name}`)
      }
      return res
    },
    readLog: (day) => {
      if (!day) return `Vorhandene Tage: ${logs.days(jid).join(', ') || 'keine'}`
      return logs.read(jid, day) || `Für ${day} gibt es kein Log.`
    },
    planTask: (zeit, instruction, repeat) => {
      const when = parseLocal(zeit)
      if (!when) return `Zeit "${zeit}" nicht verstanden, Format ist "YYYY-MM-DD HH:MM".`
      if (when < Date.now() / 1000 - 60) return `${zeit} liegt in der Vergangenheit.`
      if (repeat !== 'einmal' && !requester.isOwner) return `Wiederkehrende Aufgaben darf nur ${config.owner.name} anlegen.`
      const open = store.tasks(jid)
      if (open.length >= MAX_TASKS_PER_GROUP) return `Es sind schon ${open.length} Aufgaben geplant, mehr nicht.`
      if (!requester.isOwner && open.filter((t) => t.creator_jid === requester.jid).length >= MAX_TASKS_PER_PERSON) {
        return `${requester.name || 'Diese Person'} hat schon ${MAX_TASKS_PER_PERSON} offene Aufgaben.`
      }
      const id = store.addTask({ groupJid: jid, creatorJid: requester.isOwner ? ownerJid() : requester.jid, creatorName: requester.name, instruction, nextRun: when, repeat })
      log(`${jid}: Aufgabe ${id} geplant fuer ${formatLocal(when)} (${repeat}) von ${requester.name}`)
      return `Aufgabe ${id} geplant: ${formatLocal(when)}, ${repeat}.`
    },
    listTasks: () => {
      const t = store.tasks(jid)
      return t.length ? t.map((x) => `${x.id}: ${formatLocal(x.next_run)} (${x.repeat}), von ${x.creator_name || '?'}: ${x.instruction}`).join('\n') : 'Keine Aufgaben geplant.'
    },
    deleteTask: (id) => {
      const t = store.task(jid, id)
      if (!t) return `Aufgabe ${id} gibt es nicht.`
      if (!requester.isOwner && t.creator_jid !== requester.jid) return `Aufgabe ${id} kann nur ${t.creator_name || 'ihr Ersteller'} oder ${config.owner.name} löschen.`
      store.deleteTask(id)
      return `Aufgabe ${id} gelöscht.`
    },
  }
}

// Korrekturen fuer laufende Sessions: jeder Chat bekommt jeden Hinweis
// genau einmal, beim naechsten Durchgang. Nur anhaengen, nie aendern.
const NOTICES = [
]

function activeWatch(jid) {
  const raw = store.get(`watch:${jid}`)
  if (!raw) return null
  try {
    const w = JSON.parse(raw)
    return w.until > Date.now() / 1000 ? w : null
  } catch { return null }
}

// Wessen Verlauf darf gelesen werden? Immer der eigene Chat. Einen anderen
// nur im Direktchat mit dem Besitzer, und nur eine freigegebene Gruppe.
function historyTarget(jid, requester, gruppe) {
  if (!gruppe) return { jid }
  if (!isDirectChat(jid) || !requester.isOwner) return { error: 'Den Verlauf anderer Gruppen kann nur der Besitzer im Direktchat abfragen.' }
  const want = gruppe.toLowerCase()
  const hits = config.groups.filter((g) => (store.group(g).subject || '').toLowerCase().includes(want))
  if (hits.length !== 1) {
    const names = config.groups.map((g) => store.group(g).subject || g).join(', ')
    return { error: hits.length ? `"${gruppe}" ist nicht eindeutig. Freigegeben: ${names}` : `Keine freigegebene Gruppe heißt "${gruppe}". Freigegeben: ${names || 'keine'}` }
  }
  return { jid: hits[0] }
}

function historyText(chatJid, rows) {
  const blocks = buildContent(rows, { ownerName: config.owner.name, nrOf: (waId) => store.nrOf(chatJid, waId), maxImages: 0, withMedia: false })
  return blocks.map((b) => b.text).join('')
}

// ---------------------------------------------------------------- Tagesrunde

// Einmal am Tag wacht Kai in jeder Gruppe von selbst auf, zu einer zufaelligen
// Zeit zwischen 5 Uhr und Mitternacht: Steht etwas an (Geburtstag, Termin,
// Jahrestag)? Ist es lange still und lohnt sich eine Nachricht? Er entscheidet
// selbst, meistens schweigt er. Die Uhrzeit steht in kv, damit ein Neustart
// sie nicht neu wuerfelt oder die Runde doppelt laufen laesst.
const ago = (sec) => {
  if (sec == null) return 'noch nie'
  const s = Math.floor(Date.now() / 1000) - sec
  if (s < 3600) return `vor ${Math.max(1, Math.round(s / 60))} Minuten`
  if (s < 2 * 86400) return `vor ${Math.round(s / 3600)} Stunden`
  return `vor ${Math.round(s / 86400)} Tagen`
}

function dailyBrief(jid) {
  const now = Math.floor(Date.now() / 1000)
  const others = store.lastTs(jid, false)
  const mine = store.lastTs(jid, true)
  const week = store.countSinceTs(jid, now - 7 * 86400)
  const kalender = memory.read(jid, 'Kalender.md') || '(noch leer)'
  const tasks = store.tasks(jid).map((t) => `- ${formatLocal(t.next_run)}: ${t.instruction.slice(0, 80)}`).join('\n') || '(keine)'
  return `Tagesrunde. Niemand hat dich gerufen: Du wachst einmal am Tag von selbst auf und schaust, ob heute etwas ansteht oder ob du dich melden willst.

Stand der Gruppe:
- Letzte Nachricht von jemand anderem: ${ago(others)}
- Deine letzte Nachricht: ${ago(mine)}
- Nachrichten in den letzten 7 Tagen: ${week}
- Schon geplante Aufgaben in dieser Gruppe:
${tasks}

Dein Kalender.md:
${kalender}

Geh so vor:
1. Steht heute etwas an? Geburtstag, Jahrestag, ein Termin aus dem Kalender, aus Abmachungen.md oder deinen Logs, oder ein besonderer Tag, der zur Gruppe passt? Dann reagiere jetzt, kurz und persönlich: gratulieren, erinnern, „habt ihr gewusst, dass heute …“. Bei Geburtstagen gern mit @Erwähnung und einem passenden Sticker.
2. Steht in den nächsten Tagen etwas an, etwa morgen ein Geburtstag? Dann leg mit aufgabe_planen eine einmalige Aufgabe zu einer natürlichen Uhrzeit an (Geburtstag eher morgens, zwischen 8 und 10 Uhr), statt bis zur nächsten Tagesrunde zu warten. Prüf vorher die Liste oben, damit nichts doppelt geplant wird.
3. Steht nichts an: Bewerte von 1 bis 10, wie sinnvoll eine Nachricht von dir gerade wäre. Dafür zählen, wie lange es still ist, wie die Stimmung zuletzt war, und ob du eine echte Folgefrage zu einem früheren Thema hast. Halte dich an deine Regeln in Kalender.md (Mindestdauer der Stille, Schwelle). Liegst du darüber, schreib etwas Menschliches und Kurzes, wie ein Freund, dem langweilig ist: „Mir ist langweilig, was geht bei euch?“, eine Folgefrage („Basti, wie lief eigentlich der Halbmarathon?“), etwas, das dir aufgefallen ist. Kein Newsletter, keine Zusammenfassung, kein „ich wollte mich mal melden“.
4. Schreib in jedem Fall eine Zeile mit log_schreiben: was anstand, deine Bewertung und deine Entscheidung. So kannst du später sehen, wie es ankam, und deine Regeln in Kalender.md anpassen, wenn Leute dir sagen, dass du zu früh, zu spät oder genau richtig kamst.
5. Willst du nichts schreiben, antworte nur mit ${SILENCE}. Das ist der Normalfall. Und erwähne nie, dass dies eine „Tagesrunde“ oder ein Weckruf ist.`
}

function runDailyRounds() {
  if (!connected) return
  const now = Math.floor(Date.now() / 1000)
  const day = Logs.today()
  for (const jid of config.groups) {
    const key = `tagesrunde:${jid}:${day}`
    let plan = null
    try { plan = JSON.parse(store.get(key) || 'null') } catch { /* neu wuerfeln */ }
    if (!plan) {
      const at = pickDailyTime(day, now)
      plan = { at, done: at == null }
      store.set(key, JSON.stringify(plan))
      if (at) log(`${jid}: Tagesrunde heute um ${formatLocal(at).slice(11)}`)
    }
    if (plan.done || now < plan.at) continue
    store.set(key, JSON.stringify({ ...plan, done: true }))
    if (store.group(jid).paused || !proactiveOn(jid) || limitReached()) continue
    schedule(jid, { task: { id: 'tagesrunde', group_jid: jid, creator_jid: null, creator_name: 'Tagesrunde', instruction: dailyBrief(jid), repeat: 'einmal', daily: true } })
  }
}

// Faellige Aufgaben einreihen. Eine einmalige Aufgabe, die mehr als zwoelf
// Stunden verpasst wurde (Server aus), wird nicht mehr nachgeholt.
function runDueTasks() {
  if (!connected) return
  const now = Math.floor(Date.now() / 1000)
  for (const t of store.dueTasks(now)) {
    if (!config.groups.includes(t.group_jid) && t.group_jid !== ownerChatJid(config.owner.number)) continue
    const next = nextRun(t.next_run, t.repeat, now)
    if (next) store.setTaskRun(t.id, next)
    else store.deleteTask(t.id)
    if (now - t.next_run > 12 * 3600) {
      log(`${t.group_jid}: Aufgabe ${t.id} verpasst (${formatLocal(t.next_run)}), nicht nachgeholt`)
      notify('Kai: Aufgabe verpasst', `Aufgabe ${t.id} war faellig ${formatLocal(t.next_run)} und wurde nicht ausgefuehrt: ${t.instruction.slice(0, 100)}`)
      continue
    }
    if (limitReached()) {
      log(`${t.group_jid}: Aufgabe ${t.id} faellt aus, Tageslimit erreicht`)
      notify('Kai: Aufgabe wegen Tageslimit ausgefallen', `Aufgabe ${t.id} (${t.instruction.slice(0, 80)}) nicht ausgefuehrt, ${sentToday()} Nachrichten heute.`)
      continue
    }
    schedule(t.group_jid, { task: t })
  }
}

async function deliver(jid, job, result) {
  if (!result) return
  const text = result.text
  if (result.costUsd != null) log(`${jid}: Durchgang fuer ${job.task ? 'Aufgabe ' + job.task.id : '#' + job.nr}, geschaetzt ${result.costUsd.toFixed(3)} USD (Abo, nur Richtwert)`)
  // Sticker plus nur ein Emoji davor: der Sticker steht allein.
  const stickerOnly = (result.outbox || []).some((o) => o.sticker) && isOnlyDecoration(text?.replace(SILENCE, ''))
  if (job.task?.daily) {
    const quiet = stickerOnly || !text || text.includes(SILENCE)
    log(`${jid}: Tagesrunde: ${quiet ? ((result.outbox || []).length ? 'nur Sticker' : 'geschwiegen') : 'geschrieben'}`)
  }
  if (job.proactive) {
    const what = stickerOnly || (!text || text.includes(SILENCE)) ? ((result.outbox || []).length ? 'nur Sticker' : 'geschwiegen') : 'geantwortet'
    log(`${jid}: Mitlesen (${{ followup: 'im Gespraech', fresh: 'nach Stille' }[job.proactive] || 'ohne Ansprache'}) bis #${job.nr}: ${what}`)
  }
  if (!stickerOnly && text && text !== SILENCE && !text.includes(SILENCE)) await deliverText(jid, job, text)
  // Danach, was Kai vorgemerkt hat: Sticker immer erst nach dem Text.
  for (const item of result.outbox || []) {
    const t = item.sticker && store.sticker(item.sticker)
    if (!t || !existsSync(t.orig_path)) continue
    await send(jid, { sticker: { url: t.orig_path } }).catch((err) => log(`Sticker S${t.id} nicht gesendet:`, err.message))
    store.useSticker(t.id)
  }
}

async function deliverText(jid, job, raw) {
  const text = humanize(raw)
  let sent
  if (job.task) {
    // Wer die Aufgabe angelegt hat, wird erwaehnt, damit das Handy klingelt.
    const who = job.task.creator_jid
    const num = who?.split('@')[0]
    sent = await send(jid, who ? { text: `@${num} ${text}`, mentions: [who] } : { text })
  } else {
    // Bewusst ohne Zitat: die zitierte Nachricht blaeht den Chat nur auf.
    sent = await send(jid, { text })
  }
  // Die eigene Antwort sofort ablegen. Als gelesen markieren nur, wenn sie
  // das einzige Neue ist: was waehrend des Nachdenkens reinkam, muss Kai
  // beim naechsten Mal noch sehen.
  const nr = sent && await handle(sent, { live: false })
  if (nr && store.countSince(jid, store.group(jid).last_nr) === 1) store.updateGroup(jid, { last_nr: nr })
  const month = new Date().toISOString().slice(0, 7)
  store.set(`replies:${month}`, Number(store.get(`replies:${month}`) || 0) + 1)
}

// ---------------------------------------------------------------- Besitzer

async function ownerCommand(jid, text, msg) {
  const cmd = text.trim().split(/\s+/)[1]?.toLowerCase()
  const g = store.group(jid)
  let reply
  switch (cmd) {
    case 'pause': store.updateGroup(jid, { paused: 1 }); reply = 'Pausiert. Ich lese weiter mit, antworte aber nicht. `!kai weiter` hebt das auf.'; break
    case 'weiter': store.updateGroup(jid, { paused: 0 }); reply = 'Bin wieder da.'; break
    case 'neu': store.updateGroup(jid, { session_id: null }); reply = 'Unterhaltung zurückgesetzt. Beim nächsten Mal lese ich den Verlauf neu ein.'; break
    case 'modell':
    case 'model': {
      const arg = text.trim().split(/\s+/).slice(2).join(' ').toLowerCase().trim()
      const cur = store.get(`model:${jid}`) || config.model
      const curName = `${cur}${MODEL_NAMES[cur] ? ` (${MODEL_NAMES[cur]})` : ''}`
      if (!arg) {
        reply = `Dieser Chat läuft auf ${curName}${store.get(`model:${jid}`) ? '' : ' (Standard)'}.\nUmstellen: \`!kai modell opus\`, \`!kai modell sonnet\`, \`!kai modell haiku\` (oder die volle ID). Zurück auf Standard: \`!kai modell standard\`.`
      } else if (arg === 'standard' || arg === 'default' || arg === 'zurück' || arg === 'zurueck') {
        store.set(`model:${jid}`, '')
        store.updateGroup(jid, { session_id: null })
        reply = `Zurück auf das Standardmodell ${config.model}${MODEL_NAMES[config.model] ? ` (${MODEL_NAMES[config.model]})` : ''}. Die Unterhaltung starte ich frisch, damit der Wechsel sauber greift.`
      } else {
        const m = resolveModel(arg)
        if (!m) { reply = `Das Modell „${arg}“ kenne ich nicht. Erlaubt: ${Object.entries(MODEL_NAMES).map(([id, n]) => `${n.split(' ').slice(1).join(' ').toLowerCase()} = ${id}`).join(', ')}. Oder \`!kai modell standard\`.` }
        else {
          store.set(`model:${jid}`, m)
          store.updateGroup(jid, { session_id: null })
          reply = `Dieser Chat läuft ab jetzt auf ${m}${MODEL_NAMES[m] ? ` (${MODEL_NAMES[m]})` : ''}. Die Unterhaltung starte ich frisch, damit der Wechsel sauber greift.`
        }
      }
      break
    }
    case 'proaktiv': {
      const arg = text.trim().split(/\s+/)[2]?.toLowerCase()
      if (arg === 'an' || arg === 'aus') store.set(`proactive:${jid}`, arg)
      reply = `Mitreden ohne Ansprache ist hier ${proactiveOn(jid) ? 'an' : 'aus'}. Umschalten mit \`!kai proaktiv an\` oder \`!kai proaktiv aus\`.`
      break
    }
    case 'status': {
      const month = new Date().toISOString().slice(0, 7)
      reply = [
        `Gruppe: ${g.subject}`,
        `Verlauf: ${store.latestNr(jid) ? store.countSince(jid, 0) : 0} Nachrichten`,
        `Session: ${g.session_id ? g.session_id.slice(0, 8) : 'keine'}`,
        `Modell: ${(() => { const m = store.get(`model:${jid}`) || config.model; return `${MODEL_NAMES[m] || m}${store.get(`model:${jid}`) ? '' : ' (Standard)'}` })()}`,
        `Pausiert: ${g.paused ? 'ja' : 'nein'}`,
        `Antworten diesen Monat: ${store.get(`replies:${month}`) || 0}`,
        `Heute verschickt: ${sentToday()} von ${config.maxMessagesPerDay}`,
        `Mitreden ohne Ansprache: ${proactiveOn(jid) ? 'an' : 'aus'}`,
      ].join('\n')
      break
    }
    default: reply = 'Befehle: `!kai status`, `!kai pause`, `!kai weiter`, `!kai neu`, `!kai proaktiv an|aus`, `!kai modell opus|sonnet|haiku|standard`'
  }
  await send(jid, { text: reply }, { quoted: msg }, { notice: true })
}

// ---------------------------------------------------------------- Waechter

// Stoerungen sofort, "alles gut" nur am Monatsersten. Ein Waechter, der nur
// bei Fehlern spricht, ist von einem toten nicht zu unterscheiden.
async function watchdog() {
  const now = new Date()
  const month = now.toISOString().slice(0, 7)

  if (now.getDate() === 1 && store.get('allclear') !== month) {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 15).toISOString().slice(0, 7)
    if (connected) {
      store.set('allclear', month)
      await notify('Kai laeuft', `${store.get(`replies:${prev}`) || 0} Antworten im Vormonat, verbunden als +${[...botJids][0]?.split('@')[0]}.`, { priority: 'default', tags: 'white_check_mark' })
    }
  }

  if (!loggedOut && !connected && Date.now() - lastOpen > 30 * 60_000) {
    await notifyOnce('offline', 6 * HOUR, 'Kai offline', 'Seit ueber 30 Minuten keine Verbindung zu WhatsApp.')
  }

  if (config.tokenCreated) {
    const expires = new Date(config.tokenCreated).getTime() + 365 * DAY
    const left = Math.floor((expires - Date.now()) / DAY)
    if (left <= 30) {
      await notifyOnce('token', DAY, 'Kai: Claude-Token laeuft ab',
        left > 0 ? `Setup-Token laeuft in ${left} Tagen ab. Neu erzeugen mit claude setup-token, siehe kai/README.md.` : `Setup-Token ist seit ${-left} Tagen abgelaufen.`)
    }
  } else {
    log('KAI_TOKEN_CREATED ist nicht gesetzt, die Ablaufwarnung fuer den Setup-Token ist aus.')
  }
}

// ---------------------------------------------------------------- Start

process.on('unhandledRejection', (err) => log('unbehandelter Fehler:', err?.message || err))
log(`startet. Gruppen: ${config.groups.join(', ') || '(keine, Einrichtungsmodus)'}; Besitzer: ${config.owner.name} ${config.owner.number ? '+' + config.owner.number : '(Nummer fehlt!)'}`)
await connect()
setTimeout(watchdog, 60_000)
setInterval(watchdog, 6 * HOUR)
setInterval(runDueTasks, 30_000)
setInterval(runDailyRounds, 60_000)
if (sandboxReady()) setInterval(cleanupSandbox, 30 * 60_000)
