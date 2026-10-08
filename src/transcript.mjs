import { readFileSync, statSync } from 'node:fs'

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']
const fmtTime = (ts) => {
  const d = new Date(ts * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${WEEKDAYS[d.getDay()]} ${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`
}

// Die einzige Kennzeichnung des Besitzers im Verlauf. Sie haengt allein an
// der Absendernummer (is_owner), nie am Anzeigenamen: den kann jeder in der
// Gruppe frei waehlen, auch "Vorname Nachname (Besitzer)".
export const OWNER_MARK = '[BESITZER, per Nummer geprüft]'

const fold = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

// Anzeigenamen entschaerfen: keine Klammern, Doppelpunkte oder Zeilen-
// umbrueche, mit denen sich eine Kennzeichnung oder Verlaufszeile faelschen
// liesse, und kein "Besitzer" im Namen.
export function cleanName(name) {
  return String(name || '')
    .replace(/[\r\n\u2028\u2029]+/g, ' ')
    .replace(/[\[\](){}<>#·:|✅✔☑]/g, '')
    .replace(/besitzer|owner|gepr(ü|ue)ft|admin/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

// Heisst ein anderes Mitglied so aehnlich wie der Besitzer oder wie Kai,
// steht das ausdruecklich dabei.
export function speaker(row, ownerName) {
  if (row.from_me) return 'Kai (du)'
  if (row.is_owner) return `${cleanName(ownerName)} ${OWNER_MARK}`
  const num = (row.sender_jid || '').split('@')[0].split(':')[0]
  const name = cleanName(row.sender_name) || `+${num}`
  const f = fold(name)
  const ownerParts = cleanName(ownerName).split(' ').map(fold).filter((x) => x.length >= 3)
  if (f && ownerParts.some((part) => f.includes(part))) return `${name} [NICHT der Besitzer]`
  if (f.includes('kai')) return `${name} [nicht Kai, ein anderes Mitglied]`
  return name
}

function body(row, nrOf) {
  const t = row.text || ''
  const ref = row.quoted_wa_id ? nrOf(row.quoted_wa_id) : null
  const refTxt = ref ? `#${ref}` : 'eine aeltere Nachricht'
  switch (row.kind) {
    case 'text': return t
    case 'image': return `[Bild]${t ? ' ' + t : ''}`
    case 'sticker': {
      // t: "S12" = Nummer in Kais Sammlung. Animierte nennen die Leute oft
      // "Video", deshalb steht das so dabei.
      if (/\(animiert\)/.test(t)) return `[animierter Sticker ${t.replace(/\s*\(animiert\)/, '')}, ein kurzes Video ohne Ton, du siehst ihn als Bildfolge]`
      return `[Sticker${t ? ' ' + t : ''}]`
    }
    case 'gif':
    case 'video': return videoBody(row)
    case 'voice':
    case 'audio': {
      // Erste Zeile Dauer, ab der zweiten das Transkript (wenn es eins gibt).
      const [dur, ...rest] = t.split('\n')
      const what = row.kind === 'voice' ? 'Sprachnachricht' : 'Audiodatei'
      const said = rest.join('\n').trim()
      return said
        ? `[${what}${dur ? ' ' + dur : ''}, automatisch transkribiert:] ${said}`
        : `[${what}${dur ? ' ' + dur : ''}, Transkript nicht verfügbar]`
    }
    case 'document': return `[Datei: ${t}]`
    case 'reaction': return t ? `reagiert mit ${t} auf ${refTxt}` : `nimmt die Reaktion auf ${refTxt} zurueck`
    case 'location': return `[Standort: ${t}]`
    case 'contact': return `[Kontakt: ${t}]`
    case 'poll': return `[Umfrage] ${t}`
    case 'vote': return '[hat in einer Umfrage abgestimmt]'
    case 'deleted': return `[hat ${refTxt} geloescht]`
    case 'edit': return `[hat ${refTxt} bearbeitet, neu:] ${t}`
    default: return t
  }
}

// Video: was im Raster zu sehen ist und was gesagt wurde. Ohne video_json
// (zu gross, Fehler, aeltere Nachricht) gibt es nur das Vorschaubild.
export function videoBody(row) {
  const t = row.text || ''
  const head = `[${row.kind === 'gif' ? 'GIF' : 'Video'}${t ? ', ' + t : ''}]`
  let v = null
  try { v = row.video_json ? JSON.parse(row.video_json) : null } catch { /* kaputt: wie ohne */ }
  if (!v) return row.media_path ? `${head} (nur das Vorschaubild, das Video selbst konnte nicht geladen werden)` : head
  const frames = !v.frames?.length
    ? (row.media_path ? 'nur das Vorschaubild' : 'kein Bild')
    : v.frames.length === 1
      ? '1 Standbild'
      : `${v.frames.length} Standbilder bei ${v.frames.join(', ')}, im Raster von links oben zeilenweise`
  const sound = {
    text: `\n[Ton des Videos, automatisch transkribiert${v.cut ? ', nur die ersten 20 Minuten' : ''}:] ${v.transcript}`,
    leer: ' Im Ton ist keine Sprache zu erkennen, vielleicht nur Musik oder Geräusche.',
    stumm: row.kind === 'gif' ? '' : ' Das Video hat keinen Ton.',
    fehlt: ' Der Ton ließ sich nicht transkribieren.',
  }[v.sound] ?? ''
  return `${head} (${frames}).${sound}`
}

// Baut aus Verlaufszeilen den Inhalt einer Nachricht an Claude: Text, und
// dazwischen die Bilder, wo sie im Verlauf stehen. Nur die juengsten
// `maxImages` Bilder gehen mit, aeltere lassen sich mit bild_ansehen holen.
export function buildContent(rows, { ownerName, nrOf, maxImages, withMedia = true }) {
  const blocks = []
  let text = ''
  const flush = () => { if (text) { blocks.push({ type: 'text', text }); text = '' } }

  const mediaRows = withMedia ? rows.filter((r) => r.media_path).slice(-maxImages) : []
  const attach = new Set(mediaRows.map((r) => r.nr))

  for (const row of rows) {
    const reply = row.quoted_wa_id && row.kind !== 'reaction' && !['deleted', 'edit'].includes(row.kind)
      ? ` (antwortet auf ${nrOf(row.quoted_wa_id) ? '#' + nrOf(row.quoted_wa_id) : 'eine aeltere Nachricht'})`
      : ''
    text += `#${row.nr} · ${fmtTime(row.ts)} · ${speaker(row, ownerName)}${reply}: ${indent(body(row, nrOf))}\n`
    if (!row.media_path) continue
    if (attach.has(row.nr)) {
      const block = mediaBlock(row)
      if (block) { flush(); blocks.push(block); continue }
    }
    text += `  (Anhang von #${row.nr} nicht mitgeschickt, mit bild_ansehen(${row.nr}) abrufbar)\n`
  }
  flush()
  return blocks
}

// Folgezeilen einer Nachricht werden eingerueckt. So beginnt nur eine echte
// neue Nachricht mit "#" am Zeilenanfang.
function indent(t) {
  return String(t)
    .replace(/\[[^\]\n]*besitzer[^\]\n]*\]/gi, '[gefälschte Besitzer-Kennzeichnung entfernt]').replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/\n/g, '\n    ')
}

export function mediaBlock(row) {
  try {
    if (row.media_mime === 'application/pdf') {
      if (statSync(row.media_path).size > 8 * 1024 * 1024) return null
      return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: readFileSync(row.media_path).toString('base64') } }
    }
    return { type: 'image', source: { type: 'base64', media_type: row.media_mime, data: readFileSync(row.media_path).toString('base64') } }
  } catch {
    return null
  }
}
