// Wann Kai antwortet: wenn er per @ erwaehnt wird, wenn jemand auf eine seiner
// Nachrichten antwortet, oder wenn sein Name als eigenes Wort vorkommt.
// "Kai", "kai", ",Kai.", "@kai", "Kai's" zaehlen, "Kaiser" und "Kairo" nicht.

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function nameRegex(names) {
  const alt = names.map(escape).join('|')
  return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`, 'iu')
}

// botJids: alle Kennungen, unter denen Kai auftritt (Telefonnummer-JID und LID),
// bereits ohne Geraeteanhang (":12").
export function isAddressed({ text, mentionedJids = [], quotedParticipant, botJids, names }) {
  const bare = (j) => (j || '').replace(/:\d+(?=@)/, '')
  if (mentionedJids.some((j) => botJids.has(bare(j)))) return true
  if (quotedParticipant && botJids.has(bare(quotedParticipant))) return true
  return Boolean(text) && nameRegex(names).test(text)
}
