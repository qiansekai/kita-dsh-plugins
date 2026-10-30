#!/usr/bin/env node
// Verify every package in packages/ satisfies docs/bundle-spec.md.
// Usage: node scripts/check-packages.mjs [--profile-env <dir containing js-yaml>]
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const repoRoot = resolve(import.meta.dirname, '..')
const packagesDir = join(repoRoot, 'packages')

async function loadYaml() {
  const candidates = [
    'js-yaml',
    join(repoRoot, 'node_modules', 'js-yaml', 'index.js'),
    process.env.DSH_JS_YAML || '',
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      const mod = candidate.includes('/') || candidate.includes('\\')
        ? await import(pathToFileURL(candidate).href)
        : await import(candidate)
      return mod.default ?? mod
    } catch {}
  }
  return null
}

const yaml = await loadYaml()
const failures = []
const warnings = []
const fail = (pkg, msg) => failures.push(`${pkg}: ${msg}`)
const warn = (pkg, msg) => warnings.push(`${pkg}: ${msg}`)

const requiredPeers = ['@deepseek-ai/cordis']
const dirs = readdirSync(packagesDir).filter((name) => statSync(join(packagesDir, name)).isDirectory())

for (const dir of dirs) {
  const pkgDir = join(packagesDir, dir)
  const manifestPath = join(pkgDir, 'package.json')
  if (!existsSync(manifestPath)) { fail(dir, 'package.json missing'); continue }

  let manifest
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (error) { fail(dir, `package.json invalid JSON: ${error.message}`); continue }

  if (manifest.name !== dir) warn(dir, `package name "${manifest.name}" differs from directory "${dir}"`)
  if (manifest.type !== 'module') fail(dir, 'type must be "module"')
  if (!manifest.version) fail(dir, 'version missing')
  if (!manifest.description) warn(dir, 'description missing (GUI market list)')
  if (manifest.private === true) fail(dir, 'private:true blocks npm pack / sharing — remove it')

  const exportsMap = manifest.exports ?? {}
  if (!exportsMap['.']) fail(dir, 'exports["."] missing')
  if (!exportsMap['./package.json']) warn(dir, 'exports["./package.json"] missing')
  if (!exportsMap['./cordis.patch.yml']) fail(dir, 'exports["./cordis.patch.yml"] missing (profile cannot read the patch)')

  const bundlePatch = manifest.dsh?.bundle?.patch
  if (!bundlePatch) fail(dir, 'dsh.bundle.patch missing — not installable as a bundle')
  else if (bundlePatch !== './cordis.patch.yml') warn(dir, `dsh.bundle.patch is "${bundlePatch}" (expected "./cordis.patch.yml")`)

  for (const peer of requiredPeers) if (!manifest.peerDependencies?.[peer]) fail(dir, `peerDependencies["${peer}"] missing`)
  if (manifest.peerDependencies?.['cordis']) fail(dir, 'peerDependencies uses bare "cordis" — use "@deepseek-ai/cordis"')
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (range === '*') warn(dir, `peerDependencies["${name}"] is "*" — pin a range`)
  }

  const files = manifest.files ?? []
  if (!files.length) fail(dir, 'files[] missing')
  else {
    if (!files.some((entry) => entry === 'cordis.patch.yml')) fail(dir, 'files[] does not include cordis.patch.yml')
    if (!files.some((entry) => entry === 'lib' || entry.startsWith('lib/'))) fail(dir, 'files[] does not include lib')
  }

  const clientPath = join(pkgDir, 'lib', 'client.js')
  if (existsSync(clientPath)) {
    if (manifest.dsh?.client?.platform !== 'web') fail(dir, 'lib/client.js exists but dsh.client.platform !== "web"')
    if (!Array.isArray(manifest.dsh?.client?.inject)) fail(dir, 'dsh.client.inject must be an array (use [] when nothing is injected)')
  } else if (manifest.dsh?.client) {
    warn(dir, 'dsh.client declared but lib/client.js missing')
  }

  const patchPath = join(pkgDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) fail(dir, 'cordis.patch.yml missing')
  // Without js-yaml only the YAML body check is skipped; the summary says so
  // loudly instead of failing every package on a fresh clone.
  else if (!yaml) { /* skipped: see the NOTE line in the summary */ }
  else {
    try {
      const rows = yaml.load(readFileSync(patchPath, 'utf8'))
      if (!Array.isArray(rows) || rows.length === 0) fail(dir, 'cordis.patch.yml is not a non-empty list')
      else {
        const inserts = rows.flatMap((row) => Array.isArray(row?.insert) ? row.insert : [])
        const own = inserts.find((entry) => entry?.id === dir || entry?.name === dir)
        if (!own) fail(dir, `cordis.patch.yml does not insert itself (id/name "${dir}")`)
        for (const entry of inserts) {
          if (!entry?.id || !entry?.name) fail(dir, 'cordis.patch.yml insert entry needs both id and name')
          if (entry && typeof entry.config === 'object' && entry.config !== null) {
            const indexSource = existsSync(join(pkgDir, 'lib', 'index.js')) ? readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8') : ''
            for (const [key, value] of Object.entries(entry.config)) {
              if (typeof value === 'string' && /^[A-Za-z]:[\\/]/.test(value)) fail(dir, `patch config "${key}" hardcodes an absolute Windows path`)
              // A typo here is silent at runtime: schemastery keeps unknown keys, so the
              // deployment value is accepted and then ignored by the plugin itself.
              if (indexSource !== '' && !new RegExp(`\\b${key}\\s*:`).test(indexSource)) fail(dir, `patch config "${key}" is not declared in lib/index.js (typo?)`)
            }
          }
        }
        const disabled = rows.filter((row) => row?.id && row.disabled === true)
        for (const row of disabled) if (row.name) fail(dir, `disabled row "${row.id}" must not carry a name`)
      }
    } catch (error) { fail(dir, `cordis.patch.yml invalid YAML: ${error.message}`) }
  }

  const libDir = join(pkgDir, 'lib')
  const entry = manifest.main ?? 'lib/index.js'
  const entryPath = join(pkgDir, entry)
  if (!existsSync(entryPath)) fail(dir, `entry "${entry}" missing`)
  // A backup file on disk is harmless (gitignored); what matters is whether files[]
  // would pack it. Broad entries such as "lib" or "lib/" sweep in lib/*.bak-*.
  const broad = files.filter((entry) => {
    if (typeof entry !== 'string') return false
    if (entry === 'lib' || entry === 'lib/' || entry === 'lib/**' || entry === '.' || entry === '**') return true
    // A directory entry with no extension filter sweeps in every sibling file,
    // including local lib/*.bak-* backups; "lib/types/**/*.d.ts" does not.
    return entry.endsWith('/') && !/\.[a-z0-9]+$/i.test(entry)
  })
  if (broad.length) fail(dir, `files[] entry "${broad[0]}" packs the whole directory — list "lib/*.js" so local .bak files never ship`)
  const toCheck = [entry, ...(existsSync(clientPath) ? [clientPath] : [])]
  for (const file of toCheck) {
    if (!existsSync(file)) continue
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status !== 0) fail(dir, `node --check failed for ${basename(file)}: ${(result.stderr || '').split('\n')[0]}`)
  }

  const readme = join(pkgDir, 'README.md')
  if (!existsSync(readme)) warn(dir, 'README.md missing')
  else {
    const text = readFileSync(readme, 'utf8')
    if (text.length < 200) warn(dir, 'README.md is very short — document install, config and limits')
  }
}

console.log(`checked ${dirs.length} packages under packages/`)
for (const line of warnings) console.log(`WARN  ${line}`)
for (const line of failures) console.log(`FAIL  ${line}`)
if (!yaml) console.log('NOTE  cordis.patch.yml was NOT validated (js-yaml missing) — run "npm i" at the repo root, then rerun for the full check')
if (failures.length > 0) {
  console.log(`${failures.length} failure(s)`)
  process.exit(1)
}
console.log(yaml ? `OK — ${dirs.length} packages pass` : `PARTIAL — ${dirs.length} packages pass (patch YAML not validated)`)
process.exit(0)
