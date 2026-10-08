# Kai

**Ein KI-Mitglied für deine WhatsApp-Gruppe.** Kai ist ein ganz normaler
WhatsApp-Kontakt mit eigener Nummer, hinter dem Claude steckt. Er liest mit,
versteht Bilder, Sticker, Sprachnachrichten und Videos, antwortet, wenn man ihn
anspricht, und redet ab und zu auch ungefragt mit, wenn er etwas beizutragen hat.

Du betreibst ihn selbst, auf einem eigenen Rechner, als Docker-Compose-Stack.

## Was Kai kann

- **Mitreden wie ein Mensch:** kurz, locker, auf Deutsch. Er meldet sich bei
  @-Erwähnung, beim Namen „Kai“ oder als Antwort auf seine Nachricht. Sonst
  entscheidet er selbst und schweigt meistens.
- **Sehen und hören:** Bilder, Sticker (auch animierte), PDFs, Videos als
  Standbild-Raster. Sprachnachrichten und Videoton als Transkript (mit
  OpenAI-Schlüssel).
- **Links öffnen und im Netz suchen.**
- **Sticker:** sammelt alle Sticker der Gruppe, schickt passende und macht aus
  Fotos neue, als Meme oder mit freigestellter Person.
- **Zeichnen und Spiele:** Spielbretter, Punktetafeln, Diagramme als Bild. Schach,
  Quiz, Galgenmännchen, was immer jemand vorschlägt.
- **Dateien bearbeiten:** ZIP, PDF, Word, Excel, Audio, Video umwandeln oder
  erzeugen, in einer abgeschotteten Sandbox ohne Internet.
- **Umfragen:** stimmt bei WhatsApp-Umfragen mit ab.
- **Erinnerungen und geplante Aufgaben:** einmal, täglich, werktags, wöchentlich.
- **Gedächtnis:** lernt die Leute, ihre Running Gags und was ankommt. Alles als
  lesbare Markdown-Dateien, pro Gruppe getrennt.
- **Sprachausgabe:** schickt auf Wunsch Sprachnachrichten (mit OpenAI-Schlüssel).

## Was du brauchst

| | |
|---|---|
| **Rechner** | läuft rund um die Uhr, mit Docker und Docker Compose. Homeserver, Mini-PC, Raspberry Pi 5 (64 Bit) oder kleiner Cloud-Server. Etwa 4 GB RAM frei |
| **Zweite Nummer** | eigene SIM oder eSIM mit WhatsApp, nur für Kai. **Nie deine Hauptnummer** |
| **Claude-Abo** | Pro oder Max, dazu einmal Claude Code auf irgendeinem Rechner für den Token |
| **OpenAI-Schlüssel** | optional, für Sprachnachrichten, Videoton und Sprachausgabe. Etwa 0,6 Cent pro Minute |
| **ntfy** | optional, App aufs Handy für Störmeldungen |

## Schnellstart

```bash
# 1. Token erzeugen, auf einem Rechner mit Claude Code
claude setup-token

# 2. Auf dem Rechner, der Kai betreibt
git clone https://github.com/MLoacher/kai-bot.git kai && cd kai
mkdir -p data sandbox-jobs && sudo chown 1000:1000 data sandbox-jobs
cp .env.example .env && chmod 600 .env
nano .env          # mindestens: CLAUDE_CODE_OAUTH_TOKEN, KAI_TOKEN_CREATED,
                   # KAI_PHONE, KAI_OWNER_NUMBER, KAI_OWNER_NAME

# 3. Starten und zuschauen
docker compose up -d --build
docker logs -f kai
```

4. **Koppeln:** Im Log erscheint ein 8-stelliger Code. Auf Kais Telefon unter
   *Einstellungen > Verknüpfte Geräte > Gerät hinzufügen > Stattdessen mit
   Telefonnummer verknüpfen* eingeben.
5. **Gruppe freigeben:** Kai in die Gruppe holen, `docker restart kai`. Das Log
   listet alle Gruppen mit ID. Die ID in `KAI_GROUPS` eintragen,
   `docker compose up -d`.
6. **Testen:** in der Gruppe „Kai, bist du da?“ schreiben.

Ohne Eintrag in `KAI_GROUPS` bleibt Kai still. Das ist Absicht: er antwortet nur
in Gruppen, die du ausdrücklich freigibst, und im Direktchat nur dir.

Alle Einstellungen stehen kommentiert in [.env.example](.env.example).

## Persönlichkeit

Kais Charakter steht in [vorlagen/Soul.md](vorlagen/Soul.md): 25, hilfsbereit,
darf frech sein, schreibt kurz wie ein Mensch im Chat. Beim ersten Kontakt mit
einer Gruppe wird die Vorlage nach `data/Gedaechtnis/<gruppe>/` kopiert, ab dann
entwickelt Kai sie selbst weiter.

Wer einen anderen Charakter will, ändert die Vorlage **vor** dem ersten Start.
Später geht es über die Datei im Gedächtnis-Ordner oder einfach per Direktchat:
„Kai, sei ab jetzt etwas ruhiger.“ Den Kern ändert er nur auf Anweisung des
Besitzers.

## Befehle (nur der Besitzer)

| Befehl | Wirkung |
|---|---|
| `!kai status` | Gruppe, Verlaufslänge, Session, Antworten im Monat |
| `!kai pause` / `!kai weiter` | Kai liest weiter mit, antwortet aber nicht / wieder normal |
| `!kai proaktiv an` / `aus` | Mitreden ohne Ansprache in dieser Gruppe ein- oder ausschalten |
| `!kai neu` | frische Claude-Session für diesen Chat, Verlauf wird neu eingelesen |
| `!kai modell opus` | Modell für diesen Chat wechseln (`opus`, `sonnet`, `haiku`, `standard`) |

Vollständige Liste in [docs/TECHNIK.md](docs/TECHNIK.md).

## Sicherheit in einem Absatz

Kai liest Nachrichten von Leuten, die ihn absichtlich austricksen wollen. Deshalb
sitzen die wichtigen Sperren **im Code, nicht in der KI**: Nur freigegebene
Gruppen und der Besitzer erreichen ihn, der Besitzer wird an der Telefonnummer
erkannt und nie am Namen, und gesendet wird nur in freigegebene Chats. Kai hat
kein Terminal, keinen Dateizugriff und keine Plugins, nur fest programmierte
Werkzeuge. Eine eigene Firewall sperrt das ganze Heimnetz, Code läuft in einer
Sandbox ohne Netz und ohne Schlüssel, und ausgehende Dateien werden auf Schlüssel
geprüft. Einzelheiten in [docs/TECHNIK.md](docs/TECHNIK.md#sicherheit-was-kai-kann-und-was-nicht).

## Ehrlich vorab

- **Baileys ist inoffiziell.** WhatsApp kann solche Nummern sperren. Darum eine
  eigene Nummer.
- **Kai läuft über dein Claude-Abo** und verbraucht dessen Kontingent. Ob die
  Nutzungsbedingungen so einen Dauerbetrieb abdecken, prüfst du selbst.
- **Die Nachrichten der Gruppe gehen an Anthropic** (und Sprachnachrichten an
  OpenAI, falls eingerichtet). Sag das den Leuten in der Gruppe.
- **Der Token gilt ein Jahr.** Kai warnt 30 Tage vorher, wenn `KAI_TOKEN_CREATED`
  gesetzt ist.

## Weiterlesen

- [docs/TECHNIK.md](docs/TECHNIK.md): wie alles funktioniert, Gedächtnis,
  Aufgaben, Sicherheit im Detail, Störmeldungen, Wartung, Dateien
- [vorlagen/](vorlagen/): Startfassung von Persönlichkeit und Gedächtnis
- Tests: `npm install && npm test`
