// Letzte Sperre vor dem Versand: nichts, was Kai verschickt, darf einen
// Schluessel enthalten. Geprueft wird gegen die echten Werte, die der
// Prozess kennt, nicht gegen das, was Kai fuer geheim haelt. Dazu ein paar
// Muster, falls ein Schluessel auf anderem Weg in den Text geraten ist.

const SECRET_NAME = /TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{16,}/,          // Anthropic, auch Setup-Token
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/, // OpenAI
  /\btk_[A-Za-z0-9]{20,}/,              // ntfy
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

export function secretValues(env = process.env) {
  const out = new Set()
  for (const [k, v] of Object.entries(env)) {
    if (!SECRET_NAME.test(k) || typeof v !== 'string') continue
    const s = v.trim()
    if (s.length < 12) continue
    out.add(s)
    // Auch ein abgeschnittener Anfang zaehlt.
    if (s.length > 24) out.add(s.slice(0, 24))
  }
  return [...out]
}

// Liefert einen Grund, wenn etwas gefunden wurde, sonst null. Nennt nie den
// Wert selbst, der Grund landet im Log und in der Stoermeldung.
export function findSecret(items, values = secretValues()) {
  for (const item of items) {
    if (item == null) continue
    const s = Buffer.isBuffer(item) ? item.toString('latin1') : String(item)
    if (!s) continue
    if (values.some((v) => s.includes(v))) return 'ein Zugangsschlüssel dieses Servers'
    const p = PATTERNS.find((re) => re.test(s))
    if (p) return 'etwas, das wie ein API-Schlüssel aussieht'
  }
  return null
}
