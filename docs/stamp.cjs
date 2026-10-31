// Record what the README screenshots were captured against.
//
// The panel is mounted at runtime by docs/preview-panel.html, so a capture shows
// whatever renderer/ held when it ran. Nothing about a PNG says which version
// that was, and git does not carry modification times, so the test cannot compare
// dates. This writes the hashes into docs/preview-capture.json instead: run it
// after re-capturing, and the test fails the moment the panel changes under the
// pictures.
//
//   node docs/stamp.cjs
//
// Reads and writes only this repository's own files.
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const RENDERED = [
  'renderer/index.html',
  'renderer/panel.js',
  'renderer/panel.css',
  // The preview's own stand-in host and demo data decide what the pictures
  // show, so a change to either makes them stale just as the panel does.
  'docs/preview-panel.html',
  'docs/preview-data.js',
]
const SHOTS = [
  'preview-pool.png',
  'preview-dark.png',
  'preview-models.png',
  'preview-growth.png',
  'preview-page.png',
]

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, file))).digest('hex')
const stamp = {
  rendered: Object.fromEntries(RENDERED.map((file) => [file, digest(file)])),
  shots: Object.fromEntries(SHOTS.map((file) => [file, digest('docs/' + file)])),
}

fs.writeFileSync(path.join(ROOT, 'docs', 'preview-capture.json'), JSON.stringify(stamp, null, 2) + '\n')
console.log('docs/preview-capture.json: ' + RENDERED.length + ' rendered file(s), ' + SHOTS.length + ' shot(s)')
