// Letzter Schliff vor dem Versand: Gedankenstriche schreibt kein Mensch im
// Chat. " – ", " — " und ein einzelnes " - " mitten im Satz werden zu einem
// Komma, uebrige lange Striche (z. B. "10–12") zum normalen Bindestrich.
// Bindestriche in Woertern ("E-Mail") und in Links bleiben, wie sie sind.
export function humanize(text) {
  return String(text)
    .split(/(https?:\/\/\S+)/g)
    .map((part, i) => (i % 2 ? part : part
      .replace(i > 0 ? /^[ \t]+[–—-][ \t]+(?=\S)/ : /$^/, ', ')
      .replace(/([^\s\n])[ \t]+[–—-][ \t]+(?=\S)/g, '$1, ')
      .replace(/,\s*,/g, ',')
      .replace(/[–—]/g, '-')))
    .join('')
}

// Welcher Text geht raus? Claude liefert als Ergebnis nur den Text nach dem
// letzten Werkzeug. Schreibt Kai erst seine Antwort, benutzt dann noch ein
// Werkzeug (etwa sich etwas merken) und schliesst mit "[schweigen]", waere
// die eigentliche Antwort verloren. Deshalb: der letzte Text, der nicht nur
// "[schweigen]" ist, aus allen Texten dieses Durchgangs.
export function pickReply(texts, silence) {
  const real = texts.map((t) => String(t || '').replace(silence, '').trim()).filter((t) => t && !isMetaReply(t))
  return real.length ? real[real.length - 1] : silence
}

// Floskeln, mit denen das Modell manchmal "nichts mehr zu sagen" ausdrueckt,
// statt [schweigen] zu schreiben, meist nachdem ein Werkzeug schon alles
// verschickt hat. An die Gruppe gingen sie als Nachricht raus ("No response
// requested." nach jedem Schachbrett). Sie zaehlen als Schweigen.
const META = [
  /^\(?no (further )?(response|reply|answer|message)( is)? (requested|needed|required|necessary)\)?\.?$/i,
  /^\(?(no response|no reply|nothing (else )?to (add|say))\)?\.?$/i,
  /^\(?keine (weitere )?(antwort|reaktion|nachricht) (nötig|noetig|erforderlich|notwendig)\)?\.?$/i,
  /^\(?(schweigen|schweige|silence|stumm)\)?\.?$/i,
  /^\(?(done|erledigt|fertig)\)?\.?$/i,
]
export function isMetaReply(text) {
  const t = String(text || '').trim()
  return t.length < 80 && META.some((re) => re.test(t))
}

// Nur Emojis, Satzzeichen oder Leerraum, kein einziger Buchstabe und keine
// Ziffer? Dann ist das neben einem Sticker kein Text, sondern Beiwerk.
export function isOnlyDecoration(text) {
  return !/[\p{L}\p{N}]/u.test(String(text || ''))
}
