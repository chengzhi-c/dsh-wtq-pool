// Serve the public preview over http://127.0.0.1 so the page opens in a
// browser. The preview fetches the panel markup it mounts (browsers block that
// under file://) and the panel's own CSP admits scripts only from its own
// origin; an http origin satisfies both.
//
//   node docs/serve.cjs            # then open the printed URL
//   node docs/serve.cjs 8123       # pick the port
//
// Read-only, and bound to 127.0.0.1.
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const PORT = Number(process.argv[2] || 8124)
const PUBLIC_FILES = new Set([
  'docs/index.html', 'docs/preview-panel.html', 'docs/preview-data.js',
  'docs/logo.png', 'docs/logo-dark.png', 'docs/preview-pool.png',
  'docs/preview-dark.png', 'docs/preview-models.png', 'docs/preview-growth.png',
  'docs/preview-page.png', 'renderer/index.html', 'renderer/panel.js', 'renderer/panel.css',
])

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
}

http.createServer((req, res) => {
  // Loopback binding alone does not stop a browser using DNS rebinding.
  if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(req.headers.host || '')) {
    res.writeHead(403).end('forbidden')
    return
  }
  // A request-target the parser cannot resolve also throws, and it does so
  // before the guards below run: same rule as the decode failures, answered
  // rather than allowed to kill the server.
  let url
  try {
    url = new URL(req.url, 'http://127.0.0.1')
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request')
    return
  }
  // The preview page lives in docs/, so '/' redirects into it: the page's
  // relative links (./preview-panel.html, ../renderer/panel.js) resolve against
  // the URL, and a rewritten body under the wrong path would 404 every one.
  if (url.pathname === '/') {
    res.writeHead(302, { location: '/docs/index.html' }).end()
    return
  }
  // A malformed percent-escape (`/%zz`) makes decodeURIComponent throw, and a
  // decoded NUL makes fs.readFile throw; both would kill the server from inside
  // this callback, so they answer 400 instead. The path guard below still treats
  // the decoded value as untrusted.
  let rel
  try {
    rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request: ' + url.pathname)
    return
  }
  if (rel.includes('\0')) {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request: ' + url.pathname)
    return
  }
  if (!PUBLIC_FILES.has(rel)) {
    res.writeHead(403).end('forbidden')
    return
  }
  const file = path.join(ROOT, rel)
  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found: ' + rel)
      return
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body)
  })
}).listen(PORT, '127.0.0.1', function () {
  console.log('preview: http://127.0.0.1:' + this.address().port + '/  (Ctrl+C to stop)')
})
