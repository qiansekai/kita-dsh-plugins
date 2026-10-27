/**
 * Offline verification for the kita-reconnect-on-visible client bundle.
 *
 * Runs in plain Node with mocked browser globals: the bundle is a CJS module
 * registered through window.__ModuleLoader__, so the test loads it, captures the
 * factory, and exercises both the pure list-comparison helpers and the apply()
 * decision paths (reload vs banner vs no-op).
 *
 * Run: node scripts/verify-client.mjs
 */
import { strict as assert } from "node:assert";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
let moduleSeq = 0;
let reloads = 0;
const storage = new Map();

// ---- browser globals -------------------------------------------------------
function makeElement(tag) {
  const el = {
    tagName: tag,
    id: "",
    textContent: "",
    value: "",
    type: "",
    style: { cssText: "" },
    children: [],
    listeners: {},
    clicks: 0,
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(key, value) { this[key] = value; },
    remove() { const at = ELEMENTS.indexOf(this); if (at >= 0) ELEMENTS.splice(at, 1); },
    click() { this.clicks += 1; if (typeof this.listeners.click === "function") this.listeners.click(); },
  };
  ELEMENTS.push(el);
  return el;
};
const ELEMENTS = [];
const body = makeElement("body");
let composerCard = null;
let composerField = null;
let disconnectedButton = null;
const doc = {
  visibilityState: "visible",
  body,
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
  removeEventListener(type) { delete this.listeners[type]; },
  querySelector(selector) {
    if (selector === 'button[data-phase="disconnected"]') return disconnectedButton;
    if (selector === "[data-composer-card]") return composerCard;
    return null;
  },
  getElementById(id) { return ELEMENTS.find((el) => el.id === id) ?? null; },
  createElement(tag) { return makeElement(tag); },
};
globalThis.document = doc;
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)); },
  removeItem: (key) => { storage.delete(key); },
};
globalThis.location = { reload: () => { reloads += 1; } };

// ---- bundle loading -------------------------------------------------------
async function loadBundle() {
  let captured = null;
  globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition; } } };
  const url = pathToFileURL(path.join(ROOT, "lib", "client.js")).href + "?case=" + (moduleSeq++);
  await import(url);
  assert.ok(captured !== null, "bundle must register through window.__ModuleLoader__");
  assert.equal(captured.id, "kita-reconnect-on-visible");
  const exports = captured.factory(() => { throw new Error("the bundle must not require anything"); });
  return exports;
}

function mockCtx({ sessions, remote }) {
  const disposers = [];
  return {
    sessions,
    remote,
    get(name) {
      if (name === "sessions") return sessions;
      if (name === "remote") return remote;
      return undefined;
    },
    effect(fn) { const dispose = fn(); disposers.push(dispose); return dispose; },
    disposers,
  };
}

const passed = [];
const fail = (name, error) => { console.error("FAIL", name, "-", error?.message ?? error); process.exitCode = 1; };
async function test(name, fn) {
  try { await fn(); passed.push(name); } catch (error) { fail(name, error); }
}

// ---- pure helpers ---------------------------------------------------------
await test("sessionMissing: reports Host Sessions the client list lacks", async () => {
  const { __test } = await loadBundle();
  const missing = __test.sessionMissing(
    [{ sessionId: "a" }, { sessionId: "b" }, { sessionId: "c" }],
    { phase: "ready", byId: { a: {}, b: {} } },
  );
  assert.deepEqual(missing, ["c"]);
});

await test("sessionMissing: ignores subagent children", async () => {
  const { __test } = await loadBundle();
  const missing = __test.sessionMissing(
    [{ sessionId: "a" }, { sessionId: "s", origin: "subagent" }],
    { phase: "ready", byId: { a: {} } },
  );
  assert.deepEqual(missing, []);
});

await test("sessionMissing: refuses unsafe comparisons", async () => {
  const { __test } = await loadBundle();
  assert.equal(__test.sessionMissing(null, { phase: "ready", byId: {} }), null);
  assert.equal(__test.sessionMissing([], null), null);
  assert.equal(__test.sessionMissing([{ sessionId: "a" }], { phase: "pending", byId: {} }), null);
  assert.equal(__test.sessionMissing([{ sessionId: "a" }], { phase: "ready" }), null);
});

await test("sessionMissing: tolerates malformed rows", async () => {
  const { __test } = await loadBundle();
  const missing = __test.sessionMissing(
    [null, 7, { sessionId: "" }, { sessionId: 42 }, { sessionId: "a" }],
    { phase: "ready", byId: {} },
  );
  assert.deepEqual(missing, ["a"]);
});

await test("missingSignature: order independent", async () => {
  const { __test } = await loadBundle();
  assert.equal(__test.missingSignature(["b", "a"]), __test.missingSignature(["a", "b"]));
  assert.notEqual(__test.missingSignature(["a"]), __test.missingSignature(["a", "b"]));
});

await test("reloadAllowed: cooldown then release", async () => {
  const { __test } = await loadBundle();
  storage.clear();
  assert.equal(__test.reloadAllowed("sig", 1_000_000), true);
  storage.set("kita-reconnect-on-visible.reloadGuard", JSON.stringify({ signature: "sig", at: 1_000_000 }));
  assert.equal(__test.reloadAllowed("sig", 1_000_000 + 30_000), false, "min gap");
  assert.equal(__test.reloadAllowed("other", 1_000_000 + 30_000), false, "min gap applies to any signature");
  assert.equal(__test.reloadAllowed("other", 1_000_000 + 70_000), true, "different signature after min gap");
  assert.equal(__test.reloadAllowed("sig", 1_000_000 + 70_000), false, "same signature still cooling down");
  assert.equal(__test.reloadAllowed("sig", 1_000_000 + 600_001), true, "cooldown elapsed");
  storage.set("kita-reconnect-on-visible.reloadGuard", "{not json");
  assert.equal(__test.reloadAllowed("sig", 5), true, "corrupt guard must not block");
});

await test("composerHasDraft: detects typed text only", async () => {
  const { __test } = await loadBundle();
  composerCard = null;
  assert.equal(__test.composerHasDraft(), false);
  composerField = { value: "   " };
  composerCard = { querySelector: () => composerField };
  assert.equal(__test.composerHasDraft(), false);
  composerField = { value: "half a sentence" };
  assert.equal(__test.composerHasDraft(), true);
  composerField = { textContent: "contenteditable draft" };
  assert.equal(__test.composerHasDraft(), true);
  composerCard = null;
});

await test("autoReloadEnabled: default on, storage switch off", async () => {
  const { __test } = await loadBundle();
  storage.delete("kita-reconnect-on-visible.autoReload");
  assert.equal(__test.autoReloadEnabled(), true);
  storage.set("kita-reconnect-on-visible.autoReload", "off");
  assert.equal(__test.autoReloadEnabled(), false);
  storage.delete("kita-reconnect-on-visible.autoReload");
});

// ---- apply() decision paths -----------------------------------------------
const LOCAL = { phase: "ready", byId: { a: {} } };
const HOST_STALE = { ok: true, value: { items: [{ sessionId: "a" }, { sessionId: "b" }] } };
const HOST_CLEAN = { ok: true, value: { items: [{ sessionId: "a" }] } };

await test("apply: auto reloads once when the Host has unknown Sessions", async () => {
  storage.clear();
  reloads = 0;
  disconnectedButton = null;
  composerCard = null;
  const { apply } = await loadBundle();
  const ctx = mockCtx({ sessions: { list: { getSnapshot: () => LOCAL } }, remote: { session: { list: async () => HOST_STALE } } });
  apply(ctx);
  const outcome = await globalThis.__kitaReconnectOnVisible.runCheck(true);
  assert.equal(outcome.status, "stale");
  assert.equal(reloads, 1, "one reload");
  const guard = JSON.parse(storage.get("kita-reconnect-on-visible.reloadGuard"));
  assert.deepEqual(guard.signature, "b");
  assert.equal(await globalThis.__kitaReconnectOnVisible.runCheck(true), null, "throttled by CHECK_GAP_MS");
  assert.equal(reloads, 1, "still one reload");
  for (const dispose of ctx.disposers) dispose();
});

await test("apply: draft keeps the page and shows the banner instead", async () => {
  storage.clear();
  reloads = 0;
  composerField = { value: "mid-sentence" };
  composerCard = { querySelector: () => composerField };
  const { apply } = await loadBundle();
  const ctx = mockCtx({ sessions: { list: { getSnapshot: () => LOCAL } }, remote: { session: { list: async () => HOST_STALE } } });
  apply(ctx);
  const outcome = await globalThis.__kitaReconnectOnVisible.runCheck(true);
  assert.equal(outcome.status, "stale");
  assert.equal(reloads, 0, "a draft must block the reload");
  const banner = ELEMENTS.find((el) => el.id === "kita-reconnect-on-visible-banner");
  assert.ok(banner !== undefined, "banner must be offered");
  assert.match(banner.children[0].textContent, /1 条会话未同步/);
  banner.children[1].click();
  assert.equal(reloads, 1, "the banner button reloads on demand");
  composerCard = null;
  for (const dispose of ctx.disposers) dispose();
});

await test("apply: storage switch off blocks automatic reload", async () => {
  storage.clear();
  reloads = 0;
  storage.set("kita-reconnect-on-visible.autoReload", "off");
  composerCard = null;
  const { apply } = await loadBundle();
  const ctx = mockCtx({ sessions: { list: { getSnapshot: () => LOCAL } }, remote: { session: { list: async () => HOST_STALE } } });
  apply(ctx);
  await globalThis.__kitaReconnectOnVisible.runCheck(true);
  assert.equal(reloads, 0);
  storage.delete("kita-reconnect-on-visible.autoReload");
  for (const dispose of ctx.disposers) dispose();
});

await test("apply: a clean list never reloads or banners", async () => {
  storage.clear();
  reloads = 0;
  const { apply } = await loadBundle();
  const ctx = mockCtx({ sessions: { list: { getSnapshot: () => LOCAL } }, remote: { session: { list: async () => HOST_CLEAN } } });
  apply(ctx);
  const outcome = await globalThis.__kitaReconnectOnVisible.runCheck(true);
  assert.equal(outcome.status, "clean");
  assert.equal(reloads, 0);
  assert.equal(ELEMENTS.some((el) => el.id === "kita-reconnect-on-visible-banner"), false);
  for (const dispose of ctx.disposers) dispose();
});

await test("apply: pending list phase is never compared", async () => {
  storage.clear();
  reloads = 0;
  const { apply } = await loadBundle();
  const ctx = mockCtx({ sessions: { list: { getSnapshot: () => ({ phase: "pending", byId: {} }) } }, remote: { session: { list: async () => HOST_STALE } } });
  apply(ctx);
  const outcome = await globalThis.__kitaReconnectOnVisible.runCheck(true);
  assert.equal(outcome.status, "not-ready");
  assert.equal(reloads, 0);
  for (const dispose of ctx.disposers) dispose();
});

await test("apply: missing services and failed list calls are silent no-ops", async () => {
  storage.clear();
  reloads = 0;
  const cases = [
    mockCtx({ sessions: undefined, remote: undefined }),
    mockCtx({ sessions: { list: { getSnapshot: () => LOCAL } }, remote: undefined }),
    mockCtx({ sessions: { list: { getSnapshot: () => LOCAL } }, remote: { session: { list: async () => ({ ok: false, error: { code: "x" } }) } } }),
    mockCtx({ sessions: { list: { getSnapshot: () => LOCAL } }, remote: { session: { list: async () => { throw new Error("network"); } } } }),
  ];
  for (const ctx of cases) {
    const { apply } = await loadBundle();
    apply(ctx);
    const outcome = await globalThis.__kitaReconnectOnVisible.runCheck(true);
    assert.ok(outcome === null || outcome.status === "unavailable" || outcome.status === "list-failed", "unexpected " + JSON.stringify(outcome));
    assert.equal(reloads, 0);
    for (const dispose of ctx.disposers) dispose();
  }
});

await test("apply: reconnect banner click still works", async () => {
  disconnectedButton = makeElement("button");
  const { apply } = await loadBundle();
  const ctx = mockCtx({ sessions: undefined, remote: undefined });
  apply(ctx);
  assert.equal(disconnectedButton.clicks, 1, "mount-time safety net clicks the reconnect button");
  doc.listeners.visibilitychange();
  assert.equal(disconnectedButton.clicks, 1, "debounced within CLICK_GAP_MS");
  disconnectedButton = null;
  for (const dispose of ctx.disposers) dispose();
});

console.log("passed:", passed.length);
for (const name of passed) console.log("  ok  " + name);
if (process.exitCode === 1) console.log("FAILURES PRESENT");
else console.log("all green");
