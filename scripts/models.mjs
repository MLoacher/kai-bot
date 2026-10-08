// Laedt die Segmentierungsmodelle fuer das Freistellen (src/cutout.mjs) beim
// Docker-Build. Mit Pruefsumme: ein veraendertes Modell bricht den Build ab,
// statt still in Kai zu landen.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/'
const MODELS = {
  'u2net_human_seg.onnx': '01eb6a29a5c4d8edb30b56adad9bb3a2a0535338e480724a213e0acfd2d1c73c',
  'isnet-general-use.onnx': '60920e99c45464f2ba57bee2ad08c919a52bbf852739e96947fbb4358c0d964a',
}

const dir = process.argv[2] || 'models'
mkdirSync(dir, { recursive: true })
for (const [file, sha] of Object.entries(MODELS)) {
  const res = await fetch(BASE + file)
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const got = createHash('sha256').update(buf).digest('hex')
  if (got !== sha) throw new Error(`${file}: Pruefsumme falsch (${got})`)
  writeFileSync(join(dir, file), buf)
  console.log(`${file}: ${Math.round(buf.length / 1024 / 1024)} MB, Pruefsumme ok`)
}
