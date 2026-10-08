import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Kais Gedaechtnis ueber Sessions hinweg: eine Datei pro Tag und Gruppe,
// Logs/<gruppe>/YYYY-MM-DD.md. Kai schreibt selbst hinein (Werkzeug
// log_schreiben). Beginnt eine neue Session, liest er die drei neuesten.
// Jede Gruppe hat ihren eigenen Ordner, damit nichts von einer Gruppe in
// die andere wandert.

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/
const MAX_ENTRY = 2000
const MAX_READ = 20_000

export class Logs {
  constructor(dataDir) {
    this.root = join(dataDir, 'Logs')
  }

  dir(groupJid) {
    const d = join(this.root, groupJid.replace(/[^0-9A-Za-z._-]/g, '_'))
    mkdirSync(d, { recursive: true })
    return d
  }

  static today(now = new Date()) {
    const p = (n) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
  }

  append(groupJid, text, now = new Date()) {
    const entry = String(text).trim().slice(0, MAX_ENTRY)
    if (!entry) return 'Leerer Eintrag, nichts geschrieben.'
    const day = Logs.today(now)
    const file = join(this.dir(groupJid), `${day}.md`)
    const time = now.toTimeString().slice(0, 5)
    const head = existsSync(file) ? '' : `# ${day}\n\n`
    appendFileSync(file, `${head}- ${time} ${entry.replace(/\n+/g, ' ')}\n`)
    return `Im Log ${day} notiert.`
  }

  days(groupJid) {
    return readdirSync(this.dir(groupJid)).filter((f) => DAY_FILE.test(f)).sort().map((f) => f.slice(0, 10))
  }

  read(groupJid, day) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
    const file = join(this.dir(groupJid), `${day}.md`)
    return existsSync(file) ? readFileSync(file, 'utf8').slice(-MAX_READ) : null
  }

  // Die drei neuesten Tage, aelteste zuerst, als ein Textblock.
  latest(groupJid, n = 3) {
    const days = this.days(groupJid).slice(-n)
    return days.map((d) => this.read(groupJid, d)).filter(Boolean).join('\n')
  }
}
