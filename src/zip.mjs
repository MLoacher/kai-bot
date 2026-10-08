import { crc32, deflateRawSync } from 'node:zlib'

// Ein kleiner ZIP-Schreiber, damit Kai Dateien buendeln kann, ohne eine
// weitere Abhaengigkeit. Deflate, UTF-8-Dateinamen, keine Verschluesselung.

// Pfade im Archiv: nur relative, ohne "..", ohne Laufwerk, ohne Steuerzeichen.
// Liefert null fuer einen Pfad, der sich nicht retten laesst.
export function safeEntryName(p) {
  const parts = String(p || '')
    .replace(/\\/g, '/')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.')
  if (!parts.length || parts.some((s) => s === '..' || /^[a-z]:$/i.test(s))) return null
  const name = parts.join('/')
  return name.length <= 200 ? name : null
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  }
}

// entries: [{ name, data: Buffer }] -> Buffer mit dem fertigen ZIP.
export function createZip(entries, now = new Date()) {
  const { time, date } = dosTime(now)
  const locals = []
  const centrals = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8')
    const packed = deflateRawSync(raw)
    const stored = packed.length >= raw.length
    const body = stored ? raw : packed
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)            // benoetigte Version
    local.writeUInt16LE(0x0800, 6)        // Bit 11: Dateiname in UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)          // erstellt mit
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(stored ? 0 : 8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + body.length
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, end])
}
