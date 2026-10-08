// Sandbox-Arbeiter: fuehrt beliebigen Code aus, den Kai schickt. Alles
// voellig abgeschottet: dieser
// Prozess laeuft in einem eigenen Container OHNE Geheimnisse und OHNE Netz
// (network: none). Selbst ein voller Einbruch hier findet nichts: keine Token,
// kein Heimnetz, kein Internet, kein Host.
//
// Auftraege kommen ueber einen gemeinsamen Ordner (/sandbox/jobs). Kai legt
// einen Auftrag ab, der Arbeiter fuehrt ihn aus und legt das Ergebnis daneben.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.SANDBOX_DIR || '/sandbox'
const JOBS = join(ROOT, 'jobs')
mkdirSync(JOBS, { recursive: true })

const RUNNERS = {
  python: { cmd: 'python3', arg: (f) => [f], ext: 'py' },
  node: { cmd: 'node', arg: (f) => [f], ext: 'mjs' },
  bash: { cmd: 'bash', arg: (f) => [f], ext: 'sh' },
}
const MAX_OUT_BYTES = 200 * 1024 * 1024
const MAX_LOG = 40_000

// Ein Kindprozess, versprochen. Sammelt stdout/stderr mit Deckel.
function spawnP(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { killSignal: 'SIGKILL', ...opts })
    let out = ''
    let err = ''
    let killed = false
    child.stdout?.on('data', (d) => { if (out.length < MAX_LOG) out += d })
    child.stderr?.on('data', (d) => { if (err.length < MAX_LOG) err += d })
    child.on('error', (e) => { err += `\n[Start fehlgeschlagen: ${e.message}]` })
    child.on('close', (code, signal) => {
      if (signal === 'SIGKILL') killed = true
      resolve({ code, killed, stdout: out.slice(0, MAX_LOG), stderr: err.slice(0, MAX_LOG) })
    })
  })
}

// Ausgabedateien aus work/out einsammeln, mit Groessen-Deckel.
function collectOut(outDir) {
  const files = []
  let total = 0
  const walk = (d, rel) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const r2 = rel ? `${rel}/${name}` : name
      const s = statSync(p)
      if (s.isDirectory()) { walk(p, r2); continue }
      total += s.size
      if (total > MAX_OUT_BYTES) { files.push({ pfad: r2, fehler: 'uebersprungen, Gesamtgroesse zu hoch' }); continue }
      files.push({ pfad: r2, groesse: s.size })
    }
  }
  if (existsSync(outDir)) walk(outDir, '')
  return files
}

const timeoutMs = (job, def, max) => Math.min(Math.max(Number(job.timeout) || def, 1), max) * 1000

// ---- Code-Auftrag (unveraendert in der Wirkung) -----------------------------
async function runCode(job, dir) {
  const r = RUNNERS[job.sprache] || RUNNERS.bash
  const work = join(dir, 'work')
  const scriptName = `programm.${r.ext}`
  writeFileSync(join(work, scriptName), String(job.code || ''))
  const outDir = join(work, 'out')
  mkdirSync(outDir, { recursive: true })
  const res = await spawnP(r.cmd, r.arg(scriptName), {
    cwd: work,
    timeout: timeoutMs(job, 60, 600),
    // Minimale, geheimnisfreie Umgebung. Kein Netz ist ohnehin per Container.
    env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', PYTHONUNBUFFERED: '1' },
  })
  return { ok: res.code === 0 && !res.killed, code: res.code, killed: res.killed, stdout: res.stdout, stderr: res.stderr, dateien: collectOut(outDir) }
}

async function handle(id) {
  const dir = join(JOBS, id)
  try {
    const job = JSON.parse(readFileSync(join(dir, 'job.json'), 'utf8'))
    const result = await runCode(job, dir)
    writeFileSync(join(dir, 'result.json'), JSON.stringify(result))
  } catch (e) {
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ ok: false, stderr: `Arbeiter-Fehler: ${e.message}`, dateien: [] }))
  }
  writeFileSync(join(dir, '.done'), '')
}

const busy = new Set()
async function loop() {
  for (const id of readdirSync(JOBS)) {
    const dir = join(JOBS, id)
    if (busy.has(id)) continue
    if (!existsSync(join(dir, '.ready')) || existsSync(join(dir, '.done'))) continue
    busy.add(id)
    handle(id).finally(() => busy.delete(id))
  }
}
setInterval(loop, 300)
console.log('[sandbox] Arbeiter bereit, wartet auf Auftraege in', JOBS)
