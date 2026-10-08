# Kai

> Ein KI-Mitglied fuer WhatsApp-Gruppen, gebaut mit Claude. Selbst gehostet, ein Docker-Compose-Stack.

Ein Mitglied in WhatsApp-Gruppen, hinter dem Claude steckt. Kai liest den kompletten Verlauf mit, versteht Bilder, Sticker, Emojis und Reaktionen, oeffnet Links und antwortet, wenn man ihn anspricht.

Drei Container: **kai** (die Bruecke, mit Geheimnissen und WhatsApp), **kai-firewall** (Netz-Huelle, sperrt das Heimnetz) und **kai-sandbox** (fuehrt Kais Datei-Code aus, ohne Geheimnisse und ohne Netz).

**Netzschutz:** Kai teilt sich den Netz-Namespace mit `kai-firewall` (`network_mode: service:kai-firewall`). Die Firewall sperrt per iptables das ganze Heimnetz (192.168/16, 10/8, 172.16/12, 169.254/16, 100.64/10), oeffentliches Web geht raus. So kann niemand Kai aus einer Gruppe dazu bringen, das Heimnetz anzugreifen. Default ist ACCEPT (fail-open fuer Erreichbarkeit), die privaten Bereiche werden gezielt per REJECT gesperrt; der app-seitige Link-Schutz bleibt zusaetzlich.

Keine Weboberflaeche, kein offener Port. Das Image wird lokal gebaut, Updates sind eine bewusste Entscheidung.

## Wie es funktioniert

```
WhatsApp-Gruppe  <->  Baileys (verknuepftes Geraet, wie WhatsApp Web)
                        |
                        v
                 kai.db: jede Nachricht, jeder Anhang
                        |
         angesprochen?  v
                 Claude Agent SDK (Claude Code, angemeldet per Setup-Token)
                 eine dauerhafte Session pro Gruppe
```

- **Wer Kai ueberhaupt erreicht** entscheidet fest im Code eine Tuer ([src/gate.mjs](src/gate.mjs)), bevor irgendetwas gespeichert, geladen oder an Claude gegeben wird: nur Gruppen aus `KAI_GROUPS` und Direktnachrichten von `KAI_OWNER_NUMBER` (per Telefonnummer, auch wenn WhatsApp den Chat unter einer LID fuehrt). Fremde Gruppen, Direktnachrichten anderer, Status und Kanaele werden verworfen, ohne Spur. Im Direktchat antwortet Kai auf jede Nachricht des Besitzers.
- **Wann Kai antwortet:** @-Erwaehnung, Antwort auf eine seiner Nachrichten, oder sein Name als eigenes Wort (`Kai`, `kai`, `,Kai.`, `@kai`; nicht `Kaiser`). Weitere Namen ueber `KAI_NAMES`.
- **Mitreden ohne Ansprache (nur Gruppen):** Kai sieht jede Unterhaltungsrunde und entscheidet selbst, ob er etwas sagt. **Ist er gerade im Gespraech** (seine letzte Nachricht ist juenger als 10 Minuten und hoechstens 6 Nachrichten her), schaut er nach 3 Sekunden hin und greift Folgefragen wie "echt? und was sagt der Trainer dazu?" auch ohne seinen Namen auf (`KAI_FOLLOWUP_SECONDS`, `KAI_FOLLOWUP_MINUTES`). **Sonst** haengt die Wartezeit vom Chat ab, und jede neue Nachricht startet sie neu: Kommt nach mindestens 20 Minuten Stille etwas Neues (hoechstens drei Nachrichten), schaut er nach **4 Sekunden** hin, auch nach Stunden oder Tagen, und bekommt dazu gesagt, wie lange es still war (`KAI_PROACTIVE_FRESH_SECONDS`, `KAI_PROACTIVE_FRESH_MINUTES`). Schreiben gerade mehrere schnell hin und her (3 Nachrichten in 60 Sekunden), wartet er auf **15 Sekunden** Pause, damit er nicht mitten hineinplatzt (`KAI_PROACTIVE_BUSY_SECONDS`). Sonst nach **8 Sekunden** Ruhe (`KAI_PROACTIVE_QUIET_SECONDS`). Meistens schweigt er. Mitreden soll er etwa, wenn jemand auf seine Frage antwortet, eine offene Frage in die Runde geht oder nach langer Stille ein Bild kommt, auf das niemand reagiert. Reihenfolge im Code: Tuer, Tageslimit, dann Kai. Abschalten pro Gruppe mit `!kai proaktiv aus`, fuer alle mit `KAI_PROACTIVE=aus`. Das Stundenlimit zaehlt nur echte Ansprachen.
- **Was Kai sieht:** Mitgeschrieben wird alles. Beim Aufwachen bekommt Kai die letzten 10 Nachrichten seit seiner letzten Antwort (`KAI_CONTEXT_MESSAGES`), als Verlauf mit Nummern (`#123`), Absender und Uhrzeit. Bilder und Sticker stehen als Bild an ihrer Stelle, Videos und GIFs als Raster aus Standbildern, PDFs als Dokument. Braucht er mehr, liest er mit `verlauf_lesen` weiter zurueck. Was er frueher mit den Leuten besprochen hat, kennt er aus seiner dauerhaften Session.
- **Sprachnachrichten:** werden ueber die OpenAI-API transkribiert (`OPENAI_API_KEY`, Modell `gpt-4o-transcribe`) und stehen als Text an ihrer Stelle im Verlauf. Das Audio geht dafuer an OpenAI, der Schluessel bleibt im Bruecken-Prozess. Auch ein gesprochenes "Kai" weckt ihn.
- **Videos:** ffmpeg (im Image) zerlegt jedes neue Video in zwei Teile, die Claude versteht:
  - **Bild:** 1 bis 9 Standbilder, gleichmaessig ueber die Laenge verteilt, als *ein* Raster (hoechstens 1568 px), damit ein Video nur einen Bildplatz belegt. Die Zeitpunkte stehen in der Verlaufszeile. Hochkant-Videos liegen nebeneinander, Querformat untereinander.
  - **Ton:** die Tonspur als Mono-Opus, transkribiert wie eine Sprachnachricht, hoechstens die ersten 20 Minuten. Das ergibt gesprochene und gesungene Worte, **keine Geraeusche oder Musik**. Ein gesprochenes "Kai" im Video weckt ihn bewusst nicht.
  - Das Video selbst wird danach geloescht, es bleiben Raster und Transkript. Ueber `KAI_VIDEO_MAX_MB` (Standard 64), bei Fehlern und fuer Videos aus dem nachgeladenen Verlauf gibt es nur das Vorschaubild. Kommt eine Ansprache, waehrend ein Video noch zerlegt wird, wartet Kai darauf, hoechstens fuenf Minuten.
- **Sticker aus Fotos (`sticker_erstellen`):** Aus einem Bild im Chat wird ein echter WhatsApp-Sticker: 512×512 WebP, transparent, unter 100 kB. Es gibt zwei Arten. **Meme-Sticker** (`ganz`) nehmen das ganze Bild oder einen Ausschnitt, mit runden Ecken und dem Spruch unten im Bild. **Ausgeschnitten** (`person` oder `objekt`) entfernt den Hintergrund, der Spruch steht darunter, mit weißem Rand. Wer fragt, kann die Art bestimmen, sonst wählt Kai. Freigestellt wird lokal mit onnxruntime (CPU, MIT-Lizenz): `u2net_human_seg` für Menschen, `isnet-general-use` für beliebige Motive. Der Docker-Build lädt beide Modelle (je rund 170 MB) mit Prüfsumme über [scripts/models.mjs](scripts/models.mjs). `ORT_DISABLE_TELEMETRY=1` ist gesetzt, weil onnxruntime sonst versucht, Telemetrie per HTTPS zu senden. Ein Sticker dauert etwa 1 bis 5 Sekunden, der Speicher geht dabei auf rund 900 MB, deshalb `mem_limit: 2g`. Der verschickte Sticker landet über den eigenen Verlauf in der Sammlung.
- **Dateien bearbeiten & Code (`code_ausfuehren`, `datei_aus_sandbox`):** Kai kann empfangene Dateien (ZIP, PDF, Word, Excel, Bilder, Audio, Video, …) bearbeiten, umwandeln, auslesen oder neue erzeugen, indem er Python/Node/Bash schreibt. Der Code läuft **nicht** in Kais Prozess, sondern im getrennten Container **kai-sandbox**: `network_mode: none` (kein Internet, kein Heimnetz), **keine** Geheimnisse in der Umgebung, read-only, `cap_drop ALL`, `no-new-privileges`, eigener Nutzer, Limits. Austausch nur über den geteilten Ordner `/opt/docker/kai/sandbox`. Selbst ein voller Einbruch dort findet nichts: keine Token, kein Netz, kein Host. Vorinstalliert: ffmpeg, imagemagick, zip/unzip, poppler, python3 (pypdf, pdfplumber, python-docx, openpyxl, Pillow, pandas, reportlab), node (sharp). Ausgaben landen in `out/` und werden mit `datei_aus_sandbox` als Datei/Bild/Video/Audio geschickt, weiterhin durch Schlüsselsperre und Tür. Empfangene Dokumente werden bis `KAI_FILE_MAX_MB` (64) gespeichert.
- **Zeichnen (`bild_zeichnen`):** Kai schreibt SVG, sharp macht daraus ein PNG (hoechstens 1600 px). Damit baut er sich Spielbretter fuer jedes Spiel, das jemand vorschlaegt, dazu Punktetafeln, Diagramme, Infografiken und Memes, auch auf einem Bild aus dem Chat (`href="verlauf:<nr>"`). Das kostet nichts. Den Spielstand fuehrt er selbst in einer Gedaechtnisdatei. Das fertige Bild bekommt er zurueck, mit `nur_vorschau` auch vorher. [src/draw.mjs](src/draw.mjs) **lehnt ab statt zu reparieren**: kein DOCTYPE/ENTITY, kein Script, kein foreignObject, kein @import, keine Adresse (http, file, data, …), Verweise nur `#id` oder `verlauf:<nr>`, `url()` nur `#id`. Verlaufsbilder setzt erst der Code nach der Pruefung als data:-Adresse ein. Grund: SVG kann Dateien nachladen, auch `/data/.env`. Das SVG laeuft zusaetzlich durch die Schluesselsperre. B. `lab-paper-duck`, hunderte Pfade) mit `code_ausfuehren` als Vorlage ausliest und daraus sein eigenes SVG formt — gleicher Stil, ohne KI-Bildgenerator.
- **Profilbild (`profilbild_setzen`):** Kai ändert sein eigenes WhatsApp-Profilbild, aus einem Bild im Chat (`nr`) oder einem selbst gezeichneten SVG (`svg`, gleiche Prüfung wie `bild_zeichnen`), mittig auf ein Quadrat beschnitten (640×640 JPEG) via Baileys `updateProfilePicture`. Prompt und Hinweis schärfen ein: mit Bedacht, wenn der Besitzer es will oder es klar passt — nicht auf bloßen Zuruf eines Fremden, denn es ist Kais Gesicht für alle.
- **Sprache erzeugen (`sprache_erzeugen`):** Kai macht aus Text gesprochene Sprache (OpenAI-TTS, [src/tts.mjs](src/tts.mjs), Gegenstück zu `transcribe.mjs`). `als "sprachnachricht"` schickt eine WhatsApp-Sprachnachricht (Ogg/Opus, ptt); `als "datei"` ein MP3 zum Herunterladen, z. B. als Erklär-Ton, den man in ein Video einbaut. Stimme wählbar (OpenAI-Stimmen), Grundton **professionell und eher zügig** (nicht langsam/monoton) über eine Stil-Anweisung an `gpt-4o-mini-tts` (`DEFAULT_STYLE`), per `stil` überschreibbar. Läuft in der **Bridge** (nicht der Sandbox: TTS braucht einen API-Aufruf), nutzt denselben `OPENAI_API_KEY` wie die Transkription — der Schlüssel bleibt im Bridge-Prozess, der Claude-Prozess sieht ihn nie. Modell per `KAI_TTS_MODEL` (Standard `gpt-4o-mini-tts`). *(Narration direkt in ein von Kai gerendertes Video zu legen, ist der nächste Schritt — hängt am offenen Punkt „Chat-Medien in den Render".)*
- **Hintergrund-Aufträge / Sub-Agenten (`auftrag_starten`, `auftrag_status`, `auftrag_abbrechen`, `auftrag_antwort`):** Länger dauernde Arbeit (ein Video mit ffmpeg schneiden, ein grosses Dokument bauen, mehrstufige Recherche) blockiert den Chat nicht mehr. Kais Durchgänge laufen **pro Chat seriell**; eine lange Aufgabe würde sonst den Chat festhalten. `auftrag_starten` legt stattdessen einen **Sub-Agenten** an ([src/agent.mjs](src/agent.mjs) `runSubagent`), der **nebenläufig** als eigener Claude-Lauf in Kais Prozess arbeitet (eigener, eingeschränkter Werkzeugsatz: Sandbox-Code, Rendern als Datei, Veröffentlichen, Verlauf/Gedächtnis lesen, WebFetch/WebSearch, `frage_an_mensch`). Kais Turn kehrt sofort zurück, der Chat bleibt ansprechbar. Der Sub-Agent **sendet selbst nichts** in WhatsApp: Ist er fertig oder hat eine Rückfrage, weckt er Kai über den normalen Scheduler ([src/main.mjs](src/main.mjs), `schedule`/`subagentNote`), und **Kai** liefert Ergebnis/Frage durch die eine Tür (`send`). Antworten reicht Kai mit `auftrag_antwort` zurück; ändert sich die Aufgabe, bricht er mit `auftrag_abbrechen` ab und startet neu. Erzeugte Dateien meldet der Sub-Agent mit `ergebnis_anhaengen` an, Kai schickt sie per `datei_aus_sandbox`. Grenzen: höchstens `KAI_SUBAGENT_MAX` (2) gleichzeitig pro Chat, `KAI_SUBAGENT_MAX_TURNS` (40) Schritte, `KAI_SUBAGENT_TIMEOUT_MIN` (45) Minuten. Nur im Speicher: ein Kai-Neustart verwirft laufende Aufträge (die Sandbox-Jobs selbst überleben). Abschottung unverändert: der Sub-Agent hat denselben Token wie Kai, aber keinen eigenen WhatsApp-Versand und keine weiteren Rechte; schwere/fremde Eingaben laufen weiter nur in der netz- und geheimnislosen Sandbox.
- **Umfragen (`umfrage_abstimmen`):** Kai stimmt bei WhatsApp-Umfragen selbst mit, seine Stimme zählt sichtbar wie jede andere. WhatsApp verschlüsselt jede Stimme mit dem `messageSecret` der Umfrage; Baileys 7 kann Stimmen nur lesen, nicht senden, deshalb baut [src/poll.mjs](src/poll.mjs) die verschlüsselte Stimme selbst, spiegelbildlich zu Baileys' `decryptPollVote` (gegen dessen Entschlüsselung getestet). Das `messageSecret` wird beim Empfang der Umfrage gespeichert (`poll_json`), für Umfragen aus der Zeit davor fehlt es, dann kann Kai nicht mitstimmen.
- **Was Kai tun kann:** Text schreiben (mit Emojis und Links), per Emoji reagieren, einen Sticker aus dem Verlauf zurueckschicken, ein Bild von einer oeffentlichen URL schicken, Links oeffnen, im Netz suchen.
- **Besitzer:** allein ueber die **Absendernummer** (`KAI_OWNER_NUMBER`), nie ueber den Namen. `KAI_OWNER_NAME` ist nur Anzeige. Im Verlauf traegt nur der Besitzer die Kennzeichnung `[BESITZER, per Nummer geprueft]`. Anzeigenamen anderer werden entschaerft (keine Klammern, kein "Besitzer"), wer so aehnlich heisst wie der Besitzer, bekommt `[NICHT der Besitzer]` dazu, eine in den Text getippte Kennzeichnung wird entfernt, und Folgezeilen mehrzeiliger Nachrichten sind eingerueckt, damit sich keine Verlaufszeile faelschen laesst. Seine Anweisungen haben Vorrang, nur er kann Kais Regeln aendern, nur er kann die `!kai`-Befehle geben und wiederkehrende Aufgaben anlegen.
- **Laeuft eine Antwort noch,** sammeln sich weitere Ansprachen und werden danach in einem Durchgang beantwortet.

### Gedaechtnis

Die Session einer Gruppe bleibt dauerhaft offen, Kai muss sich also nicht bei jeder Ansprache neu einlesen. Fuer den Fall, dass doch einmal eine neue Session beginnt (`!kai neu`, kaputte Session, Server neu aufgesetzt), fuehrt Kai selbst Tagebuch:

- `data/Logs/<gruppe>/YYYY-MM-DD.md`, eine Datei pro Tag und Gruppe
- Kai schreibt selbst hinein (`log_schreiben`): Vorlieben der Leute, Abmachungen, laufende Themen, Anweisungen vom Besitzer, eigene Fehler
- Neue Session: Kai bekommt die **drei neuesten Logs** und die **letzten 20 Nachrichten** mit Bildern mit. Aeltere Tage liest er bei Bedarf (`log_lesen`)
- Unabhaengig davon liegt jede Nachricht in `kai.db`, auch die, auf die Kai nie geantwortet hat

Dazu ein **Langzeitgedaechtnis** als Markdown-Dateien, `data/Gedaechtnis/<gruppe>/`, beim ersten Mal aus [vorlagen/](vorlagen/) angelegt:

| Datei | Inhalt |
|---|---|
| `CLAUDE.md` | Inhaltsverzeichnis und Regeln fuer den Ordner. **Immer** im Systemprompt |
| `Soul.md` | Kais Persoenlichkeit, erster Entwurf vom Besitzer. **Immer** im Systemprompt |
| `Personen.md` | Profil pro Person: Anrede, wie sie mit Kai redet, Humor, was sie mag, was nicht geht, Eigenheiten. **Immer** im Systemprompt |
| `Insider.md` | Running Gags, Spitznamen, Anspielungen. **Immer** im Systemprompt, damit Kai sie gezielt einsetzen kann |
| `Abmachungen.md` | Vereinbarungen, Regeln, Anweisungen des Besitzers |
| `Setup.md` | wie Kai gebaut ist und wie man ihn nachbaut, zum Erklaeren in der Gruppe. Ohne Zugangsdaten, Nummern und Servernamen; den Code verspricht Kai nicht |
| `Feedback.md` | Rueckmeldungen zu Kais Verhalten, direkt oder indirekt ("schlechter Witz", 🙄 auf seine Nachricht), mit Gewicht: Einzelmeinung (leicht anpassen), Muster (feste Lehre), Besitzer (gilt sofort). **Immer** im Systemprompt |

Kai liest und pflegt die Dateien selbst (`gedaechtnis_lesen`, `gedaechtnis_ergaenzen`, `gedaechtnis_schreiben`) und legt neue an, wenn ein Thema eigenes Gewicht bekommt. Die Soul darf er weiterentwickeln, den Kern nur auf Anweisung des Besitzers. Jede Ueberschreibung sichert die alte Fassung in `.versionen/` (die letzten 20 je Datei), jede Aenderung an `Soul.md` steht zusaetzlich im Tageslog mit dem Namen dessen, der sie angestossen hat. Grenzen: 30 Dateien, 30 000 Zeichen je Datei.

Soul zuruecksetzen: gewuenschte Fassung aus `.versionen/` ueber `Soul.md` kopieren, oder `vorlagen/Soul.md`. Die Aenderung gilt ab der naechsten Antwort, ohne Neustart.

Die Vorlagen gelten nur fuer **neue** Gruppen. Eine Aenderung an `vorlagen/Soul.md` erreicht eine laufende Gruppe nicht; dort die Datei direkt bearbeiten oder Kai im Chat sagen.

### Geplante Aufgaben

"Kai, weck mich morgen um 7 mit den groessten KI-News" legt eine Aufgabe an (`aufgabe_planen`). Die Bruecke prueft alle 30 Sekunden, was faellig ist, weckt Kai mit dem Auftrag, und seine Antwort geht in die Gruppe. Wer die Aufgabe angelegt hat, wird darin erwaehnt, das Handy klingelt also.

- Wiederholungen: `einmal`, `taeglich`, `werktags`, `woechentlich`. Wiederkehrende darf **nur der Besitzer** anlegen
- Hoechstens 20 Aufgaben pro Gruppe, hoechstens 3 offene pro Person (Besitzer ausgenommen)
- Loeschen darf der Ersteller oder der Besitzer
- War der Server zur faelligen Zeit aus, wird bis zu 12 Stunden nachgeholt, danach verfaellt die Aufgabe mit ntfy-Meldung

Die eingebauten geplanten Aufgaben von Claude Code gehen hier nicht: sie leben nur, solange eine Session laeuft, und Kais Session laeuft nur fuer die Dauer einer Antwort.

### Auftraege aus dem Direktchat

Im Direktchat kann der Besitzer Kai bitten, in einer freigegebenen Gruppe etwas zu fragen ("frag in der Familiengruppe mal Tom, wie weit das Angebot ist"). Kai schreibt das mit `in_gruppe_schreiben` **aus eigener Sicht**, ohne zu erwaehnen, dass der Auftrag vom Besitzer kommt, auf Wunsch mit @-Erwaehnung einer Person. Danach wartet er dort 24 Stunden auf die Antwort. Geweckt wird er dafuer nicht zusaetzlich: antwortet die Person auf seine Nachricht oder spricht ihn an, wacht er wie immer auf, sieht den offenen Auftrag und meldet die Antwort mit `besitzer_informieren` privat zurueck.

Festgelegt im Code, nicht im Prompt: `in_gruppe_schreiben` geht nur, wenn der Auftrag nachweislich aus dem Direktchat des Besitzers kommt, und nur in freigegebene Gruppen. `besitzer_informieren` schickt hoechstens 20 Nachrichten pro Gruppe und Tag.

### Stickersammlung

Jeder Sticker aus einem freigegebenen Chat landet automatisch in Kais Sammlung (Tabelle `stickers` in `kai.db`, Dubletten ueber die Dateipruefsumme von WhatsApp erkannt). Im Verlauf steht er als `[Sticker S12]`.

- **Einmal beschreiben, nie wieder hinsehen:** Beim Speichern beschreibt ein eigener kleiner Claude-Aufruf (Modell `KAI_STICKER_MODEL`, Standard `sonnet`, ohne Werkzeuge, ohne Session) den Sticker in einer Zeile: Motiv, Text, Stimmung, wann er passt. **Animierte Sticker** sieht er dabei als Bildfolge ueber die ganze Animation (bis zu 9 Bilder nach Zeit verteilt, als Raster; sharp, weil ffmpeg animiertes WebP nicht lesen kann), damit der Ablauf in der Beschreibung steht und nicht nur das erste Bild. Dieselbe Bildfolge sieht Kai im Verlauf. Wird eine Beschreibung verweigert, ist der Sticker gesperrt: nicht in der Liste, und `send()` laesst ihn auf keinem Weg raus. Kai liest danach nur noch diese Zeile. Die Sammlung kann also beliebig gross werden.
- **Beliebtheit:** gezaehlt wird, wie oft Leute einen Sticker schicken und wie oft Kai ihn benutzt, dazu Kais eigene Wertung 1 bis 5 (`sticker_bewerten`). `sticker_sammlung` sortiert danach und durchsucht die Beschreibungen nach Stimmung oder Motiv.
- **Einsatz:** `sticker_senden`. Wie oft, regelt `Soul.md`: selten, fuer lustige Momente oder wenn die Worte fehlen.

### Verlauf durchsuchen

Alles aus freigegebenen Chats bleibt gespeichert: Text, Bilder, Sticker, PDFs, Sprachnachrichten (Audio und Transkript), Videos (Standbild-Raster und Transkript des Tons, durchsuchbar). Kai durchsucht das mit `verlauf_suchen` (Stichwort, Zeitraum) und liest Abschnitte mit `verlauf_lesen`. Im Direktchat darf der Besitzer auch eine freigegebene Gruppe nennen ("was hat Tom letzte Woche in Mastermind zum Angebot gesagt?"), sonst sieht Kai immer nur den Chat, in dem er gerade ist.

### Befehle (nur der Besitzer, in der Gruppe)

| Befehl | Wirkung |
|---|---|
| `!kai status` | Gruppe, Verlaufslaenge, Session, Antworten im Monat |
| `!kai pause` | liest weiter mit, antwortet nicht |
| `!kai weiter` | hebt die Pause auf |
| `!kai proaktiv an` / `aus` | Mitreden ohne Ansprache in dieser Gruppe ein- oder ausschalten |
| `!kai neu` | vergisst die Unterhaltung, liest beim naechsten Mal die drei neuesten Logs und die letzten 20 Nachrichten neu ein |

## Sicherheit: was Kai kann und was nicht

Leute in der Gruppe werden versuchen, Kai auszutricksen. Die Abschottung verlaesst sich deshalb nicht darauf, dass Kai sich an seine Anweisungen haelt, sondern darauf, dass er die Mittel gar nicht hat.

| Ebene | Wie abgesichert |
|---|---|
| Werkzeuge | Genau zweiundzwanzig: `WebFetch`, `WebSearch` und zwanzig eigene (in Gruppe schreiben, Besitzer informieren, Warten beenden, reagieren, Stickersammlung durchsuchen, ansehen, bewerten und senden, Bild senden, Bild ansehen, Verlauf suchen und lesen, Log schreiben und lesen, Gedaechtnis lesen, ergaenzen und schreiben, Aufgaben planen, auflisten, loeschen). Die eigenen arbeiten nur innerhalb der jeweiligen Gruppe; Dateinamen werden geprueft, aus dem Gedaechtnis-Ordner fuehrt kein Pfad heraus. **Kein** Terminal, kein Lesen oder Schreiben von Dateien, kein Skill-Werkzeug, keine Unteragenten. Beim ersten Durchgang steht die Liste im Log (`[kai] Werkzeuge: ...`). |
| Versand | Jeder Versand, egal aus welchem Werkzeug, laeuft durch eine zweite Tuer im Code (`isAllowedRecipient` in [src/gate.mjs](src/gate.mjs)): nur an freigegebene Gruppen und den Direktchat des Besitzers. Die Werkzeuge haben ausserdem gar keinen Empfaenger-Parameter, sie schreiben immer in den Chat, aus dem der Auftrag kam. "Schreib dem Tom mal privat" ist damit nicht moeglich, und ein Versuch, der doch bis zum Versand kaeme, wird blockiert und per ntfy gemeldet. |
| Erweiterbarkeit | Werkzeuge, Tuer und Regeln stehen im Programmcode im Image. Kai kann keine Dateien ausserhalb seines Gedaechtnis-Ordners schreiben, keinen Code ausfuehren und nichts nachinstallieren; das Dateisystem des Containers ist ohnehin schreibgeschuetzt. Neue Faehigkeiten gibt es nur, wenn jemand den Code aendert und das Image neu baut. |
| Konnektoren | `strictMcpConfig` plus `ENABLE_CLAUDEAI_MCP_SERVERS=false`: nur der eigene WhatsApp-Server. Gmail, SharePoint und alle anderen claude.ai-Konnektoren werden nicht geladen. |
| Skills, Plugins, Einstellungen | `settingSources: []`, `skills: []`, `plugins: []`. Die in Claude Code eingebauten Skills stehen zwar in der Liste, sind aber ohne Skill-Werkzeug nicht aufrufbar. |
| Links | Jede URL fuer `WebFetch` und `bild_senden` wird vorher geprueft: nur http(s), keine privaten Adressen (LAN, Tailnet, localhost), nichts unter den Domains aus `KAI_BLOCKED_DOMAINS`, und der Name darf auch nach der DNS-Aufloesung nicht auf eine private Adresse zeigen. |
| Container | eigener Benutzer (UID 1000), Dateisystem nur lesbar, alle Capabilities entzogen, `no-new-privileges`, Speicher- und Prozesslimit, kein Docker-Socket. Eingehaengt sind nur `./data` und der Austauschordner `./sandbox-jobs`. |
| Netz | Kai teilt den Netz-Namespace der Hülle **kai-firewall**, die per iptables das **gesamte Heimnetz** sperrt (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10) — ohne Ausnahme. Nur öffentliches Web geht raus. Ein eigener ntfy-Server muss deshalb über eine öffentliche Adresse erreichbar sein. So kann niemand Kai aus der Gruppe dazu bringen, das Heimnetz anzugreifen. DNS ist 1.1.1.1. |
| Geheimnisse | Der Claude-Prozess bekommt nur `PATH`, `HOME` und den Claude-Token. ntfy-Token und `.env` bleiben im Bruecken-Prozess. Kai kann ohne Terminal und Dateizugriff ohnehin keine Umgebung auslesen. |
| Tageslimit | Hoechstens 300 verschickte Nachrichten pro Kalendertag ueber alle Chats (`KAI_MAX_MESSAGES_PER_DAY`), gezaehlt wird alles: Text, Sticker, Bild, Reaktion. Reihenfolge fest im Code: erst die Tuer (freigegebener Chat?), dann das Limit, erst dann die KI. Ist es erreicht, bekommt ein Chat, der Kai anspricht, statt einer KI-Antwort hoechstens einmal pro Stunde den Hinweis "Tageslimit erreicht, ab Mitternacht bin ich wieder da", geplante Aufgaben fallen aus, und ntfy meldet es einmal am Tag. `!kai`-Befehle des Besitzers funktionieren weiter. |
| Kosten | hoechstens 30 Durchgaenge pro Stunde und Gruppe, 20 Werkzeugschritte pro Durchgang, 20 geplante Aufgaben pro Gruppe. |

**Restrisiken, bewusst in Kauf genommen:**

- Die Linkpruefung schaut vor dem Abruf nach. Ein Angreifer mit eigener Domain koennte zwischen Pruefung und Abruf die DNS-Antwort wechseln (DNS-Rebinding) und so einen einzelnen GET auf eine LAN-Adresse ausloesen. Das faengt jetzt die **kai-firewall** ab (siehe Zeile „Netz"): das Heimnetz ist auf OS-Ebene gesperrt, die Linkpruefung ist nur die zweite Linie.
- Der Setup-Token gehoert zu deinem Claude-Abo. Kai verbraucht dein Kontingent, und was die Gruppe mit ihm schreibt, laeuft unter deinem Konto bei Anthropic.
- Die Nachrichten der Gruppe gehen an Anthropic. Die Mitglieder sollten das wissen.
- Baileys ist kein offizieller WhatsApp-Client. WhatsApp kann die Nummer sperren, deshalb eine eigene Nummer fuer Kai.
- Kai kann in der Gruppe Unsinn schreiben, wenn man ihn geschickt dazu bringt. Er kann aber nichts ausserhalb der Gruppe tun.

Die LAN-Sperre ist **fest eingebaut**, nicht mehr optional: der Container **kai-firewall** ([firewall/entrypoint.sh](firewall/entrypoint.sh)) besitzt den Netz-Namespace, den Kai nutzt (`network_mode: service:kai-firewall`), und sperrt per iptables alle privaten Bereiche per REJECT. Es gibt **keine** Ausnahme, auch nicht für den eigenen Router oder Reverse-Proxy. Die Firewall enthält nur die Regeln, keinen App-Code, ist also selbst keine Angriffsfläche.

## Einrichten

Was du brauchst:

- einen Rechner, der immer laeuft, mit **Docker und Docker Compose** (Homeserver, Mini-PC, Raspberry Pi 5 mit 64 Bit, ein kleiner Cloud-Server). Rund 4 GB RAM frei.
- eine **eigene Nummer** fuer Kai (Zweit-SIM oder eSIM). Nie die eigene Hauptnummer: WhatsApp kann inoffizielle Clients sperren.
- ein **Claude-Abo** (Pro oder Max) und einmal Claude Code auf irgendeinem Rechner.
- optional einen **OpenAI-API-Schluessel** fuer Sprachnachrichten, Videoton und Sprachausgabe.
- optional **ntfy** auf dem Handy fuer Stoermeldungen.

**1. Zweit-SIM** mit WhatsApp (oder WhatsApp Business) auf einem Telefon einrichten. Profilbild und Name "Kai" setzen. Das Telefon muss danach nur ab und zu online sein.

**2. Setup-Token** auf einem Rechner mit Claude Code erzeugen:

```bash
claude setup-token
```

Der Token gilt ein Jahr. Er gehoert in die `.env` und nirgends sonst hin.

**3. Auf dem Rechner, der Kai betreibt:**

```bash
git clone <dieses-repo> kai && cd kai
mkdir -p data sandbox-jobs && sudo chown 1000:1000 data sandbox-jobs
cp .env.example .env && chmod 600 .env
# .env ausfuellen: CLAUDE_CODE_OAUTH_TOKEN, KAI_TOKEN_CREATED, KAI_PHONE,
# KAI_OWNER_NUMBER, KAI_OWNER_NAME, bei Bedarf OPENAI_API_KEY, NTFY_*,
# KAI_BLOCKED_DOMAINS
docker compose up -d --build
docker logs -f kai
```

Die Container laufen als UID 1000, deshalb muessen `data/` und `sandbox-jobs/` diesem Benutzer gehoeren. Beide Ordner stehen in `.gitignore`.

**4. Koppeln:** Mit `KAI_PHONE` steht im Log ein 8-stelliger Code. Auf Kais Telefon: Einstellungen > Verknuepfte Geraete > Geraet hinzufuegen > "Stattdessen mit Telefonnummer verknuepfen". Ohne `KAI_PHONE` steht ein QR-Code im Log.

**5. Gruppe festlegen:** Kai in die Gruppe aufnehmen, dann `docker restart kai`. Das Log listet alle Gruppen:

```
[kai]         120363012345678901@g.us  Familie
```

ID in `KAI_GROUPS` eintragen, `docker compose up -d`. Eine zweite Gruppe spaeter kommagetrennt dazu.

Den Verlauf **vor** Kais Beitritt bekommt er nur, wenn seine Nummer schon vor dem Koppeln in der Gruppe war: WhatsApp schickt dann beim Koppeln die Historie mit.

**6. Persoenlichkeit anpassen:** Die Startfassung steht in [vorlagen/Soul.md](vorlagen/Soul.md). Sie wird beim ersten Kontakt mit einer Gruppe nach `data/Gedaechtnis/<gruppe>/` kopiert und gehoert ab dann Kai. Wer eine andere Persoenlichkeit will, aendert die Vorlage **vor** dem ersten Start, oder spaeter die Datei im Gedaechtnis-Ordner, oder sagt es Kai im Direktchat.

**7. Den Alarm pruefen, nicht die Konfiguration:** `CLAUDE_CODE_OAUTH_TOKEN` testweise verfaelschen, `docker compose up -d`, Kai ansprechen. Auf dem Handy muss "Kai erreicht Claude nicht" ankommen (oder, ohne ntfy, im `docker logs kai` stehen). Danach zuruecksetzen.

## Was Kai an ntfy meldet

Thema aus `NTFY_TOPIC` (Vorgabe `kai`):

| Wann | Prioritaet |
|---|---|
| WhatsApp hat Kai abgemeldet | high |
| seit 30 Minuten keine Verbindung | high |
| Claude-Anmeldung oder Kontingent scheitert | high, hoechstens alle 6 h |
| drei Fehlschlaege in Folge in einer Gruppe | high |
| Stundenlimit erreicht | high, hoechstens stuendlich |
| Tageslimit von 300 Nachrichten erreicht | high, einmal am Tag |
| geplante Aufgabe gescheitert oder verpasst | high |
| Setup-Token laeuft in 30 Tagen ab | high, taeglich |
| OpenAI lehnt Transkription ab (Schluessel, Guthaben) | high, hoechstens alle 6 h |
| Monatserster: "Kai laeuft", Antworten im Vormonat | default |

Ist ntfy nicht erreichbar, steht die Meldung in `docker logs kai`.

## Wartung

- **Token erneuern** (jaehrlich): `claude setup-token`, in `.env` eintragen, `KAI_TOKEN_CREATED` anpassen, `docker compose up -d`.
- **Neu koppeln** nach Abmeldung: `docker compose down`, `data/auth` loeschen, `docker compose up -d`, Schritt 4.
- **Update:** `package.json` anheben, `npm install` fuer die Lock-Datei, `docker compose up -d --build`. Baileys zuerst, wenn WhatsApp etwas am Protokoll aendert und Kai keine Verbindung mehr bekommt.
- **Backup:** wichtig sind `data/Gedaechtnis` (Wissen und Profile), `data/kai.db` (der Verlauf) und `data/auth` (WhatsApp-Kopplung, wie ein Passwort behandeln). `data/media`, `data/claude` und `data/Logs` lassen sich verschmerzen.

## Dateien

| Pfad | Inhalt |
|---|---|
| `src/main.mjs` | WhatsApp-Verbindung, Ablage, Warteschlange, Befehle, Waechter |
| `src/agent.mjs` | Claude-Aufruf, Systemprompt, Werkzeuge, Abschottung |
| `src/guard.mjs` | Linkpruefung |
| `src/trigger.mjs` | wann Kai gemeint ist |
| `src/extract.mjs` | WhatsApp-Nachrichtentypen |
| `src/transcript.mjs` | Verlauf als Text und Bilder fuer Claude |
| `src/store.mjs` | SQLite: Verlauf, Session je Gruppe, geplante Aufgaben |
| `src/logs.mjs` | Kais Tageslogs |
| `src/memory.mjs` | Kais Gedaechtnis-Dateien mit Sicherung |
| `vorlagen/` | Startfassung von `CLAUDE.md`, `Soul.md` und den uebrigen Gedaechtnis-Dateien |
| `src/schedule.mjs` | Zeitrechnung fuer Aufgaben |
| `data/` | `kai.db`, `media/`, `Logs/`, `Gedaechtnis/`, `auth/` (WhatsApp-Kopplung, wie ein Passwort behandeln), `claude/` (Sessions) |

Tests: `npm test`.
