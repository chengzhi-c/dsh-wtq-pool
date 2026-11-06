// What a rendered file looks like to the capture test, with comments gone.
//
// Comments never reach a pixel, so editing one must not demand a re-capture.
// Blank lines are dropped too, for the same reason and for a second one: a
// removed comment leaves its newlines behind, so leaving blank lines in would
// make the hash depend on how many lines a comment occupied and shortening one
// would still read as a changed picture. What remains is the code that decides
// what the page draws. Both `stamp.cjs` and the test hash through this one
// function, so the recorded value and the checked value cannot drift apart.
//
// A trailing `//` is a comment too, and rewriting one must not read as a changed
// picture. Telling it from the `//` inside a URL means tracking quotes: the
// scan below only enters a comment at a `//` seen outside a string, a template
// literal or a regex literal.
//
// Reads nothing and writes nothing; the caller hands it the text.

const BLOCK = /\/\*[\s\S]*?\*\//g
const HTML = /<!--[\s\S]*?-->/g
const BLANK = /^[ \t]*\r?\n/gm

/** Strip the `//` comment that starts at or after `from`, leaving the line's code. */
function cutTrailingComment(line) {
  let quote = null
  let escaped = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (escaped) { escaped = false; continue }
    if (quote !== null) {
      if (ch === '\\') { escaped = true; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

function withoutComments(text, file) {
  if (file.endsWith('.css')) return text.replace(BLOCK, '').replace(BLANK, '')
  const stripped = text.replace(BLOCK, '').replace(HTML, '')
  const lines = stripped.split('\n').map((line) => {
    const code = cutTrailingComment(line)
    // An all-comment line becomes empty and is dropped by BLANK below.
    return code.replace(/[ \t]+$/, '')
  })
  return lines.join('\n').replace(BLANK, '')
}

module.exports = { withoutComments }
