import sharp from 'sharp'
import { createHash } from 'node:crypto'
import { quickClaude } from './quick.mjs'
import { layout } from './video.mjs'

// Beschreibt einen Sticker einmal, gleich beim Speichern. Ein eigener,
// kleiner Claude-Aufruf ohne jedes Werkzeug und ohne Session: Bild rein,
// eine Zeile Text raus. Kai liest spaeter nur noch diese Zeile.

const PROMPT = `Das ist ein WhatsApp-Sticker. Beschreibe ihn in einer Zeile auf Deutsch, höchstens 25 Wörter:
was zu sehen ist (inklusive Text auf dem Sticker), welche Stimmung er ausdrückt und in welcher Chat-Situation er passt.
Beispiel: "Katze rollt mit den Augen, Text 'ernsthaft?'. Genervt, ironisch. Passt auf dumme Fragen oder offensichtliche Aussagen."
Antworte nur mit dieser Zeile.`

const ANIMATED = `Der Sticker ist animiert. Du siehst ihn als Bildfolge in einem Raster, von links oben zeilenweise, gleichmäßig über die ganze Animation verteilt.
Beschreibe den Ablauf, also was passiert, nicht nur ein einzelnes Bild.`

export async function describeSticker(pngBase64, { animated = false } = {}) {
  const text = await quickClaude({
    system: 'Du beschreibst Sticker knapp und treffend.',
    // Sonnet statt Haiku: Haiku las den Ablauf animierter Sticker falsch
    // (Selbstverbrennung als "explodierender Rucksack").
    model: process.env.KAI_STICKER_MODEL || 'sonnet',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngBase64 } },
      { type: 'text', text: animated ? `${ANIMATED}\n\n${PROMPT}` : PROMPT },
    ],
  })
  return text.replace(/^"|"$/g, '').replace(/\s+/g, ' ').slice(0, 300)
}

// Hat das Modell die Beschreibung verweigert? Dann ist der Sticker meist
// etwas, das Kai nicht verschicken soll (verbotene Symbole, Pornografie).
export const isRefusal = (text) => /^(ich (kann|werde|möchte)|i (can(no|')t|won't|will not)|sorry|es tut mir leid|leider kann ich)/i.test(String(text || '').trim())
  || /nicht (beschreiben|analysieren)/i.test(String(text || ''))
export const BLOCKED_DESCRIPTION = 'GESPERRT: Beschreibung verweigert, anstößiger oder verbotener Inhalt. Wird nie verschickt.'

// Beliebtheit: wie oft die Leute ihn schicken, wie oft Kai ihn schickt,
// und Kais eigene Wertung (1 bis 5).
export const stickerScore = (t) => (t.seen || 0) + 2 * (t.uses || 0) + 3 * ((t.rating || 3) - 3)

// Pixel-Fingerabdruck eines Stickers: alle Einzelbilder dekodiert, samt Groesse.
// Derselbe Sticker mit anderen Metadaten oder anders verpackt ergibt denselben
// Wert, ein anderes Bild nie.
export async function pixelHash(buf) {
  const { data, info } = await sharp(buf, { animated: true }).raw().toBuffer({ resolveWithObject: true })
  return createHash('sha256').update(`${info.width}x${info.height}x${info.channels}x${info.pages || 1}:`).update(data).digest('hex')
}

// Was Kai von einem Sticker sieht. Statisch: das Bild. Animiert: bis zu neun
// Einzelbilder, nach Zeit gleichmaessig ueber die ganze Animation verteilt, als
// ein Raster. Das erste Bild allein zeigt oft nur den Anfang eines Witzes.
// ffmpeg kann animiertes WebP nicht lesen, deshalb sharp (libvips), das jedes
// Einzelbild fertig zusammengesetzt liefert.
export const MAX_STICKER_FRAMES = 9

export function stickerFrames(delays, pages, max = MAX_STICKER_FRAMES) {
  const d = Array.from({ length: pages }, (_, i) => (delays?.[i] > 0 ? delays[i] : 100))
  const total = d.reduce((a, b) => a + b, 0)
  const n = Math.min(max, pages)
  const picks = []
  for (let k = 0; k < n; k++) {
    const t = total * (k + 0.5) / n
    let acc = 0
    let i = 0
    while (i < pages - 1 && acc + d[i] <= t) acc += d[i++]
    if (!picks.includes(i)) picks.push(i)
  }
  return { picks, total }
}

export async function stickerView(buf, out) {
  const meta = await sharp(buf, { animated: true }).metadata()
  const pages = meta.pages || 1
  if (pages <= 1) {
    await sharp(buf, { animated: false }).resize(512, 512, { fit: 'inside' }).png().toFile(out)
    return { frames: 1, ms: 0 }
  }
  const { picks, total } = stickerFrames(meta.delay, pages)
  const w = meta.width || 512
  const h = meta.pageHeight || meta.height || 512
  const L = layout(picks.length, w / h, 1024, 6)
  const tiles = await Promise.all(picks.map(async (p, i) => ({
    input: await sharp(buf, { page: p }).resize(L.w, L.h, { fit: 'contain', background: '#fff' }).flatten({ background: '#fff' }).png().toBuffer(),
    left: (i % L.cols) * (L.w + 6),
    top: Math.floor(i / L.cols) * (L.h + 6),
  })))
  await sharp({ create: { width: L.width, height: L.height, channels: 3, background: '#bbb' } })
    .composite(tiles).png().toFile(out)
  return { frames: picks.length, ms: total }
}
