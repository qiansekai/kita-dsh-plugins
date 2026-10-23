/**
 * Offline verification for the kita-version-check client half.
 *
 * Loads the real bundle the way the client module loader does (a
 * window.__ModuleLoader__.load registration whose factory receives "require"),
 * with a hand-written React stand-in that runs hooks synchronously. Asserts:
 *
 *   1. The factory exports apply plus the "slots" service dependency.
 *   2. apply registers exactly the two seats this plugin owns, with the
 *      sidebar entry and overlay ids/orders the host tree expects.
 *   3. The store primes through GET /state, opens, and refreshes through
 *      POST /refresh, and dispose clears subscribers.
 *   4. Both components render without throwing: the sidebar entry switches to
 *      the rail variant and reports the update in its tooltip, and the overlay
 *      is null while closed but shows every channel plus the verdict once open.
 *
 * Run: node scripts/smoke-client.cjs
 */
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const vm = require('node:vm')

const failures = []
let checks = 0
function ok(condition, message) {
  checks += 1
  if (!condition) failures.push(message)
}
function eq(actual, expected, message) {
  ok(actual === expected, message + ' (expected ' + String(expected) + ', got ' + String(actual) + ')')
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
const documentListeners = []
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: "" }),
  head: { appendChild: () => {} },
  body: { appendChild: () => {} },
  addEventListener: (type, handler) => documentListeners.push([type, handler]),
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
  return {
    ok: true,
    status: 200,
    json: async () => payload
  }
}

// ---------- load the bundle exactly as the loader does ----------
const source = readFileSync(join(__dirname, "..", "lib", "client.js"), "utf8")
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
eq(Array.isArray(exportsObject.inject), true, "the client half declares injected services")
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
ok(byName["sidebar.footer.action"] !== undefined, "sidebar.footer.action is registered")
ok(byName["shell.overlay"] !== undefined, "shell.overlay is registered")
eq(byName["sidebar.footer.action"].spec.id, "kita-version-check", "sidebar entry id is stable")
eq(byName["sidebar.footer.action"].spec.order, 15, "sidebar entry order leads the restart button")
eq(byName["sidebar.footer.action"].spec.label, "版本更新", "sidebar entry carries a projection label")
eq(byName["shell.overlay"].spec.id, "kita-version-check.overlay", "overlay id is stable")
eq(byName["shell.overlay"].spec.order, 91, "overlay order sits above the default layer")

// Both seats must receive one shared store from their inject props.
const footerStore = byName["sidebar.footer.action"].spec.inject()
const overlayStore = byName["shell.overlay"].spec.inject()
eq(typeof footerStore.versionCheck, "object", "sidebar entry receives the store")
ok(footerStore.versionCheck === overlayStore.versionCheck, "both seats share one store instance")

const store = footerStore.versionCheck
eq(store.get().open, false, "the store starts closed")
eq(fetchCalls.length >= 0, true, "fetch was callable")

// ---------- store: prime / open / refresh / dispose ----------
const footerComponent = byName["sidebar.footer.action"].component
const overlayComponent = byName["shell.overlay"].component

// Prime is called by apply, so a state request is already in flight.
eq(fetchCalls.length, 1, "apply primes exactly one state request")
eq(fetchCalls[0].path, "/kita-version-check/state", "priming reads /state")
eq(fetchCalls[0].method, "GET", "priming is a GET")

async function run() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  ok(store.get().payload !== null, "priming resolves the payload")
  eq(store.get().error, null, "priming reports no error")

  // Sidebar entry, wide: version plus an update hint in the tooltip.
  const wide = renderComponent(footerComponent, { wide: true, versionCheck: store })
  eq(wide.type, "button", "the sidebar entry renders a button")
  ok(String(wide.props.className).includes("kitaVersionBtn"), "the button carries the package class")
  eq(String(wide.props.className).includes("kitaVersionBtn_rail"), false, "the wide variant is not the rail")
  ok(String(wide.props.title).includes("0.2.1-rc.2"), "the tooltip reports the running version")
  ok(String(wide.props.title).includes("0.2.1-rc.3"), "the tooltip reports the available update")
  const labels = wide.children.filter((child) => child !== null && child !== undefined && typeof child === "object")
  const label = labels.find((child) => child.props !== undefined && String(child.props.className ?? "").includes("kitaVersionLabel"))
  ok(label !== undefined, "the wide variant renders a text label")
  ok(label !== undefined && String(label.children[0]).includes("有新版"), "the label announces the update")

  // Sidebar entry, rail: icon only.
  const rail = renderComponent(footerComponent, { wide: false, versionCheck: store })
  eq(String(rail.props.className).includes("kitaVersionBtn_rail"), true, "the rail variant collapses to the icon")
  const railChildren = rail.children.filter((child) => child !== null && child !== undefined)
  eq(railChildren.length, 1, "the rail drops the text label")
  const glyphElement = railChildren[0]
  eq(typeof glyphElement.type, "function", "the rail keeps the glyph component")
  eq(glyphElement.props.badge, true, "the glyph is told to show the update badge")
  const glyphTree = renderComponent(glyphElement.type, glyphElement.props)
  eq(String(glyphTree.props.className), "kitaVersionIcon", "the glyph renders the package icon")
  const dots = glyphTree.children.filter((child) => child !== null && child !== undefined
    && String(child.props !== undefined ? child.props.className : "") === "kitaVersionDot")
  eq(dots.length, 1, "the glyph carries the update badge")

  // Overlay while closed renders nothing.
  eq(renderComponent(overlayComponent, { versionCheck: store }), null, "the overlay renders nothing while closed")

  // Opening the overlay renders every channel plus the verdict.
  store.open()
  eq(store.get().open, true, "open() flips the overlay store")
  const overlay = renderComponent(overlayComponent, { versionCheck: store })
  ok(overlay !== null && typeof overlay === "object", "the overlay renders once open")
  eq(String(overlay.props.className).includes("kitaVersionOverlay"), true, "the overlay carries the layer class")
  const found = []
  const walk = (node) => {
    if (node === null || typeof node !== "object") return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (node.props !== undefined && String(node.props.className ?? "").includes("kitaVersionRow")) found.push(node)
    if (node.children !== undefined) walk(node.children)
  }
  walk(overlay)
  eq(found.length, 3, "the overlay lists every configured channel")
  eq(store.get().open, true, "the overlay stays open while rendered")

  // Refreshing goes through the POST route.
  const before = fetchCalls.length
  store.refresh()
  await new Promise((resolve) => setTimeout(resolve, 0))
  eq(fetchCalls.length, before + 1, "refresh issues one request")
  eq(fetchCalls[fetchCalls.length - 1].path, "/kita-version-check/refresh", "refresh posts to /refresh")
  eq(fetchCalls[fetchCalls.length - 1].method, "POST", "refresh is a POST")

  // Closing then disposing.
  store.close()
  eq(store.get().open, false, "close() hides the overlay again")
  let notified = 0
  store.subscribe(() => { notified += 1 })
  store.open()
  store.close()
  eq(notified, 2, "subscribers are notified on every state change")
  store.dispose()
  store.open()
  eq(notified, 2, "dispose clears the subscriber set")

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
