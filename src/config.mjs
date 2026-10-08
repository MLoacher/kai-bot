// Alle Einstellungen kommen aus der Umgebung (.env).
// Hier wird nur gelesen und in Form gebracht, nichts entschieden.

const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean)
const digits = (v) => (v || '').replace(/\D/g, '')
const int = (v, d) => (Number.isFinite(parseInt(v, 10)) ? parseInt(v, 10) : d)

export const config = {
  dataDir: process.env.KAI_DATA_DIR || '/data',

  // Wie Kai heisst und worauf er hoert. Der erste Name ist der Anzeigename.
  names: list(process.env.KAI_NAMES || 'Kai'),

  // Gruppen, in denen Kai mitliest und antwortet. Leer = Einrichtungsmodus:
  // Kai listet beim Start alle Gruppen mit ihrer ID auf und bleibt still.
  groups: list(process.env.KAI_GROUPS),

  // Zusaetzlich freigegebene Direktchats, per Telefonnummer (Ziffern mit
  // Laendervorwahl, kommagetrennt). Das sind NICHT der Besitzer: diese Leute
  // koennen mit Kai schreiben, aber keine !kai-Befehle geben und seine Regeln
  // nicht aendern. Leer = nur der Besitzer darf Kai direkt schreiben.
  dmNumbers: list(process.env.KAI_DM_NUMBERS).map((n) => digits(n)).filter(Boolean),

  // Telefonnummer von Kais eigenem WhatsApp-Konto, nur fuer die Erstkopplung
  // per Code statt QR. Nur Ziffern mit Laendervorwahl, z. B. 4915112345678.
  phone: digits(process.env.KAI_PHONE),

  // Der Besitzer: seine Anweisungen haben Vorrang vor allen anderen.
  owner: {
    number: digits(process.env.KAI_OWNER_NUMBER),
    name: process.env.KAI_OWNER_NAME || 'Besitzer',
  },

  // Claude. Standardmodell fuer alle Chats; pro Chat per `!kai modell` ueber-
  // schreibbar (Schluessel `model:<jid>` im kv-Store).
  model: process.env.KAI_MODEL || 'claude-opus-5-5',
  maxTurns: int(process.env.KAI_MAX_TURNS, 20),
  // Hintergrund-Auftraege (Sub-Agenten): laufen nebenlaeufig, damit Kai im Chat
  // ansprechbar bleibt. Begrenzt gegen Token-Ausreiszer.
  subagentMax: int(process.env.KAI_SUBAGENT_MAX, 2), // gleichzeitig pro Chat
  subagentMaxTurns: int(process.env.KAI_SUBAGENT_MAX_TURNS, 40),
  subagentTimeoutMin: int(process.env.KAI_SUBAGENT_TIMEOUT_MIN, 45),
  tokenCreated: process.env.KAI_TOKEN_CREATED || '', // YYYY-MM-DD, fuer die Ablaufwarnung

  // Schutz vor Spam und Endlosschleifen
  maxRunsPerHour: int(process.env.KAI_MAX_RUNS_PER_HOUR, 30),
  // Hoechstens so viele Nachrichten (Text, Sticker, Bild, Reaktion) pro
  // Kalendertag, ueber alle Chats zusammen.
  maxMessagesPerDay: int(process.env.KAI_MAX_MESSAGES_PER_DAY, 300),
  maxImagesPerTurn: int(process.env.KAI_MAX_IMAGES_PER_TURN, 8),
  // Groessere Videos: nur das Vorschaubild.
  videoMaxMb: int(process.env.KAI_VIDEO_MAX_MB, 64),
  // Empfangene Dokumente (zum Bearbeiten in der Sandbox).
  fileMaxMb: int(process.env.KAI_FILE_MAX_MB, 64),
  // Mitreden ohne Ansprache (nur in Gruppen): Kai sieht jede Runde, sobald
  // kurz Ruhe ist, und entscheidet selbst. Wie kurz, haengt vom Chat ab.
  proactive: {
    enabled: (process.env.KAI_PROACTIVE || 'an') !== 'aus',
    // Normalfall: so viele Sekunden nach der letzten Nachricht.
    quietSeconds: int(process.env.KAI_PROACTIVE_QUIET_SECONDS, 8),
    // Nach einer Pause von FRESH_MINUTES kommt etwas Neues: schneller.
    freshSeconds: int(process.env.KAI_PROACTIVE_FRESH_SECONDS, 4),
    freshMinutes: int(process.env.KAI_PROACTIVE_FRESH_MINUTES, 20),
    // Mehrere schreiben gerade schnell hin und her: erst bei einer Pause.
    busySeconds: int(process.env.KAI_PROACTIVE_BUSY_SECONDS, 15),
    // Ist Kai gerade selbst im Gespraech, reagiert er fast sofort.
    followupSeconds: int(process.env.KAI_FOLLOWUP_SECONDS, 3),
    followupMinutes: int(process.env.KAI_FOLLOWUP_MINUTES, 10),
  },
  // Wie viele der Nachrichten seit Kais letzter Antwort er beim Aufwachen
  // mitbekommt. Den Rest liest er bei Bedarf selbst (verlauf_lesen). Was er
  // frueher gesagt und gehoert hat, kennt er ohnehin aus seiner Session.
  maxMessagesPerTurn: int(process.env.KAI_CONTEXT_MESSAGES, 10),
  historyOnNewSession: int(process.env.KAI_HISTORY_ON_NEW_SESSION, 20),

  ntfy: {
    url: process.env.NTFY_URL || '',
    topic: process.env.NTFY_TOPIC || 'kai',
    token: process.env.NTFY_TOKEN || '',
  },
}
