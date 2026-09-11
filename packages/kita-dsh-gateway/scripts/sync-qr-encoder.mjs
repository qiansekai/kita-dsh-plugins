// Keep the Host-side QR encoder byte-identical to the one inlined in the client
// bundle. Both copies exist for a real reason (the client bundle has no build
// step and cannot resolve node_modules; the Host half renders SVG on the
// server), but drift between them would mean the code shown on the desktop and
// the code the phone scans disagree.
//
//   node scripts/sync-qr-encoder.mjs           regenerate the library body
//   node scripts/sync-qr-encoder.mjs --check   fail (exit 1) when it drifted
//
// The body is copied out of lib/client.js between `var qrcodeLib = (function () {`
// and its closing `})();`, with the bundle's leading tabs stripped.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = join(here, '..')
const CLIENT = join(pkgRoot, 'lib', 'client.js')
const QR = join(pkgRoot, 'lib', 'qr.js')
const BEGIN = '// __QR_LIB_BEGIN__'
const END = '// __QR_LIB_END__'

/** Extract the inlined encoder from the client bundle, tab prefixes removed. */
function extractLibrary() {
  const source = readFileSync(CLIENT, 'utf8')
  const start = source.indexOf('var qrcodeLib = (function () {')
  if (start < 0) throw new Error('client.js: `var qrcodeLib = (function () {` not found')
  const closer = '\n\t\t})();'
  const stop = source.indexOf(closer, start)
  if (stop < 0) throw new Error('client.js: closing `})();` of the QR wrapper not found')
  // Include the closing `})();` itself — without it the IIFE would stay open in
  // the generated module and `export` would be a syntax error.
  return source.slice(start, stop + closer.length)
    .split('\n')
    .map((line) => line.replace(/^\t+/, ''))
    .join('\n')
    .trimEnd()
}

/** Read the library body currently stored in lib/qr.js. */
function currentBody() {
  const source = readFileSync(QR, 'utf8')
  const begin = source.indexOf(BEGIN)
  const end = source.indexOf(END)
  if (begin < 0 || end < 0 || end < begin) throw new Error('qr.js: markers missing or out of order')
  return source.slice(begin + BEGIN.length, end).replace(/^\r?\n/, '').replace(/\s+$/, '')
}

const extracted = extractLibrary()
const check = process.argv.includes('--check')

if (check) {
  const current = currentBody()
  if (current === extracted) {
    console.log(`sync-qr-encoder: in sync (${extracted.length} chars)`)
    process.exit(0)
  }
  console.error('sync-qr-encoder: DRIFT — lib/qr.js no longer matches the encoder in lib/client.js')
  console.error(`  client bundle: ${extracted.length} chars`)
  console.error(`  lib/qr.js    : ${current.length} chars`)
  const at = [...extracted].findIndex((ch, i) => ch !== current[i])
  if (at >= 0) {
    console.error(`  first difference at char ${at}:`)
    console.error(`    client: ${JSON.stringify(extracted.slice(Math.max(0, at - 40), at + 40))}`)
    console.error(`    qr.js : ${JSON.stringify(current.slice(Math.max(0, at - 40), at + 40))}`)
  }
  console.error('  run `node scripts/sync-qr-encoder.mjs` to regenerate')
  process.exit(1)
}

const source = readFileSync(QR, 'utf8')
const begin = source.indexOf(BEGIN)
const end = source.indexOf(END)
if (begin < 0 || end < 0 || end < begin) throw new Error('qr.js: markers missing or out of order')
writeFileSync(QR, source.slice(0, begin + BEGIN.length) + '\n' + extracted + '\n' + source.slice(end))
console.log(`sync-qr-encoder: wrote ${extracted.length} chars of encoder body into lib/qr.js`)
