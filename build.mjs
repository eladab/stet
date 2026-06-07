#!/usr/bin/env node
// Builds dist/stet — a single self-contained executable with the UI embedded.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.dirname(fileURLToPath(import.meta.url))
const src = p => path.join(root, 'src', p)

const assets = {}
for (const f of ['index.html', 'app.css', 'app.js']) {
  assets[f] = fs.readFileSync(src(f), 'utf8')
}

const MARKER = 'let ASSETS = null /* @embed-assets */'
const server = fs.readFileSync(src('server.mjs'), 'utf8')
if (!server.includes(MARKER)) {
  console.error('build: @embed-assets marker not found in src/server.mjs')
  process.exit(1)
}
// Build provenance — lets the installed binary report its version and find
// its source checkout for `stet --update`.
const BUILD_MARKER = 'let BUILD = null /* @embed-build */'
if (!server.includes(BUILD_MARKER)) {
  console.error('build: @embed-build marker not found in src/server.mjs')
  process.exit(1)
}
let commit = 'unknown'
try {
  commit = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
} catch {}
const build = { commit, date: new Date().toISOString().slice(0, 10), srcDir: root }

const esm = server
  .replace(/^#!.*\n/, '') // shebang is illegal mid-file; the trampoline has its own
  .replace(MARKER, `const ASSETS = ${JSON.stringify(assets)}`)
  .replace(BUILD_MARKER, `const BUILD = ${JSON.stringify(build)}`)

// The installed binary has no extension, so Node parses the whole file as
// CommonJS — ESM syntax anywhere in it is a parse error. So the ES module is
// carried as a base64 string and loaded through a data: URL at runtime.
const out = `#!/usr/bin/env node
'use strict'
globalThis.__STET_SELF__ = __filename
import('data:text/javascript;base64,${Buffer.from(esm).toString('base64')}')
  .catch(e => { console.error(e.stack || e); process.exit(1) })
`

fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
const dest = path.join(root, 'dist', 'stet')
fs.writeFileSync(dest, out, { mode: 0o755 })
console.log(`built ${dest} (${(out.length / 1024).toFixed(0)} KB)`)
