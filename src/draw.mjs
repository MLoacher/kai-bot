import sharp from 'sharp'

// Kai zeichnet: er schreibt SVG, der Code macht daraus ein PNG. Damit baut er
// sich Spielbretter, Punktetafeln, Diagramme oder Memes selbst, ohne dass es
// fuer jedes Spiel ein eigenes Werkzeug braucht. Kostet nichts.
//
// SVG kann Dateien nachladen, auch vom Server selbst. Deshalb wird hier
// abgelehnt statt repariert: Kai soll lernen, was geht, statt dass ein Filter
// halb durchlaesst. Erlaubt sind Verweise nur innerhalb des SVG ("#id") und
// Bilder aus dem Verlauf dieses Chats, die der Code selbst einsetzt.

export const SVG_MAX = 400 * 1024
const OUT_MAX = 1600

const FORBIDDEN = [
  [/<!/, 'keine <!DOCTYPE>- oder <!ENTITY>-Angaben'],
  [/<\?(?!xml\s)/i, 'keine Verarbeitungsanweisungen'],
  [/<\s*script/i, 'kein <script>'],
  [/<\s*foreignObject/i, 'kein <foreignObject>'],
  [/<\s*xi:include|xinclude/i, 'kein XInclude'],
  [/@import/i, 'kein @import'],
  [/\b(file|https?|ftp|data|javascript):/i, 'keine Adressen (http, file, data …), alles muss im SVG selbst stehen'],
]

// Liefert { svg } mit eingesetzten Verlaufsbildern, oder { error }.
// images: nr -> { data: Buffer, mime } fuer "verlauf:<nr>"-Verweise.
export function checkSvg(svg, images = new Map()) {
  const s = String(svg || '').trim()
  if (!s) return { error: 'Das SVG ist leer.' }
  if (s.length > SVG_MAX) return { error: `Zu groß (${Math.round(s.length / 1024)} kB, höchstens ${SVG_MAX / 1024} kB).` }
  if (!/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(s)) return { error: 'Muss mit <svg …> beginnen.' }
  // Die beiden Standard-Namensraeume sind Adressen, laden aber nichts. Nur
  // genau diese beiden werden fuer die Pruefung herausgenommen.
  const probe = s.replace(/\s(?:xmlns|xmlns:xlink)\s*=\s*(["'])(?:http:\/\/www\.w3\.org\/2000\/svg|http:\/\/www\.w3\.org\/1999\/xlink)\1/g, '')
  for (const [re, why] of FORBIDDEN) if (re.test(probe)) return { error: `Nicht erlaubt: ${why}.` }
  // Jeder Verweis: nur "#id" oder "verlauf:<nr>".
  for (const m of s.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gis)) {
    const v = m[2].trim()
    if (v.startsWith('#')) continue
    if (/^verlauf:\d+$/.test(v) && images.has(Number(v.slice(8)))) continue
    return { error: `Verweis "${v.slice(0, 60)}" nicht erlaubt. Erlaubt sind "#id" und "verlauf:<nr>" für ein Bild aus diesem Chat.` }
  }
  for (const m of s.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    if (!m[2].trim().startsWith('#')) return { error: `url(${m[2].slice(0, 60)}) nicht erlaubt, nur url(#id).` }
  }
  // Verlaufsbilder erst nach der Pruefung einsetzen, als data:-Adresse.
  let out = s.replace(/\b((?:xlink:)?href\s*=\s*)(["'])verlauf:(\d+)\2/gi, (_, attr, q, nr) => {
    const img = images.get(Number(nr))
    return `${attr}${q}data:${img.mime};base64,${img.data.toString('base64')}${q}`
  })
  // Ohne Namensraum zeichnet librsvg nichts.
  if (!/<svg[^>]*\sxmlns\s*=/.test(out)) out = out.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  if (out.includes('xlink:href') && !/xmlns:xlink\s*=/.test(out)) out = out.replace(/<svg/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"')
  return { svg: out }
}

// SVG -> PNG, hoechstens 1600 px an der laengeren Seite.
export async function renderSvg(svg) {
  const img = sharp(Buffer.from(svg), { density: 144, limitInputPixels: 64_000_000 })
  const meta = await img.metadata()
  if (!meta.width || !meta.height) throw new Error('SVG ohne Größe, width/height oder viewBox angeben')
  return img
    .resize(OUT_MAX, OUT_MAX, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .png()
    .toBuffer()
}
