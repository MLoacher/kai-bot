import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Kais Langzeitgedaechtnis: Markdown-Dateien pro Gruppe unter
// Gedaechtnis/<gruppe>/. CLAUDE.md ist das Inhaltsverzeichnis, Soul.md die
// Persoenlichkeit; beide stehen in jedem Systemprompt. Die uebrigen Dateien
// liest und pflegt Kai selbst. Beim ersten Mal kommen sie aus vorlagen/.
//
// Jede Ueberschreibung legt vorher eine Kopie in .versionen/ ab. Wer Kai
// dazu bringt, seine Soul umzuschreiben, macht das nicht unwiderruflich.

const TEMPLATES = fileURLToPath(new URL('../vorlagen', import.meta.url))
const NAME = /^[\p{L}\p{N}_-]{1,40}\.md$/u
const MAX_FILES = 30
const MAX_SIZE = 30_000
const KEEP_VERSIONS = 20
export const ALWAYS_LOADED = ['Soul.md', 'CLAUDE.md', 'Personen.md', 'Insider.md', 'Feedback.md']

export class Memory {
  constructor(dataDir, templates = TEMPLATES) {
    this.root = join(dataDir, 'Gedaechtnis')
    this.templates = templates
  }

  dir(groupJid) {
    const d = join(this.root, groupJid.replace(/[^0-9A-Za-z._-]/g, '_'))
    mkdirSync(d, { recursive: true })
    // Fehlende Vorlagen nachlegen, auch in bestehenden Gruppen (etwa eine
    // spaeter eingefuehrte Datei). Vorhandenes wird nie ueberschrieben.
    for (const f of readdirSync(this.templates).filter((f) => NAME.test(f))) {
      if (!existsSync(join(d, f))) copyFileSync(join(this.templates, f), join(d, f))
    }
    return d
  }

  list(groupJid) {
    return readdirSync(this.dir(groupJid)).filter((f) => NAME.test(f)).sort()
  }

  read(groupJid, file) {
    if (!NAME.test(file)) return null
    const p = join(this.dir(groupJid), file)
    return existsSync(p) ? readFileSync(p, 'utf8') : null
  }

  // Liefert eine Rueckmeldung fuer Kai, nie eine Ausnahme.
  write(groupJid, file, content) {
    const check = this.#check(groupJid, file, content.length)
    if (check) return check
    const d = this.dir(groupJid)
    this.#backup(d, file)
    writeFileSync(join(d, file), content.endsWith('\n') ? content : content + '\n')
    return `${file} gespeichert.`
  }

  append(groupJid, file, text) {
    const current = this.read(groupJid, file) ?? `# ${file.slice(0, -3)}\n\n`
    const check = this.#check(groupJid, file, current.length + text.length)
    if (check) return check
    const d = this.dir(groupJid)
    if (!existsSync(join(d, file))) writeFileSync(join(d, file), current)
    appendFileSync(join(d, file), (current.endsWith('\n') ? '' : '\n') + text.trim() + '\n')
    return `${file} ergänzt.`
  }

  #check(groupJid, file, size) {
    if (!NAME.test(file)) return `Ungültiger Dateiname "${file}". Erlaubt: Buchstaben, Ziffern, _ und -, Endung .md.`
    if (size > MAX_SIZE) return `${file} würde zu groß (${size} Zeichen, höchstens ${MAX_SIZE}). Fass zusammen, statt anzuhängen.`
    const files = this.list(groupJid)
    if (!files.includes(file) && files.length >= MAX_FILES) return `Schon ${files.length} Dateien. Leg Themen zusammen, statt neue anzulegen.`
    return null
  }

  #backup(d, file) {
    const p = join(d, file)
    if (!existsSync(p)) return
    const vdir = join(d, '.versionen')
    mkdirSync(vdir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(p, join(vdir, `${file.slice(0, -3)}.${stamp}.md`))
    const old = readdirSync(vdir).filter((f) => f.startsWith(file.slice(0, -3) + '.')).sort()
    for (const f of old.slice(0, Math.max(0, old.length - KEEP_VERSIONS))) rmSync(join(vdir, f))
  }
}
