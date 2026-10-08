import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Der komplette Verlauf jeder freigegebenen Gruppe, auch alles, worauf Kai
// nicht antwortet. Daraus baut Kai sich bei jeder Ansprache das Bild, was
// seit seiner letzten Antwort passiert ist.
export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true })
    this.mediaDir = join(dataDir, 'media')
    mkdirSync(this.mediaDir, { recursive: true })
    this.db = new DatabaseSync(join(dataDir, 'kai.db'))
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS messages (
        nr           INTEGER PRIMARY KEY AUTOINCREMENT,
        group_jid    TEXT NOT NULL,
        wa_id        TEXT NOT NULL,
        key_json     TEXT NOT NULL,
        sender_jid   TEXT,
        sender_name  TEXT,
        is_owner     INTEGER NOT NULL DEFAULT 0,
        from_me      INTEGER NOT NULL DEFAULT 0,
        ts           INTEGER NOT NULL,
        kind         TEXT NOT NULL,
        text         TEXT,
        media_path   TEXT,
        media_mime   TEXT,
        quoted_wa_id TEXT,
        UNIQUE (group_jid, wa_id)
      );
      CREATE INDEX IF NOT EXISTS messages_group ON messages (group_jid, nr);
      CREATE TABLE IF NOT EXISTS groups (
        group_jid   TEXT PRIMARY KEY,
        subject     TEXT,
        session_id  TEXT,
        last_nr     INTEGER NOT NULL DEFAULT 0,
        paused      INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS stickers (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        hash        TEXT NOT NULL UNIQUE,
        orig_path   TEXT NOT NULL,   -- webp zum Verschicken
        view_path   TEXT NOT NULL,   -- png zum Ansehen
        animated    INTEGER NOT NULL DEFAULT 0,
        description TEXT,
        uses        INTEGER NOT NULL DEFAULT 0,
        created     INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        group_jid    TEXT NOT NULL,
        creator_jid  TEXT,
        creator_name TEXT,
        instruction  TEXT NOT NULL,
        next_run     INTEGER NOT NULL,   -- Unix-Sekunden
        repeat       TEXT NOT NULL DEFAULT 'einmal',
        created      INTEGER NOT NULL
      );
    `)
    // Spalten, die spaeter dazukamen. Bei bestehenden Datenbanken nachruesten.
    for (const col of ['seen INTEGER NOT NULL DEFAULT 0', 'last_seen INTEGER', 'rating INTEGER']) {
      try { this.db.exec(`ALTER TABLE stickers ADD COLUMN ${col}`) } catch { /* gibt es schon */ }
    }
    // Was aus einem Video wurde: Zeitpunkte der Standbilder, Ton, Transkript.
    try { this.db.exec('ALTER TABLE messages ADD COLUMN video_json TEXT') } catch { /* gibt es schon */ }
    // Umfrage-Daten (Optionen, messageSecret) zum Mitabstimmen.
    try { this.db.exec('ALTER TABLE messages ADD COLUMN poll_json TEXT') } catch { /* gibt es schon */ }
    // Abgegebene Stimmen, eine Zeile pro Waehler und Umfrage (neueste zaehlt).
    this.db.exec(`CREATE TABLE IF NOT EXISTS poll_votes (
      poll_nr   INTEGER NOT NULL,
      voter     TEXT NOT NULL,
      name      TEXT,
      options   TEXT NOT NULL,
      ts        INTEGER NOT NULL,
      PRIMARY KEY (poll_nr, voter)
    )`)
    // Zwei weitere Fingerabdruecke gegen Doppelte: die Datei byte-genau und
    // das Bild pixel-genau (gleicher Sticker, anders verpackt).
    for (const col of ['byte_hash TEXT', 'pixel_hash TEXT', 'blocked INTEGER NOT NULL DEFAULT 0']) {
      try { this.db.exec(`ALTER TABLE stickers ADD COLUMN ${col}`) } catch { /* gibt es schon */ }
    }
  }

  // Liefert die neue Nummer, oder null wenn die Nachricht schon bekannt war.
  addMessage(m) {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO messages
        (group_jid, wa_id, key_json, sender_jid, sender_name, is_owner, from_me, ts, kind, text, media_path, media_mime, quoted_wa_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      m.groupJid, m.waId, JSON.stringify(m.key), m.senderJid ?? null, m.senderName ?? null,
      m.isOwner ? 1 : 0, m.fromMe ? 1 : 0, m.ts, m.kind, m.text ?? null,
      m.mediaPath ?? null, m.mediaMime ?? null, m.quotedWaId ?? null)
    return r.changes ? Number(r.lastInsertRowid) : null
  }

  // Volltextsuche im Verlauf eines Chats, neueste Treffer zuerst.
  search(groupJid, { query, from, to, limit = 30 }) {
    const where = ['group_jid = ?']
    const args = [groupJid]
    if (query) { where.push("(text LIKE ? ESCAPE '\\' OR sender_name LIKE ? ESCAPE '\\' OR video_json LIKE ? ESCAPE '\\')"); const q = `%${query.replace(/[\\%_]/g, (c) => '\\' + c)}%`; args.push(q, q, q) }
    if (from) { where.push('ts >= ?'); args.push(from) }
    if (to) { where.push('ts < ?'); args.push(to) }
    return this.db.prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY nr DESC LIMIT ?`).all(...args, limit).reverse()
  }

  // Ausschnitt um eine Nachricht herum.
  around(groupJid, nr, before = 10, after = 10) {
    return this.db.prepare('SELECT * FROM messages WHERE group_jid = ? AND nr BETWEEN ? AND ? ORDER BY nr').all(groupJid, nr - before, nr + after)
  }

  // Juengster Absender in einem Chat, dessen Name passt (fuer @-Erwaehnungen).
  findSender(groupJid, name) {
    const q = `%${String(name).replace(/[\\%_]/g, (c) => '\\' + c)}%`
    return this.db.prepare(`SELECT sender_jid, sender_name FROM messages
      WHERE group_jid = ? AND from_me = 0 AND sender_jid IS NOT NULL AND sender_name LIKE ? ESCAPE '\\'
      ORDER BY nr DESC LIMIT 1`).get(groupJid, q)
  }

  setText(nr, text) {
    this.db.prepare('UPDATE messages SET text = ? WHERE nr = ?').run(text, nr)
  }

  setPoll(nr, p) {
    this.db.prepare('UPDATE messages SET poll_json = ? WHERE nr = ?').run(JSON.stringify(p), nr)
  }

  // Eine Stimme festhalten: options = Liste der Options-Hashes (hex).
  recordVote(pollNr, voter, name, options, ts) {
    this.db.prepare('INSERT OR REPLACE INTO poll_votes (poll_nr, voter, name, options, ts) VALUES (?, ?, ?, ?, ?)').run(pollNr, voter, name ?? null, JSON.stringify(options), ts)
  }

  votesFor(pollNr) {
    return this.db.prepare('SELECT voter, name, options, ts FROM poll_votes WHERE poll_nr = ?').all(pollNr).map((r) => ({ ...r, options: JSON.parse(r.options) }))
  }

  pollByWaId(groupJid, waId) {
    return this.db.prepare("SELECT * FROM messages WHERE group_jid = ? AND wa_id = ? AND kind = 'poll'").get(groupJid, waId)
  }

  setVideo(nr, v) {
    this.db.prepare('UPDATE messages SET video_json = ? WHERE nr = ?').run(JSON.stringify(v), nr)
  }

  setMedia(nr, path, mime) {
    this.db.prepare('UPDATE messages SET media_path = ?, media_mime = ? WHERE nr = ?').run(path, mime, nr)
  }

  byNr(groupJid, nr) {
    return this.db.prepare('SELECT * FROM messages WHERE group_jid = ? AND nr = ?').get(groupJid, nr)
  }

  nrOf(groupJid, waId) {
    return this.db.prepare('SELECT nr FROM messages WHERE group_jid = ? AND wa_id = ?').get(groupJid, waId)?.nr ?? null
  }

  // Die juengsten `limit` Nachrichten nach `afterNr`, in zeitlicher Reihenfolge.
  since(groupJid, afterNr, limit) {
    return this.db.prepare(`
      SELECT * FROM (SELECT * FROM messages WHERE group_jid = ? AND nr > ? ORDER BY nr DESC LIMIT ?)
      ORDER BY nr`).all(groupJid, afterNr, limit)
  }

  countSince(groupJid, afterNr) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_jid = ? AND nr > ?').get(groupJid, afterNr).n
  }

  // Zeitpunkt der juengsten Nachricht von anderen (fromMe false) oder von Kai.
  lastTs(groupJid, fromMe) {
    return this.db.prepare("SELECT MAX(ts) AS t FROM messages WHERE group_jid = ? AND from_me = ? AND kind NOT IN ('reaction', 'vote', 'deleted', 'edit')").get(groupJid, fromMe ? 1 : 0).t ?? null
  }

  countSinceTs(groupJid, ts) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_jid = ? AND ts >= ?').get(groupJid, ts).n
  }

  latestNr(groupJid) {
    return this.db.prepare('SELECT MAX(nr) AS n FROM messages WHERE group_jid = ?').get(groupJid).n ?? 0
  }

  group(groupJid) {
    this.db.prepare('INSERT OR IGNORE INTO groups (group_jid) VALUES (?)').run(groupJid)
    return this.db.prepare('SELECT * FROM groups WHERE group_jid = ?').get(groupJid)
  }

  updateGroup(groupJid, fields) {
    this.group(groupJid)
    for (const [k, v] of Object.entries(fields)) {
      if (!['subject', 'session_id', 'last_nr', 'paused'].includes(k)) throw new Error(`unbekanntes Feld ${k}`)
      this.db.prepare(`UPDATE groups SET ${k} = ? WHERE group_jid = ?`).run(v, groupJid)
    }
  }

  addTask(t) {
    return Number(this.db.prepare(`
      INSERT INTO tasks (group_jid, creator_jid, creator_name, instruction, next_run, repeat, created)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(t.groupJid, t.creatorJid ?? null, t.creatorName ?? null,
      t.instruction, t.nextRun, t.repeat, Math.floor(Date.now() / 1000)).lastInsertRowid)
  }

  tasks(groupJid) {
    return this.db.prepare('SELECT * FROM tasks WHERE group_jid = ? ORDER BY next_run').all(groupJid)
  }

  dueTasks(now) {
    return this.db.prepare('SELECT * FROM tasks WHERE next_run <= ? ORDER BY next_run').all(now)
  }

  task(groupJid, id) {
    return this.db.prepare('SELECT * FROM tasks WHERE group_jid = ? AND id = ?').get(groupJid, id)
  }

  setTaskRun(id, nextRun) { this.db.prepare('UPDATE tasks SET next_run = ? WHERE id = ?').run(nextRun, id) }
  deleteTask(id) { this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id) }

  // Liefert die ID des Stickers in der Sammlung, neu oder schon vorhanden.
  // Erst nachsehen, dann anlegen: ein fehlgeschlagenes INSERT verbraucht
  // sonst eine Nummer, und die Sammlung sieht groesser aus, als sie ist.
  addSticker({ hash, byteHash = null, pixelHash = null, origPath, viewPath, animated }) {
    const known = this.findSticker({ hash, byteHash, pixelHash })
    if (known) return known.id
    return Number(this.db.prepare(`INSERT INTO stickers (hash, byte_hash, pixel_hash, orig_path, view_path, animated, created) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(hash, byteHash, pixelHash, origPath, viewPath, animated ? 1 : 0, Math.floor(Date.now() / 1000)).lastInsertRowid)
  }

  // Derselbe Sticker, egal an welchem Fingerabdruck er erkannt wird.
  findSticker({ hash = null, byteHash = null, pixelHash = null }) {
    for (const [col, v] of [['hash', hash], ['byte_hash', byteHash], ['pixel_hash', pixelHash]]) {
      if (!v) continue
      const row = this.db.prepare(`SELECT * FROM stickers WHERE ${col} = ? ORDER BY id LIMIT 1`).get(v)
      if (row) return row
    }
    return null
  }

  // Gesperrte Sticker bleiben erkannt (damit sie nicht neu angelegt werden),
  // aber Kai sieht sie nicht in der Liste und kann sie nicht verschicken.
  blockSticker(id, description) { this.db.prepare('UPDATE stickers SET blocked = 1, description = ? WHERE id = ?').run(description, id) }
  isBlockedStickerFile(path) { return Boolean(path && this.db.prepare('SELECT 1 FROM stickers WHERE blocked = 1 AND orig_path = ?').get(path)) }

  setStickerHashes(id, byteHash, pixelHash) {
    this.db.prepare('UPDATE stickers SET byte_hash = ?, pixel_hash = ? WHERE id = ?').run(byteHash, pixelHash, id)
  }

  stickers() { return this.db.prepare('SELECT * FROM stickers ORDER BY id').all() }
  sticker(id) { return this.db.prepare('SELECT * FROM stickers WHERE id = ?').get(id) }
  describeSticker(id, text) { this.db.prepare('UPDATE stickers SET description = ? WHERE id = ?').run(text, id) }
  seeSticker(id, ts) { this.db.prepare('UPDATE stickers SET seen = seen + 1, last_seen = ? WHERE id = ?').run(ts, id) }
  rateSticker(id, rating) { this.db.prepare('UPDATE stickers SET rating = ? WHERE id = ?').run(rating, id) }
  useSticker(id) { this.db.prepare('UPDATE stickers SET uses = uses + 1 WHERE id = ?').run(id) }
  stickerMessages() { return this.db.prepare("SELECT nr, text, ts, from_me, media_path FROM messages WHERE kind = 'sticker' ORDER BY nr").all() }
  setStickerFiles(id, origPath, viewPath) { this.db.prepare('UPDATE stickers SET orig_path = ?, view_path = ? WHERE id = ?').run(origPath, viewPath, id) }

  // Zwei Eintraege sind derselbe Sticker: Zaehler, Beschreibung und Wertung
  // gehen auf den bleibenden, der Verlauf zeigt danach auf ihn.
  mergeSticker(fromId, toId) {
    const a = this.sticker(fromId)
    if (!a || fromId === toId) return
    this.db.prepare(`UPDATE stickers SET seen = seen + ?, uses = uses + ?,
      last_seen = MAX(COALESCE(last_seen, 0), ?), description = COALESCE(description, ?), rating = COALESCE(rating, ?) WHERE id = ?`)
      .run(a.seen || 0, a.uses || 0, a.last_seen || 0, a.description ?? null, a.rating ?? null, toId)
    for (const m of this.db.prepare("SELECT nr, text FROM messages WHERE kind = 'sticker' AND (text = ? OR text LIKE ?)").all(`S${fromId}`, `S${fromId} %`)) {
      this.setText(m.nr, m.text.replace(/^S\d+/, `S${toId}`))
    }
    this.db.prepare('DELETE FROM stickers WHERE id = ?').run(fromId)
  }

  get(k) { return this.db.prepare('SELECT v FROM kv WHERE k = ?').get(k)?.v ?? null }
  set(k, v) { this.db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').run(k, String(v)) }
}
