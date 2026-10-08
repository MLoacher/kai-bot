import { execFile } from 'node:child_process'
import sharp from 'sharp'

// Videos fuer Claude: Claude kann kein Video abspielen und nichts hoeren.
// Deshalb zerlegt ffmpeg das Video in zwei Dinge, die Claude versteht:
//   - Standbilder, gleichmaessig ueber die Laenge verteilt, als ein Raster in
//     einem Bild. Ein Bild statt neun, damit ein Video im Verlauf nur einen
//     Bildplatz belegt.
//   - die Tonspur als kleine Audiodatei, die wie eine Sprachnachricht
//     transkribiert wird. Das liefert gesprochene Worte, keine Geraeusche.

const SHEET = 1568          // Kantenlaenge, die Claude ohnehin verwendet
const GAP = 8
export const MAX_FRAMES = 9
export const MAX_AUDIO_SECONDS = 20 * 60

function run(cmd, args, { timeout = 60_000, maxBuffer = 32 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, maxBuffer, encoding }, (err, stdout, stderr) => {
      if (err) {
        const tail = String(stderr || '').trim().split('\n').slice(-2).join(' ')
        return reject(new Error(`${cmd}: ${err.killed ? 'Zeitlimit' : err.message.split('\n')[0]}${tail ? ' · ' + tail : ''}`))
      }
      resolve(stdout)
    })
  })
}

// Laenge in Sekunden und ob es eine Tonspur gibt.
export async function probe(path) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', path], { timeout: 20_000 })
  const j = JSON.parse(out)
  const types = (j.streams || []).map((s) => s.codec_type)
  return { duration: Number(j.format?.duration) || 0, hasVideo: types.includes('video'), hasAudio: types.includes('audio') }
}

// Wie viele Standbilder: kurze Clips wenige, laengere bis zu neun.
export function frameCount(duration) {
  if (!(duration > 2)) return 1
  return Math.min(MAX_FRAMES, Math.max(4, Math.ceil(duration / 5)))
}

// Zeitpunkte jeweils in der Mitte gleich langer Abschnitte, so fallen weder
// das schwarze erste noch das letzte Bild hinein.
export function frameTimes(duration, n = frameCount(duration)) {
  if (!(duration > 0)) return [0]
  return Array.from({ length: n }, (_, i) => Math.round(duration * (i + 0.5) / n * 10) / 10)
}

// Raster so waehlen, dass die einzelnen Bilder moeglichst gross werden.
// Hochkant-Videos landen dadurch nebeneinander, Querformat untereinander.
export function layout(n, aspect, size = SHEET, gap = GAP) {
  let best = null
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const cellW = (size - gap * (cols - 1)) / cols
    const cellH = (size - gap * (rows - 1)) / rows
    const h = Math.min(cellH, cellW / aspect)
    if (!best || h > best.h + 0.01) best = { cols, rows, h }
  }
  const h = Math.floor(best.h)
  const w = Math.floor(h * aspect)
  return { cols: best.cols, rows: best.rows, w, h, width: best.cols * w + gap * (best.cols - 1), height: best.rows * h + gap * (best.rows - 1) }
}

export const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

async function grab(path, t) {
  return run('ffmpeg', ['-v', 'error', '-threads', '2', '-ss', String(t), '-i', path, '-frames:v', '1', '-vf', 'scale=1024:1024:force_original_aspect_ratio=decrease', '-q:v', '3', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
    { timeout: 30_000, encoding: 'buffer' })
}

// Standbilder als ein JPEG-Raster nach `out`. Liefert die Zeitpunkte, die
// tatsaechlich im Bild sind (von links oben zeilenweise).
export async function contactSheet(path, out, duration) {
  const frames = []
  for (const t of frameTimes(duration)) {
    const buf = await grab(path, t).catch(() => null)
    if (buf?.length) frames.push({ t, buf })
  }
  if (!frames.length) throw new Error('kein Standbild lesbar')
  const meta = await sharp(frames[0].buf).metadata()
  const L = layout(frames.length, (meta.width || 16) / (meta.height || 9))
  const tiles = await Promise.all(frames.map(async (f, i) => ({
    input: await sharp(f.buf).resize(L.w, L.h, { fit: 'contain', background: '#000' }).toBuffer(),
    left: (i % L.cols) * (L.w + GAP),
    top: Math.floor(i / L.cols) * (L.h + GAP),
  })))
  await sharp({ create: { width: L.width, height: L.height, channels: 3, background: '#fff' } })
    .composite(tiles).jpeg({ quality: 82 }).toFile(out)
  return frames.map((f) => f.t)
}

// Tonspur als Mono-Opus, klein genug fuer die Transkription.
export async function extractAudio(path, out) {
  await run('ffmpeg', ['-v', 'error', '-threads', '2', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', '24k', '-t', String(MAX_AUDIO_SECONDS), out], { timeout: 180_000 })
}
