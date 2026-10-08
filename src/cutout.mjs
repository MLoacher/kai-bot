import ort from 'onnxruntime-node'
import sharp from 'sharp'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Sticker aus Bildern: ganzes Bild, Ausschnitt oder freigestellt. Freistellen
// macht ein kleines Segmentierungsmodell lokal auf dem Server (onnxruntime,
// CPU). Das kostet nichts, und kein Bild verlaesst dafuer den Server.
//   person: u2net_human_seg, nur Menschen, sauber auch bei Moebeln drumherum
//   objekt: isnet-general-use, das Hauptmotiv, egal was es ist
// Die Modelle laedt der Docker-Build mit Pruefsumme (scripts/models.mjs).

export const MODEL_DIR = process.env.KAI_MODEL_DIR || fileURLToPath(new URL('../models', import.meta.url))
export const MODELS = {
  person: { file: 'u2net_human_seg.onnx', size: 320, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] },
  objekt: { file: 'isnet-general-use.onnx', size: 1024, mean: [0.5, 0.5, 0.5], std: [1, 1, 1] },
}

const sessions = new Map()
async function session(name) {
  if (!sessions.has(name)) {
    const p = join(MODEL_DIR, MODELS[name].file)
    if (!existsSync(p)) throw new Error(`Modell ${MODELS[name].file} fehlt`)
    sessions.set(name, ort.InferenceSession.create(p, { intraOpNumThreads: 2 }))
  }
  return sessions.get(name)
}

// Maske (1 Kanal, 0..255) in der Groesse des Bildes.
export async function segment(rgb, width, height, name) {
  const m = MODELS[name]
  const s = await session(name)
  const { data } = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(m.size, m.size, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true })
  let max = 1
  for (const v of data) if (v > max) max = v
  const n = m.size * m.size
  const t = new Float32Array(3 * n)
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) t[c * n + i] = (data[i * 3 + c] / max - m.mean[c]) / m.std[c]
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', t, [1, 3, m.size, m.size]) })
  const o = out[s.outputNames[0]].data
  let lo = Infinity
  let hi = -Infinity
  for (const v of o) { if (v < lo) lo = v; if (v > hi) hi = v }
  // Das Modell liefert weiche Werte, der Hintergrund bleibt oft leicht grau.
  // Unter 25 % ganz weg, ueber 75 % ganz da, dazwischen weicher Uebergang.
  const u8 = Buffer.alloc(n)
  for (let i = 0; i < n; i++) {
    const v = hi > lo ? (o[i] - lo) / (hi - lo) : 0
    u8[i] = Math.round(Math.min(1, Math.max(0, (v - 0.25) / 0.5)) * 255)
  }
  // extractChannel: sharp macht beim Skalieren sonst drei Kanaele daraus.
  return sharp(u8, { raw: { width: m.size, height: m.size, channels: 1 } })
    .resize(width, height, { fit: 'fill' }).extractChannel(0).raw().toBuffer()
}

// Ausschnitt in Prozent (x, y, breite, hoehe) -> Pixel, auf das Bild begrenzt.
export function cropBox(a, width, height) {
  if (!a) return null
  const x = Math.max(0, Math.min(99, a.x ?? 0))
  const y = Math.max(0, Math.min(99, a.y ?? 0))
  const w = Math.max(1, Math.min(100 - x, a.breite ?? 100 - x))
  const h = Math.max(1, Math.min(100 - y, a.hoehe ?? 100 - y))
  return {
    left: Math.round(x / 100 * width), top: Math.round(y / 100 * height),
    width: Math.max(8, Math.round(w / 100 * width)), height: Math.max(8, Math.round(h / 100 * height)),
  }
}

const esc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])

// Text auf hoechstens zwei Zeilen verteilen, moeglichst gleich lang.
export function wrap(text) {
  const t = text.trim().replace(/\s+/g, ' ')
  if (!t) return []
  if ([...t].length <= 16 || !t.includes(' ')) return [t]
  const words = t.split(' ')
  let best = [t]
  let diff = Infinity
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    const d = Math.abs([...a].length - [...b].length)
    if (d < diff) { diff = d; best = [a, b] }
  }
  return best
}

// Groesste Schrift, bei der die laengste Zeile in 488 px passt.
// Fette DejaVu ist etwa 0,65 Schriftgroessen breit pro Zeichen.
export function fontSize(lines) {
  const longest = Math.max(...lines.map((l) => [...l].length), 1)
  return Math.max(24, Math.min(58, Math.floor(488 / (longest * 0.65))))
}

// Baut den Sticker: 512x512 WebP, transparent, unter 100 kB wie WhatsApp es will.
// modus: 'ganz' | 'person' | 'objekt'. Liefert { webp, preview } oder wirft.
export async function makeSticker(buf, { modus = 'ganz', ausschnitt = null, text = '', textPos = null, rand = true } = {}) {
  let img = sharp(buf, { limitInputPixels: 60_000_000 }).rotate().removeAlpha()
  let { data: rgb, info } = await img.raw().toBuffer({ resolveWithObject: true })
  const box = cropBox(ausschnitt, info.width, info.height)
  if (box) {
    box.width = Math.min(box.width, info.width - box.left)
    box.height = Math.min(box.height, info.height - box.top)
    ;({ data: rgb, info } = await sharp(rgb, { raw: { width: info.width, height: info.height, channels: 3 } })
      .extract(box).raw().toBuffer({ resolveWithObject: true }))
  }
  const { width, height } = info
  let rgba
  if (modus === 'ganz') {
    rgba = await sharp(rgb, { raw: { width, height, channels: 3 } }).ensureAlpha().png().toBuffer()
  } else {
    const mask = await segment(rgb, width, height, modus)
    let covered = 0
    for (const v of mask) if (v > 128) covered++
    if (covered < mask.length * 0.005) throw new Error(modus === 'person' ? 'Keine Person erkannt. Versuch es mit modus "objekt" oder einem Ausschnitt.' : 'Kein Motiv erkannt. Versuch einen Ausschnitt.')
    rgba = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .joinChannel(mask, { raw: { width, height, channels: 1 } }).png().toBuffer()
    // Auf das Motiv zuschneiden, Rest ist durchsichtig.
    rgba = await sharp(rgba).trim({ threshold: 10, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer().catch(() => rgba)
  }

  // Text: "drauf" steht unten im Bild wie bei einem Meme, "unten" darunter.
  // Ohne Angabe: ganzes Bild -> drauf, freigestellt -> unten.
  const pos = text ? (textPos || (modus === 'ganz' ? 'drauf' : 'unten')) : null
  const lines = text ? wrap(String(text).slice(0, 60)) : []
  const size = lines.length ? fontSize(lines) : 0
  const textH = lines.length ? Math.round(lines.length * size * 1.15 + 24) : 0

  const pad = rand ? (modus === 'ganz' ? 10 : 18) : 6
  const reserve = pos === 'unten' ? textH : 0
  let subject = await sharp(rgba).resize(512 - 2 * pad, 512 - 2 * pad - reserve, { fit: 'inside' }).png().toBuffer()
  const sm = await sharp(subject).metadata()
  const left = Math.round((512 - sm.width) / 2)
  const top = pad + Math.round((512 - 2 * pad - reserve - sm.height) / 2)
  const layers = []

  if (modus === 'ganz') {
    // Ganzes Bild: runde Ecken, auf Wunsch weisser Rand drumherum.
    const r = Math.round(Math.min(sm.width, sm.height) * 0.08)
    const round = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${sm.width}" height="${sm.height}"><rect width="${sm.width}" height="${sm.height}" rx="${r}" fill="#fff"/></svg>`)
    subject = await sharp(subject).ensureAlpha().composite([{ input: round, blend: 'dest-in' }]).png().toBuffer()
    if (rand) {
      const W = sm.width + 2 * pad
      const H = sm.height + 2 * pad
      layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" rx="${r + pad}" fill="#fff"/></svg>`), left: left - pad, top: top - pad })
    }
  } else if (rand) {
    // Weisser Rand wie bei echten Stickern: Alpha weichzeichnen und hart schneiden.
    // Rohdaten statt extend(): extend fuellt einen Kanal nicht zuverlaessig mit 0.
    const a = await sharp(subject).extractChannel(3).raw().toBuffer({ resolveWithObject: true })
    const W = a.info.width + 2 * pad
    const H = a.info.height + 2 * pad
    const padded = Buffer.alloc(W * H)
    for (let y = 0; y < a.info.height; y++) a.data.copy(padded, (y + pad) * W + pad, y * a.info.width, (y + 1) * a.info.width)
    const alpha = await sharp(padded, { raw: { width: W, height: H, channels: 1 } }).blur(7).threshold(3).extractChannel(0).raw().toBuffer()
    const white = await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } })
      .joinChannel(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer()
    layers.push({ input: white, left: left - pad, top: top - pad })
  }
  layers.push({ input: subject, left, top })
  if (lines.length) {
    const tspans = lines.map((l, i) => `<tspan x="256" dy="${i ? size * 1.15 : 0}">${esc(l)}</tspan>`).join('')
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="${textH}"><text x="256" y="${12 + size * 0.9}" text-anchor="middle" font-family="DejaVu Sans, sans-serif" font-weight="bold" font-size="${size}" fill="#fff" stroke="#000" stroke-width="${Math.max(5, Math.round(size / 7))}" paint-order="stroke" stroke-linejoin="round">${tspans}</text></svg>`
    const y = pos === 'unten' ? 512 - textH - 2 : Math.min(512 - textH, top + sm.height - textH - 6)
    layers.push({ input: Buffer.from(svg), left: 0, top: Math.max(0, y) })
  }
  const canvas = sharp({ create: { width: 512, height: 512, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers)
  const png = await canvas.png().toBuffer()
  let webp
  for (const quality of [90, 80, 70, 60, 50, 40]) {
    webp = await sharp(png).webp({ quality, alphaQuality: 90, effort: 5 }).toBuffer()
    if (webp.length <= 100 * 1024) break
  }
  const preview = await sharp(png).flatten({ background: '#9e9e9e' }).png().toBuffer()
  return { webp, preview }
}
