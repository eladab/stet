#!/usr/bin/env node
/**
 * stet — interactive git staging in the browser. Single-process, zero deps.
 *
 * Serves the web UI (embedded in the built binary; read from disk in dev)
 * and a small JSON API that shells out to `git` (always via execFile
 * argument arrays — never a shell). Binds 127.0.0.1 on an ephemeral port.
 *
 * Usage: stet [path-inside-repo] [--port N] [--no-open] [--fg]
 *   default: daemonize (detach and return), open the browser
 *   --fg:    stay in the foreground, print STET_URL=..., Ctrl+C to stop
 */

import http from 'node:http'
import crypto from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFile, execFileSync, spawn } from 'node:child_process'

// Injected by build.mjs in the single-file dist; null in dev (read from disk).
let ASSETS = null /* @embed-assets */

// In the built binary we run from a data: URL via the CJS trampoline, which
// stashes the real file path in globalThis first. In dev, import.meta works.
const SELF = globalThis.__STET_SELF__ ?? fileURLToPath(import.meta.url)
const srcDir = ASSETS ? null : path.dirname(SELF)

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs (argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo') args.repo = argv[++i]
    else if (argv[i] === '--port') args.port = Number(argv[++i])
    else if (argv[i] === '--fg') args.fg = true
    else if (argv[i] === '--idle') args.idle = Number(argv[++i])
    else if (argv[i] === '--no-open') args.noOpen = true
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
    else if (!argv[i].startsWith('-')) args._.push(argv[i])
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log('usage: stet [path-inside-repo] [--port N] [--no-open] [--fg] [--idle SECS]')
  console.log('  --idle: shut down after N seconds without browser contact (default 120, 0 = never)')
  process.exit(0)
}
const repoArg = args.repo || args._[0]
const portArg = args.port
const openArg = !args.noOpen

// Resolve the repo root ourselves — callers may pass any path inside the repo,
// or nothing at all (defaults to cwd).
let REPO
try {
  REPO = execFileSync(
    'git', ['-C', path.resolve(repoArg || '.'), 'rev-parse', '--show-toplevel'],
    { encoding: 'utf8' }
  ).trim()
} catch (e) {
  console.error(`stet: ${path.resolve(repoArg || '.')} is not inside a git repository`)
  process.exit(1)
}

// Default mode: re-spawn ourselves detached and return immediately; the child
// runs with --fg and opens the browser. Repo errors above still surface here.
if (!args.fg) {
  const childArgs = [SELF, '--fg', '--repo', REPO]
  if (portArg) childArgs.push('--port', String(portArg))
  if (!openArg) childArgs.push('--no-open')
  if (args.idle !== undefined) childArgs.push('--idle', String(args.idle))
  spawn(process.execPath, childArgs, { stdio: 'ignore', detached: true }).unref()
  console.log('stet starting — browser will open. Quit with the ⏻ button or the q key.')
  process.exit(0)
}

const TOKEN = crypto.randomBytes(16).toString('hex')

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
function git (args, { input, okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git', ['-C', REPO, ...args],
      { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0
        if (okCodes.includes(code)) resolve({ code, stdout, stderr })
        else reject(Object.assign(new Error(stderr || `git exited ${code}`), { code, stdout, stderr }))
      }
    )
    if (input != null) child.stdin.end(input)
    else child.stdin.end()
  })
}

// Reject absolute paths and `..` traversal; git sees paths only after `--`.
function safeRepoPath (p) {
  if (typeof p !== 'string' || p.length === 0) return null
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return null
  const parts = p.split(/[\\/]/)
  if (parts.some(seg => seg === '..' || seg === '')) return null
  return p
}

// ---------------------------------------------------------------------------
// status (porcelain v2) parsing
// ---------------------------------------------------------------------------
function parseStatus (raw) {
  const tokens = raw.split('\0').filter(t => t.length > 0)
  const branch = { head: null, upstream: null, ahead: 0, behind: 0 }
  const staged = []
  const unstaged = []
  const untracked = []

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith('# branch.head ')) branch.head = t.slice(14)
    else if (t.startsWith('# branch.upstream ')) branch.upstream = t.slice(18)
    else if (t.startsWith('# branch.ab ')) {
      const m = t.match(/\+(\d+) -(\d+)/)
      if (m) { branch.ahead = Number(m[1]); branch.behind = Number(m[2]) }
    } else if (t.startsWith('1 ')) {
      // 1 XY sub mH mI mW hH hI path
      const xy = t.slice(2, 4)
      const file = t.split(' ').slice(8).join(' ')
      if (xy[0] !== '.') staged.push({ path: file, status: xy[0] })
      if (xy[1] !== '.') unstaged.push({ path: file, status: xy[1] })
    } else if (t.startsWith('2 ')) {
      // 2 XY sub mH mI mW hH hI Xscore path  \0 origPath
      const xy = t.slice(2, 4)
      const file = t.split(' ').slice(9).join(' ')
      const orig = tokens[++i] // next NUL token is the original path
      if (xy[0] !== '.') staged.push({ path: file, origPath: orig, status: xy[0] })
      if (xy[1] !== '.') unstaged.push({ path: file, origPath: orig, status: xy[1] })
    } else if (t.startsWith('u ')) {
      // unmerged — show in unstaged with status U
      const file = t.split(' ').slice(10).join(' ')
      unstaged.push({ path: file, status: 'U' })
    } else if (t.startsWith('? ')) {
      untracked.push({ path: t.slice(2), status: '?' })
    }
  }
  return { branch, staged, unstaged, untracked }
}

// ---------------------------------------------------------------------------
// base branch detection (cached)
// ---------------------------------------------------------------------------
let baseCache = null
async function detectBase () {
  if (baseCache !== null) return baseCache
  try {
    const { stdout } = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    baseCache = stdout.trim() // e.g. origin/main
    return baseCache
  } catch {}
  for (const cand of ['origin/main', 'origin/master', 'main', 'master']) {
    try {
      await git(['rev-parse', '--verify', '--quiet', `${cand}^{commit}`])
      baseCache = cand
      return baseCache
    } catch {}
  }
  baseCache = ''
  return baseCache
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
const DIFF_FLAGS = ['--no-color', '--no-ext-diff']

async function apiState () {
  const { stdout } = await git(['status', '--porcelain=v2', '--branch', '-z'])
  const state = parseStatus(stdout)
  let lastCommit = null
  try {
    const { stdout: lc } = await git(['log', '-1', '--format=%h%x00%s'])
    const [short, subject] = lc.trim().split('\0')
    lastCommit = { short, subject }
  } catch {} // empty repo
  return { repo: path.basename(REPO), repoPath: REPO, lastCommit, ...state }
}

async function apiLastCommit () {
  const { stdout } = await git(['log', '-1', '--format=%h%x00%s%x00%b'])
  const [short, subject, body] = stdout.split('\0')
  return { short, subject, body: (body || '').trim() }
}

async function apiCommit (req) {
  const subject = typeof req.subject === 'string' ? req.subject.trim() : ''
  const body = typeof req.body === 'string' ? req.body.trim() : ''
  const amend = !!req.amend
  if (!subject) throw httpErr(400, 'commit subject is required')

  if (!amend) {
    // --quiet exits 1 when there ARE staged changes
    const { code } = await git(['diff', '--cached', '--quiet'], { okCodes: [0, 1] })
    if (code === 0) throw httpErr(400, 'nothing staged to commit')
  }

  const args = ['commit']
  if (amend) args.push('--amend')
  args.push('-m', subject)
  if (body) args.push('-m', body)

  try {
    await git(args) // hooks run normally and may reject the commit
  } catch (e) {
    throw httpErr(422, 'commit failed', (e.stderr || '') + (e.stdout || ''))
  }
  const { stdout } = await git(['log', '-1', '--format=%h'])
  return { ok: true, short: stdout.trim(), subject }
}

async function apiDiff (q) {
  const file = safeRepoPath(q.get('file'))
  const where = q.get('where')
  if (!file) throw httpErr(400, 'invalid file path')

  let res
  if (where === 'staged') {
    res = await git(['diff', '--cached', ...DIFF_FLAGS, '--', file])
  } else if (where === 'unstaged') {
    res = await git(['diff', ...DIFF_FLAGS, '--', file])
  } else if (where === 'untracked') {
    // --no-index exits 1 when files differ — that's the normal case
    res = await git(['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', file], { okCodes: [0, 1] })
  } else if (where === 'branch') {
    const base = await detectBase()
    if (!base) throw httpErr(404, 'no base branch found')
    const { stdout: mb } = await git(['merge-base', base, 'HEAD'])
    res = await git(['diff', ...DIFF_FLAGS, mb.trim(), 'HEAD', '--', file])
  } else {
    throw httpErr(400, 'invalid where')
  }
  const binary = /^Binary files .* differ$|^GIT binary patch$/m.test(res.stdout)
  return { diff: binary ? '' : res.stdout, binary }
}

async function apiBranch () {
  const base = await detectBase()
  if (!base) return { base: null, files: [] }
  const { stdout: mbOut } = await git(['merge-base', base, 'HEAD'])
  const mb = mbOut.trim()
  const { stdout } = await git(['diff', '--name-status', '-z', '--no-color', mb, 'HEAD'])
  const tokens = stdout.split('\0').filter(Boolean)
  const files = []
  for (let i = 0; i < tokens.length; i++) {
    const status = tokens[i][0]
    if (status === 'R' || status === 'C') {
      files.push({ status, origPath: tokens[++i], path: tokens[++i] })
    } else {
      files.push({ status, path: tokens[++i] })
    }
  }
  return { base, mergeBase: mb, files }
}

async function apiFileAction (op, body) {
  const file = safeRepoPath(body.file)
  if (!file) throw httpErr(400, 'invalid file path')
  if (op === 'stage') await git(['add', '--', file])
  else if (op === 'unstage') await git(['restore', '--staged', '--', file])
  else if (op === 'discard') {
    if (body.untracked) await git(['clean', '-f', '--', file])
    else await git(['restore', '--', file])
  } else throw httpErr(400, 'invalid op')
  return { ok: true }
}

async function apiHunk (body) {
  const file = safeRepoPath(body.file)
  const { op, hunk } = body
  if (!file) throw httpErr(400, 'invalid file path')
  if (typeof hunk !== 'string' || !hunk.startsWith('@@')) throw httpErr(400, 'invalid hunk')
  if (!['stage', 'unstage', 'discard'].includes(op)) throw httpErr(400, 'invalid op')

  const patch =
    `diff --git a/${file} b/${file}\n` +
    `--- a/${file}\n` +
    `+++ b/${file}\n` +
    hunk + (hunk.endsWith('\n') ? '' : '\n')

  const flags = ['apply', '--recount', '--whitespace=nowarn']
  if (op === 'stage') flags.push('--cached')
  else if (op === 'unstage') flags.push('--cached', '-R')
  else flags.push('-R') // discard: reverse-apply to working tree

  try {
    await git([...flags, '-'], { input: patch })
  } catch (e) {
    // patch no longer applies — file changed underneath the UI
    throw httpErr(409, 'hunk is stale, refresh the diff', e.stderr)
  }
  return { ok: true }
}

async function apiPoll () {
  const [{ stdout: st }, head] = await Promise.all([
    git(['status', '--porcelain', '-z']),
    git(['rev-parse', 'HEAD']).catch(() => ({ stdout: 'no-head' }))
  ])
  const etag = crypto.createHash('sha1').update(st + head.stdout).digest('hex')
  return { etag }
}

function httpErr (status, message, detail) {
  return Object.assign(new Error(message), { status, detail })
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

function sendJSON (res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => {
      data += c
      if (data.length > 4 * 1024 * 1024) { reject(httpErr(413, 'body too large')); req.destroy() }
    })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { reject(httpErr(400, 'invalid JSON')) }
    })
    req.on('error', reject)
  })
}

function authorized (req, url) {
  const header = req.headers['x-stet-token']
  return header === TOKEN || url.searchParams.get('t') === TOKEN
}

function sameOrigin (req) {
  const origin = req.headers.origin || req.headers.referer
  if (!origin) return true // curl / non-browser clients carry the token anyway
  try {
    const u = new URL(origin)
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost'
  } catch { return false }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req, url)) return sendJSON(res, 401, { error: 'unauthorized' })
      lastSeen = Date.now(); sawClient = true
      if (req.method === 'POST' && !sameOrigin(req)) return sendJSON(res, 403, { error: 'bad origin' })

      if (req.method === 'GET') {
        if (url.pathname === '/api/state') return sendJSON(res, 200, await apiState())
        if (url.pathname === '/api/diff') return sendJSON(res, 200, await apiDiff(url.searchParams))
        if (url.pathname === '/api/branch') return sendJSON(res, 200, await apiBranch())
        if (url.pathname === '/api/poll') return sendJSON(res, 200, await apiPoll())
        if (url.pathname === '/api/lastcommit') return sendJSON(res, 200, await apiLastCommit())
      } else if (req.method === 'POST') {
        const body = await readBody(req)
        if (url.pathname === '/api/stage') return sendJSON(res, 200, await apiFileAction('stage', body))
        if (url.pathname === '/api/unstage') return sendJSON(res, 200, await apiFileAction('unstage', body))
        if (url.pathname === '/api/discard') return sendJSON(res, 200, await apiFileAction('discard', body))
        if (url.pathname === '/api/hunk') return sendJSON(res, 200, await apiHunk(body))
        if (url.pathname === '/api/commit') return sendJSON(res, 200, await apiCommit(body))
        if (url.pathname === '/api/quit') {
          sendJSON(res, 200, { ok: true })
          setTimeout(() => { server.close(); process.exit(0) }, 100)
          return
        }
      }
      return sendJSON(res, 404, { error: 'not found' })
    }

    // static UI — embedded in the built binary, read from disk in dev
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
    if (!/^[a-z0-9._-]+$/i.test(rel)) { res.writeHead(403); return res.end('forbidden') }
    const serve = data => {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' })
      res.end(data)
    }
    if (ASSETS) {
      if (!Object.hasOwn(ASSETS, rel)) { res.writeHead(404); return res.end('not found') }
      serve(ASSETS[rel])
    } else {
      fs.readFile(path.join(srcDir, rel), (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found') }
        serve(data)
      })
    }
  } catch (e) {
    sendJSON(res, e.status || 500, { error: e.message, detail: e.detail || e.stderr || undefined })
  }
})

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
// Idle watchdog: the UI polls every 2s (browsers throttle hidden tabs to
// ~1/min), so a closed tab/browser stops the heartbeat and we shut down.
// Before any client ever connects, allow a longer window for the browser
// to arrive. --idle 0 disables.
const IDLE_GRACE_MS = (args.idle === undefined ? 120 : args.idle) * 1000
let lastSeen = Date.now()
let sawClient = false
if (IDLE_GRACE_MS > 0) {
  setInterval(() => {
    const idle = Date.now() - lastSeen
    if (idle > (sawClient ? IDLE_GRACE_MS : Math.max(IDLE_GRACE_MS, 10 * 60_000))) {
      console.log('stet: no browser activity — shutting down')
      process.exit(0)
    }
  }, 5_000).unref()
}

server.listen(portArg || 0, '127.0.0.1', () => {
  const { port } = server.address()
  const url = `http://127.0.0.1:${port}/?t=${TOKEN}`
  console.log(`STET_URL=${url}`)
  if (openArg) {
    const opener = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start'
      : 'xdg-open'
    spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
  }
})
