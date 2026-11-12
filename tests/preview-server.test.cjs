const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const http = require('node:http')
const path = require('node:path')
const { test } = require('node:test')

test('the preview serves public assets without exposing the checkout', { timeout: 15000 }, async (t) => {
  const child = spawn(process.execPath, [path.join(__dirname, '../docs/serve.cjs'), '0'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode !== null) return
    const exited = once(child, 'exit')
    child.kill()
    await exited
  })
  const output = await new Promise((resolve, reject) => {
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      if (buffered.includes('\n')) resolve(buffered)
    })
    child.once('error', reject)
    child.once('exit', (code) => reject(new Error(`preview server exited before naming a port (${code})`)))
  })
  const port = Number(String(output).match(/:(\d+)\//)?.[1])
  assert.ok(port > 0, 'the preview must bind an available local port')

  async function request(target, host = `127.0.0.1:${port}`) {
    return new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port, path: target, headers: { Host: host } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
        res.on('error', reject)
      }).on('error', reject)
    })
  }

  await t.test('the page, frame and renderer remain available', async () => {
    for (const resource of ['/docs/index.html', '/docs/preview-panel.html', '/docs/preview-data.js',
      '/renderer/index.html', '/renderer/panel.js', '/renderer/panel.css']) {
      assert.equal(await request(resource), 200, resource)
    }
    assert.equal(await request('/'), 302)
  })

  await t.test('repository metadata and credential filenames are not served', async () => {
    for (const resource of ['/.git/config', '/package.json', '/settings.json', '/credentials-archive.json',
      '/signins/example.info', '/docs/serve.cjs', '/docs/..%2f.git/config']) {
      assert.equal(await request(resource), 403, resource)
    }
  })

  await t.test('a rebound hostname cannot read even public resources', async () => {
    assert.equal(await request('/docs/index.html', 'rebind.invalid'), 403)
  })

  await t.test('malformed paths do not stop later requests', async () => {
    assert.equal(await request('/%zz'), 400)
    assert.equal(await request('/docs/%00'), 400)
    assert.equal(await request('/docs/index.html'), 200)
  })
})
