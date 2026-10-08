import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { randomBytes } from 'node:crypto'

// Kais Seite der Sandbox: Auftraege in den gemeinsamen Ordner legen, auf das
// Ergebnis warten, Ausgabedateien lesen. Der Code selbst laeuft im
// kai-sandbox-Container (ohne Geheimnisse, ohne Netz). Dieser Prozess hier
// fuehrt keinen Fremdcode aus, er schiebt nur Dateien hin und her.

const ROOT = process.env.SANDBOX_DIR || '/sandbox'
const JOBS = join(ROOT, 'jobs')
export const sandboxReady = () => { try { mkdirSync(JOBS, { recursive: true }); return true } catch { return false } }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MAX_INPUT = 64 * 1024 * 1024

// Pfad innerhalb eines Unterordners, ohne Ausbruch (kein .., kein absolut).
function safeRel(base, rel) {
  const p = normalize(join(base, rel))
  return p.startsWith(base + '/') || p === base ? p : null
}

// inputs: [{ name, data: Buffer }]. Liefert { id, ...result }.
export async function runSandbox({ sprache = 'bash', code, timeout = 60, inputs = [] }, { waitMs = 605_000 } = {}) {
  if (!sandboxReady()) return { ok: false, stderr: 'Sandbox nicht verfügbar.', dateien: [] }
  const id = `${Date.now()}-${randomBytes(4).toString('hex')}`
  const dir = join(JOBS, id)
  const work = join(dir, 'work')
  mkdirSync(join(work, 'out'), { recursive: true })
  // Eingabedateien bereitstellen, unter work/ erreichbar fuer den Code.
  for (const f of inputs) {
    const name = String(f.name || '').replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'eingabe'
    const p = safeRel(work, name)
    if (p && f.data) writeFileSync(p, f.data)
  }
  writeFileSync(join(dir, 'job.json'), JSON.stringify({ sprache, code, timeout }))
  writeFileSync(join(dir, '.ready'), '')
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    if (existsSync(join(dir, '.done'))) {
      try { return { id, ...JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) } }
      catch { return { id, ok: false, stderr: 'Ergebnis nicht lesbar.', dateien: [] } }
    }
    await sleep(300)
  }
  return { id, ok: false, stderr: 'Zeitüberschreitung, Sandbox hat nicht geantwortet.', dateien: [] }
}

// Eine Ausgabedatei eines Auftrags lesen (work/out/<pfad>).
export function sandboxFile(id, rel) {
  if (!/^[\w.\-]+$/.test(String(id))) return null
  const base = join(JOBS, id, 'work', 'out')
  const p = safeRel(base, String(rel || ''))
  if (!p || !existsSync(p) || !statSync(p).isFile()) return null
  if (statSync(p).size > MAX_INPUT) return null
  return readFileSync(p)
}

// Aufraeumen: Auftraege, die aelter als `maxAgeMs` sind, loeschen.
export function cleanupSandbox(maxAgeMs = 2 * 3600_000) {
  if (!existsSync(JOBS)) return
  const now = Date.now()
  for (const id of readdirSync(JOBS)) {
    const dir = join(JOBS, id)
    try { if (now - statSync(dir).mtimeMs > maxAgeMs) rmSync(dir, { recursive: true, force: true }) } catch { /* egal */ }
  }
}
