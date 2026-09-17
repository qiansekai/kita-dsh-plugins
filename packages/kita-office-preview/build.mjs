/**
 * Build script for kita-office-preview.
 *
 * Produces two artifacts:
 *   lib/index.js   host half - empty apply, so the package appears in the host
 *                  Loader and its lifecycle is owned by the host.
 *   lib/client.js  browser half - a client module-system CJS bundle in the
 *                  `window.__ModuleLoader__.load({ id, factory })` form the
 *                  shell expects, with the office renderers bundled in.
 *
 * Why bundle instead of shipping plain ESM: a client bundle's `require` only
 * resolves seed words (react, react/jsx-runtime, url) and other registered
 * module-graph rows (see @deepseek-ai/dsh-client-modules client/manifest).
 * Third-party npm libraries are not graph rows, so they must be inlined.
 * `react` and `react/jsx-runtime` stay external because the shell provides them.
 */
import { build } from 'esbuild'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const outdir = join(root, 'lib')
const pluginId = 'kita-office-preview'

const hostHalf = `//#region lib/index.js
/**
 * ${pluginId}, host half. Pure client plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader (load and lifecycle follow the
 * host; the browser half ships via exports["./client"], discovered through the
 * package.json dsh.client declaration).
 */
/** Host plugin body - no host-side behavior for this plugin. */
function apply() {}
//#endregion
export { apply };
`

// The shell installs this facade on window before any bundle script runs; the
// factory receives the synchronous require bound to the client module table.
const banner = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pluginId)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
`

const footer = `
    return module.exports;
  }
});
`

await mkdir(outdir, { recursive: true })
await writeFile(join(outdir, 'index.js'), hostHalf, 'utf8')

// Generated CommonJS shims for packages whose browser build is only published
// as UMD. Kept out of version control (node_modules is ignored).
const shimDir = join(root, 'node_modules', '.kita-office-preview')

/**
 * Load `@js-preview/excel` as CommonJS.
 *
 * The package publishes `lib/index.js` (a node-flavoured ESM build that
 * unconditionally imports `stream`/`events`/`buffer`/`util`) alongside the
 * browser UMD `lib/index.umd.js`, and its manifest carries no `browser` field
 * to choose between them. Copying the UMD to a `.cjs` path makes esbuild treat
 * it as CommonJS regardless of the enclosing `"type": "module"`, which is what
 * lets the UMD's `module.exports` branch run instead of the `require("stream")`
 * branch. The filter is anchored so the package's `lib/index.css` subpath still
 * resolves normally.
 */
const excelUmdAsCjs = {
  name: 'excel-umd-as-cjs',
  setup(pluginBuild) {
    const source = join(root, 'node_modules/@js-preview/excel/lib/index.umd.js')
    const shim = join(shimDir, 'excel-preview.umd.cjs')
    pluginBuild.onResolve({ filter: /^@js-preview\/excel$/ }, async () => {
      await mkdir(shimDir, { recursive: true })
      await copyFile(source, shim)
      return { path: shim }
    })
  },
}

/**
 * Stub the node builtins that survived into a browser bundle.
 *
 * The only live reference is lodash's `require("util").types` feature probe
 * inside the lodash copy bundled with `@js-preview/excel`; it sits behind a
 * `module`/`require` existence check and a try/catch, so the browser never
 * reaches it, but esbuild still resolves it statically. Keeping it stub-only
 * (rather than polyfilling) records that no browser path depends on it.
 */
const NODE_BUILTIN_STUBS = {
  stream:
    'export default {}; export const Stream = class {}; export const Readable = class {}; export const Writable = class {}; export const Duplex = class {}; export const Transform = class {}; export const PassThrough = class {};',
  events: 'class EventEmitter {} export default EventEmitter; export { EventEmitter };',
  buffer:
    'export const Buffer = globalThis.Buffer; export const SlowBuffer = globalThis.Buffer; export default { Buffer: globalThis.Buffer, SlowBuffer: globalThis.Buffer };',
  util:
    'export const types = {}; export function inherits() {} export function format() { return ""; } export function inspect(value) { return String(value); } export function isArray(value) { return Array.isArray(value); } export default { types: {}, inherits() {}, format() { return ""; }, inspect(value) { return String(value); }, isArray: Array.isArray };',
}

const nodeBuiltinStub = {
  name: 'node-builtin-stub',
  setup(pluginBuild) {
    const filter = new RegExp(`^(${Object.keys(NODE_BUILTIN_STUBS).join('|')})$`)
    pluginBuild.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'node-builtin-stub' }))
    pluginBuild.onLoad({ filter: /.*/, namespace: 'node-builtin-stub' }, (args) => ({
      contents: NODE_BUILTIN_STUBS[args.path] ?? 'export default {};',
      loader: 'js',
    }))
  },
}

const result = await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(outdir, 'client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  minify: true,
  sourcemap: false,
  legalComments: 'inline',
  logLevel: 'info',
  // The bundle is loaded as a classic script, so nothing would fetch a sibling
  // .css file; stylesheet imports become text the body injects itself.
  loader: { '.css': 'text' },
  plugins: [excelUmdAsCjs, nodeBuiltinStub],
  // Provided by the shell's module table; must not be inlined.
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  banner: { js: banner },
  footer: { js: footer },
  metafile: true,
})

const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0)
console.log(`[${pluginId}] lib/client.js written, ${(bytes / 1024 / 1024).toFixed(2)} MB`)
