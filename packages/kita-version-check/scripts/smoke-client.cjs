/**
 * Offline verification for the kita-version-check client half.
 *
 * Loads the real bundle the way the client module loader does (a
 * window.__ModuleLoader__.load registration whose factory receives "require"),
 * with a hand-written React stand-in that runs hooks synchronously. Asserts:
 *
 *   1. The factory exports apply plus the "slots" service dependency.
 *   2. apply registers exactly the two seats this plugin owns - the sidebar
 *      panel icon and the main panel under the SAME id/key - and nothing in the
 *      sidebar foot, which belongs to the restart entry.
 *   3. The store primes through GET /state and refreshes through POST /refresh.
 *   4. Both components render without throwing, and the stylesheet stays
 *      opaque and inside the documented theme token set.
 *
 * Run: node scripts/smoke-client.cjs
 */
const { readFileSync } = require("node:fs")
const { join } = require("node:path")
const vm = require("node:vm")

const failures = []
let checks = 0
function ok(condition, message) {
  checks += 1
  if (!condition) failures.push(message)
}
function eq(actual, expected, message) {
  ok(actual === expected, message + " (expected " + String(expected) + ", got " + String(actual) + ")")
}

// ---------- React stand-in: hooks run synchronously per render ----------
let render = { index: 0, slots: [] }
const react = {
  createElement(type, props, ...children) {
    const flat = []
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child)
      else flat.push(child)
    }
    return { type, props: props === null || props === undefined ? {} : props, children: flat }
  },
  useState(initial) {
    const index = render.index
    render.index += 1
    if (!(index in render.slots)) render.slots[index] = initial
    const set = (next) => {
      render.slots[index] = typeof next === "function" ? next(render.slots[index]) : next
    }
    return [render.slots[index], set]
  },
  useEffect(effect) {
    render.index += 1
    try {
      const cleanup = effect()
      if (typeof cleanup === "function") render.slots.push(cleanup)
    } catch (error) {
      failures.push("useEffect threw: " + String(error && error.message ? error.message : error))
    }
    return undefined
  }
}

function renderComponent(component, props) {
  render = { index: 0, slots: [] }
  return component(props)
}

// ---------- DOM stand-in ----------
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
  addEventListener: () => {},
  removeEventListener: () => {}
}

// ---------- host payload fixture ----------
const payload = {
  ok: true,
  current: {
    version: "0.2.1-rc.2",
    resolved: true,
    packageJson: "D:/envs/alpha-test/env/node_modules/@deepseek-ai/dsh/package.json",
    env: "alpha-test",
    envsDir: "D:/envs",
    home: "D:/envs/alpha-test/home"
  },
  channels: [
    { tag: "latest", version: "0.2.1-rc.2", publishedAt: "2026-10-17T08:36:31.000Z", relation: "equal", behind: false },
    { tag: "next", version: "0.2.1-rc.3", publishedAt: "2026-10-23T07:54:30.000Z", relation: "newer", behind: true },
    { tag: "alpha", version: "0.2.1-alpha.5", publishedAt: "2026-10-16T12:31:49.000Z", relation: "older", behind: false }
  ],
  newest: { tag: "next", version: "0.2.1-rc.3", publishedAt: "2026-10-23T07:54:30.000Z", relation: "newer", behind: true },
  anyUpdate: true,
  recent: [
    { version: "0.2.1-rc.3", publishedAt: "2026-10-23T07:54:30.000Z" },
    { version: "0.2.1-rc.2", publishedAt: "2026-10-17T08:36:31.000Z" },
    { version: "0.2.1-rc.1", publishedAt: "2026-10-17T03:17:24.000Z" },
    { version: "0.2.1-alpha.5", publishedAt: "2026-10-16T12:31:49.000Z" }
  ],
  checkedAt: Date.now(),
  cached: true,
  via: "direct",
  registry: "https://registry.npmjs.org",
  packageName: "@deepseek-ai/dsh",
  refreshIntervalMinutes: 60,
  error: null
}

const fetchCalls = []
async function fakeFetch(path, options) {
  fetchCalls.push({ path, method: options === undefined ? "" : options.method })
  return { ok: true, status: 200, json: async () => payload }
}

// ---------- load the bundle exactly as the loader does ----------
const source = readFileSync(join(__dirname, "..", "lib", "client.js"), "utf8")

// The page must stay fully opaque: a translucent surface over live content is
// what made text unreadable. Only documented theme tokens may be used, so a
// typo'd variable cannot silently leave text unthemed.
const THEME_TOKENS = [
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-brand-primary",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-idle-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-specific-sidebar-fill"
]
const usedTokens = [...new Set([...source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((match) => match[1]))]
const unknownTokens = usedTokens.filter((token) => !THEME_TOKENS.includes(token))
eq(unknownTokens.length, 0, "every theme token is documented (unknown: " + unknownTokens.join(", ") + ")")
ok(usedTokens.length >= 8, "the stylesheet themes through tokens, not literal colors")
ok(source.includes("color-mix") === false, "no color-mix translucency in the stylesheet")
ok(source.includes("backdrop-filter") === false, "no backdrop blur behind text")
ok(source.includes("--dsw-specific-menu") === false, "no translucent menu surface")
ok(source.includes("--dsw-alias-label-tertiary") === false, "no undocumented tertiary label token")
ok(source.includes("color:#fff") === false, "no hard-coded white text on themed surfaces")

let captured = null
const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => { captured = spec } } },
  document: fakeDocument,
  fetch: fakeFetch,
  console
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: "client.js" })

ok(captured !== null, "the bundle registers itself through window.__ModuleLoader__.load")
eq(captured === null ? "" : captured.id, "kita-version-check", "bundle id is the package name")
const factory = captured === null ? null : captured.factory
ok(typeof factory === "function", "the registration carries a factory")
if (typeof factory !== "function") {
  console.error("smoke-client: FAILED before the factory could run")
  process.exit(1)
}

const exportsObject = factory((name) => {
  if (name === "react") return react
  throw new Error("unexpected require: " + name)
})
eq(typeof exportsObject.apply, "function", "the client half exports apply")
eq(String(exportsObject.inject), "slots", "the only client service dependency is slots")

// ---------- capture ctx: slots + effect ----------
const registrations = []
const disposers = []
let injects = 0
const ctx = {
  slots: {
    inject(name, factory_) {
      injects += 1
      ok(typeof factory_ === "function", "slots.inject for " + name + " receives a factory")
      factory_()
    },
    register(spec, component) {
      registrations.push({ spec, component })
      return () => {}
    }
  },
  effect(factory_) {
    disposers.push(factory_())
    return () => {}
  }
}

exportsObject.apply(ctx)

eq(injects, 2, "apply injects into exactly two slots")
eq(registrations.length, 2, "apply registers exactly two seats")
const byName = {}
for (const entry of registrations) byName[entry.spec.name] = entry
ok(byName["main"] !== undefined, "the main panel is registered")
ok(byName["sidebar.panellist"] !== undefined, "the sidebar panel icon is registered")
eq(byName["sidebar.footer.action"], undefined, "the sidebar foot stays free for the restart entry")
eq(byName["shell.overlay"], undefined, "no overlay seat is taken")

const panelKey = byName["main"].spec.key
eq(panelKey, "kita-version-check", "the main panel key is the package id")
eq(byName["sidebar.panellist"].spec.id, panelKey, "the sidebar entry id matches the main panel key")
eq(byName["sidebar.panellist"].spec.order, 20, "the sidebar entry sorts after Plugins and Schedules")
eq(byName["sidebar.panellist"].spec.label, "版本更新", "the sidebar entry carries a projection label")

const iconStore = byName["sidebar.panellist"].spec.inject()
const panelStore = byName["main"].spec.inject()
ok(iconStore.versionCheck === panelStore.versionCheck, "both seats share one store instance")
const store = iconStore.versionCheck

// ---------- store: prime / refresh / dispose ----------
eq(fetchCalls.length, 1, "apply primes exactly one state request")
eq(fetchCalls[0].path, "/kita-version-check/state", "priming reads /state")
eq(fetchCalls[0].method, "GET", "priming is a GET")

const iconComponent = byName["sidebar.panellist"].component
const panelComponent = byName["main"].component

async function run() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok(store.get().payload !== null, "priming resolves the payload")

  // Sidebar icon: glyph plus the update dot, sized by the owner.
  const icon = renderComponent(iconComponent, { size: 20, active: false, versionCheck: store })
  eq(String(icon.props.className), "kitaVersionIcon", "the sidebar entry renders the icon frame")
  const iconChildren = icon.children.filter((child) => child !== null && child !== undefined)
  eq(iconChildren.length, 2, "the icon carries the glyph and the update dot")
  eq(typeof iconChildren[0].type, "function", "the first child is the glyph component")
  eq(iconChildren[0].props.size, 20, "the glyph follows the requested icon size")
  eq(String(iconChildren[1].props.className), "kitaVersionDot", "the update dot is present while a release is waiting")
  const glyphTree = renderComponent(iconChildren[0].type, iconChildren[0].props)
  eq(glyphTree.type, "svg", "the glyph renders an svg")

  // Main panel: version, verdict, channels, recent releases, refresh button.
  const panel = renderComponent(panelComponent, { versionCheck: store })
  eq(String(panel.props.className), "kitaVersionPanel", "the panel renders the page container")
  const found = []
  const texts = []
  const walk = (node) => {
    if (node === null || typeof node !== "object") {
      if (typeof node === "string") texts.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node.props !== undefined && String(node.props.className ?? "").includes("kitaVersionRow")) found.push(node)
    if (node.children !== undefined) walk(node.children)
  }
  walk(panel)
  eq(found.length, 3, "the panel lists every configured channel")
  const joined = texts.join(" | ")
  ok(joined.includes("DSH 版本与更新"), "the panel is titled")
  ok(joined.includes("v0.2.1-rc.2"), "the panel reports the running version")
  ok(joined.includes("alpha-test"), "the panel reports the deployment name")
  ok(joined.includes("上游有新版本"), "the verdict announces the available release")
  ok(joined.includes("0.2.1-rc.3"), "the verdict names the available version")
  ok(joined.includes("最近发布"), "recent releases are listed")

  // Refreshing goes through the POST route.
  const before = fetchCalls.length
  store.refresh()
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq(fetchCalls.length, before + 1, "refresh issues one request")
  eq(fetchCalls[fetchCalls.length - 1].path, "/kita-version-check/refresh", "refresh posts to /refresh")
  eq(fetchCalls[fetchCalls.length - 1].method, "POST", "refresh is a POST")

  // Subscribers are notified, and dispose clears them.
  let notified = 0
  store.subscribe(() => { notified += 1 })
  store.refresh()
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok(notified >= 2, "subscribers observe loading and completion")
  store.dispose()
  const afterDispose = notified
  store.refresh()
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq(notified, afterDispose, "dispose clears the subscriber set")

  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      /* best effort */
    }
  }

  if (failures.length === 0) {
    console.log("smoke-client: OK (" + String(checks) + " checks)")
    process.exit(0)
  }
  console.error("smoke-client: FAILED " + String(failures.length) + "/" + String(checks))
  for (const failure of failures) console.error("  - " + failure)
  process.exit(1)
}

void run()
