#!/usr/bin/env node
/**
 * Install (or uninstall) this repository's plugins into a local DSH profile.
 *
 * What "install" means for DSH 0.2.x:
 *   1. the package is added to the profile's package.json dependencies as a link:
 *   2. the package name is appended to dsh.profile.bundles, which is what makes
 *      the profile load the package's own cordis.patch.yml (the bundle patch)
 * Nothing here restarts the server: the caller decides when to restart.
 *
 * Usage:
 *   node scripts/install.mjs [options]
 *
 * Options:
 *   --profile <name>   DSH profile to install into (default: web)
 *   --home <dir>       DSH home (default: $DSH_HOME or ~/.dsh)
 *   --only <a,b,c>     install only these package names (or directories)
 *   --dry-run          print the planned commands / manifest edits
 *   --uninstall        remove instead of install
 *   --list             list the packages this repository can install
 *   --force            install packages that do not declare a bundle patch
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const packagesDir = join(repoRoot, 'packages')

function parseArgs(argv) {
  const options = { profile: 'web', home: '', only: [], dryRun: false, uninstall: false, list: false, force: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--profile') options.profile = argv[++index]
    else if (arg === '--home') options.home = argv[++index]
    else if (arg === '--only') options.only = String(argv[++index] ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--uninstall') options.uninstall = true
    else if (arg === '--list') options.list = true
    else if (arg === '--force') options.force = true
    else if (arg === '--help' || arg === '-h') { printHelp(); process.exit(0) }
    else { console.error(`unknown argument: ${arg}`); process.exit(2) }
  }
  return options
}

function printHelp() {
  console.log(readFileSync(join(import.meta.dirname, 'install.mjs'), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^\s*\* ?/gm, ''))
}

/** Every package in packages/ with the fields the installer needs. */
function discover() {
  return readdirSync(packagesDir)
    .filter((name) => statSync(join(packagesDir, name)).isDirectory())
    .map((dir) => {
      const manifestPath = join(packagesDir, dir, 'package.json')
      if (!existsSync(manifestPath)) return null
      let manifest
      try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch (error) {
        console.error(`skip ${dir}: package.json is not valid JSON (${error.message})`)
        return null
      }
      const patch = manifest.dsh?.bundle?.patch
      const platform = manifest.dsh?.client?.platform === 'web' ? 'host + client' : 'host'
      return { dir, cwd: join(packagesDir, dir), name: manifest.name, version: manifest.version, description: manifest.description ?? '', platform, hasBundle: Boolean(patch) && existsSync(join(packagesDir, dir, patch)) }
    })
    .filter(Boolean)
}

function resolveHome(options) {
  if (options.home) return resolve(options.home)
  if (process.env.DSH_HOME) return resolve(process.env.DSH_HOME)
  return join(homedir(), '.dsh')
}

/** Run a command and stream its output. Returns the exit code. */
function run(command, args, cwd, dryRun, extraEnv) {
  const printable = [command, ...args].map((part) => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
  if (dryRun) { console.log(`  [dry-run] (cwd ${cwd}) ${printable}`); return 0 }
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', env: extraEnv ? { ...process.env, ...extraEnv } : process.env })
  if (result.error) { console.error(`  command failed to start: ${result.error.message}`); return 1 }
  return result.status ?? 1
}

function hasCommand(command) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { encoding: 'utf8', shell: process.platform === 'win32' })
  return probe.status === 0
}

/** The command that adds/removes a dependency inside a profile. */
function packageManager(profileDir, home) {
  if (hasCommand('dsh')) {
    // "dsh plugin" resolves the profile from the environment, so inheriting a
    // different DSH_HOME would install into the wrong deployment - often the one
    // that is already running. Pin the child's home explicitly.
    return {
      add: (spec) => ['dsh', ['plugin', '--profile', profileName, 'add', spec]],
      remove: (spec) => ['dsh', ['plugin', '--profile', profileName, 'remove', spec]],
      kind: 'dsh plugin',
      env: { DSH_HOME: home },
    }
  }
  if (hasCommand('pnpm')) {
    // "-w" is only legal inside a pnpm workspace; a freshly created profile may
    // not have pnpm-workspace.yaml yet, and pnpm 10 then hard-fails with
    // "--workspace-root may only be used inside a workspace".
    const isWorkspace = existsSync(join(profileDir, 'pnpm-workspace.yaml')) || existsSync(join(profileDir, 'pnpm-workspace.yml'))
    const flags = isWorkspace ? ['-w', '--config.ignore-workspace-root-check=true'] : ['--config.ignore-workspace-root-check=true']
    return {
      add: (spec) => ['pnpm', ['add', ...flags, spec]],
      remove: (spec) => ['pnpm', ['remove', ...flags, spec]],
      kind: isWorkspace ? 'pnpm (workspace root)' : 'pnpm',
    }
  }
  return null
}

let profileName = 'web'

function readManifest(profileDir) {
  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) return { manifestPath, manifest: null }
  return { manifestPath, manifest: JSON.parse(readFileSync(manifestPath, 'utf8')) }
}

function writeManifest(manifestPath, manifest, dryRun) {
  if (dryRun) { console.log(`  [dry-run] would rewrite ${manifestPath}`); return }
  const stamp = new Date().toISOString().replace(/[:.]/g, '').replace('T', '-').slice(0, 15)
  copyFileSync(manifestPath, `${manifestPath}.bak-pre-kita-install-${stamp}`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  profileName = options.profile
  const all = discover()

  if (options.list) {
    for (const item of all) {
      const bundle = item.hasBundle ? 'bundle' : 'no bundle patch'
      console.log(`${item.name.padEnd(32)} ${String(item.version).padEnd(10)} ${item.platform.padEnd(13)} ${bundle}  ${item.description}`)
    }
    return
  }

  // Packages whose artifact is tied to an exact dsh build; installing them on a
  // different version can leave the GUI blank. Explicit --only or --force opts in.
  const DEFAULT_SKIP = new Set(['kita-workspace-ui'])
  const selected = options.only.length
    ? all.filter((item) => options.only.includes(item.name) || options.only.includes(item.dir))
    : all.filter((item) => options.force || !DEFAULT_SKIP.has(item.dir))
  if (!options.uninstall && !options.only.length) {
    const skipped = all.filter((item) => DEFAULT_SKIP.has(item.dir) && !options.force)
    for (const item of skipped) console.log(`skip  ${item.name}: version-bound artifact — install with --only ${item.dir} when your dsh matches`)
  }
  if (selected.length === 0) { console.error('no packages matched'); process.exit(2) }
  const unknown = options.only.filter((want) => !all.some((item) => item.name === want || item.dir === want))
  if (unknown.length) console.error(`warning: --only matched nothing for: ${unknown.join(', ')}`)

  const home = resolveHome(options)
  const profileDir = join(home, 'profiles', profileName)
  if (!existsSync(join(profileDir, 'package.json'))) {
    console.error(`profile "${profileName}" not found at ${profileDir}`)
    console.error('  start dsh once (it creates the profile), or pass --home <DSH_HOME> / --profile <name>.')
    process.exit(1)
  }
  const manager = packageManager(profileDir, home)
  if (!manager) { console.error('neither "dsh" nor "pnpm" is on PATH; install pnpm first (npm i -g pnpm).'); process.exit(1) }

  console.log(`DSH home : ${home}`)
  console.log(`profile  : ${profileName} (${profileDir})`)
  console.log(`manager  : ${manager.kind}`)
  console.log(`action   : ${options.uninstall ? 'uninstall' : 'install'}`)
  console.log('')

  const { manifestPath, manifest } = readManifest(profileDir)
  if (!manifest) { console.error(`cannot read ${manifestPath}`); process.exit(1) }
  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? [...manifest.dsh.profile.bundles] : []
  manifest.dependencies ??= {}

  let failures = 0
  let changed = false
  for (const item of selected) {
    if (!item.hasBundle && !options.force) {
      console.log(`skip  ${item.name}: no dsh.bundle.patch (pass --force to install anyway)`)
      continue
    }
    const linkSpec = `link:${item.cwd}`
    if (options.uninstall) {
      const [command, args] = manager.remove(item.name)
      if (run(command, args, profileDir, options.dryRun, manager.env) !== 0) { failures += 1; console.error(`  remove failed for ${item.name}`); continue }
      delete manifest.dependencies[item.name]
      const index = bundles.indexOf(item.name)
      if (index >= 0) bundles.splice(index, 1)
      changed = true
      console.log(options.dryRun ? `would remove ${item.name}` : `removed ${item.name}`)
      continue
    }
    const [command, args] = manager.add(linkSpec)
    if (run(command, args, profileDir, options.dryRun, manager.env) !== 0) { failures += 1; console.error(`  install failed for ${item.name}`); continue }
    manifest.dependencies[item.name] = linkSpec
    if (!bundles.includes(item.name)) bundles.push(item.name)
    changed = true
    console.log(options.dryRun ? `would install ${item.name}` : `installed ${item.name}`)
  }

  manifest.dsh.profile.bundles = bundles
  // Do not rewrite the manifest when every package failed: a partially applied
  // install is harder to reason about than no change at all.
  if (changed) writeManifest(manifestPath, manifest, options.dryRun)
  else console.log('profile manifest unchanged (no package was installed or removed)')

  console.log('')
  // kita-session-title-auto disables the official first-prompt title provider and
  // does not replace it; automatic re-titling needs the official all-prompts bundle.
  const officialTitleBundle = '@deepseek-ai/dsh-experimental-session-titles-bundle'
  if (!options.uninstall && bundles.includes('kita-session-title-auto') && !bundles.includes(officialTitleBundle)) {
    console.log(`note  kita-session-title-auto 停用了官方首条消息标题提供者；要自动重拟标题，还需要把 ${officialTitleBundle} 也加进 bundles`)
  }
  if (failures) console.log(`${failures} package(s) failed; the profile manifest was still updated for the rest.`)
  if (options.uninstall) console.log('restart the dsh web server for the removal to take effect.')
  else console.log('restart the dsh web server (or click the sidebar restart button once) so the new host halves and client entries load.')
  process.exit(failures ? 1 : 0)
}

main()
