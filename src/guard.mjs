import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

// Jeder in der Gruppe kann Kai bitten, einen Link zu oeffnen. Damit daraus
// kein Weg ins Heimnetz wird, darf Kai nur oeffentliche Adressen abrufen:
// nichts im LAN, nichts im Tailnet, nichts unter den eigenen Domains.
//
// Eigene Domains (die eines Homeservers etwa) kommen aus KAI_BLOCKED_DOMAINS,
// kommagetrennt. Gesperrt ist dann die Domain selbst und alles darunter.

const BLOCKED_SUFFIXES = ['.local', '.lan', '.internal', '.home', '.fritz.box', '.ts.net', '.localhost']

function ownDomains() {
  return (process.env.KAI_BLOCKED_DOMAINS || '').split(',')
    .map((d) => d.trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, ''))
    .filter(Boolean)
}

export function isPrivateIp(ip) {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase()
    if (v === '::' || v === '::1') return true
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7))
    return /^(fc|fd|fe[89ab])/.test(v)
  }
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n))) return true
  const [a, b] = p
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, darin liegt auch Tailscale
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
}

// Liefert null, wenn die URL erlaubt ist, sonst den Grund.
export async function checkUrl(raw, resolve = lookup) {
  let url
  try { url = new URL(raw) } catch { return 'keine gueltige URL' }
  if (!['http:', 'https:'].includes(url.protocol)) return `Protokoll ${url.protocol} nicht erlaubt`
  if (url.username || url.password) return 'Zugangsdaten in der URL nicht erlaubt'
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
  if (!host) return 'kein Hostname'
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return `${host} ist ein internes Ziel`
  if (ownDomains().some((d) => host === d || host.endsWith(`.${d}`))) return `${host} ist ein internes Ziel`
  if (isIP(host)) return isPrivateIp(host) ? `${host} ist eine private Adresse` : null
  if (!host.includes('.')) return `${host} ist kein oeffentlicher Name`
  let addrs
  try { addrs = await resolve(host, { all: true }) } catch { return `${host} laesst sich nicht aufloesen` }
  const bad = addrs.find((a) => isPrivateIp(a.address))
  return bad ? `${host} zeigt auf die private Adresse ${bad.address}` : null
}
