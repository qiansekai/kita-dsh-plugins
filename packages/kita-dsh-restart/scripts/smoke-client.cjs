/**
 * Regression smoke test for the kita-dsh-restart client half.
 *
 * The client half is a hand-written CJS bundle with no build step and no type
 * checking, so a wrong selector or a stale CSS fragment fails *silently* in the
 * browser. This script closes that hole offline: it runs the real bundle factory
 * against real React, captures the stylesheet the bundle injects, and
 * server-renders the sidebar button plus the shell.overlay seat for every phase.
 *
 * usage: node smoke-client.cjs <client.js> <web-profile-dir>
 *
 * <web-profile-dir> is the dsh web profile (the directory holding node_modules
 * with react and react-dom); both are arguments because the machine-specific
 * path must not live in the script.
 */
const path = require("path");

const clientPath = process.argv[2];
const webDir = process.argv[3];
if (!clientPath || !webDir) {
	console.error("usage: node smoke-client.cjs <client.js> <web-profile-dir>");
	process.exit(2);
}

let captured = null;
const injectedStyles = [];
global.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
// Minimal document stub: the bundle injects its stylesheet at factory time, and
// capturing the joined text is the only way to assert the final CSS (the source
// holds it as an array of fragments).
global.document = {
	querySelector: () => null,
	createElement: () => ({ dataset: {}, textContent: "" }),
	head: { appendChild: (el) => { injectedStyles.push(el.textContent); } }
};
require(clientPath);
if (captured === null) {
	console.error("FAIL: bundle did not register with __ModuleLoader__");
	process.exit(1);
}
console.log("module id:", captured.id);

const React = require(path.join(webDir, "node_modules", "react"));
const ReactDOMServer = require(path.join(webDir, "node_modules", "react-dom", "server"));
const mod = captured.factory((name) => {
	if (name === "react") return React;
	throw new Error("unexpected require: " + name);
});

let failures = 0;
const css = injectedStyles.join("");
console.log("injected stylesheets:", injectedStyles.length, "css length:", css.length);
const cssChecks = [
	["centering layer is fixed+inset:0", /\.kitaRestartOverlay\{position:fixed;inset:0/.test(css)],
	["centering layer is a flex centering box", /\.kitaRestartOverlay\{[^}]*display:flex;align-items:center;justify-content:center/.test(css)],
	["card carries no anchor offset of its own", !css.includes("top:16px") && !css.includes("translateX(-50%)")],
	["mask uses the theme mask token", /\.kitaRestartMask\{[^}]*background:var\(--dsw-alias-bg-mask-1\)/.test(css)],
	["mask uses the theme blur token", /\.kitaRestartMask\{[^}]*backdrop-filter:var\(--dsw-mask-blur\)/.test(css)],
	["card entrance keyframes", css.includes("@keyframes kitaRestartCardIn")],
	["card exit keyframes", css.includes("@keyframes kitaRestartCardOut")],
	["layer exit keyframes", css.includes("@keyframes kitaRestartLayerOut")],
	["leaving modifier animates layer and card", /\.kitaRestartOverlay\.kitaRestartLeave\{animation:kitaRestartLayerOut/.test(css) && /\.kitaRestartOverlay\.kitaRestartLeave \.kitaRestartCard\{animation:kitaRestartCardOut/.test(css)],
	["button transitions", /\.kitaRestartBtn\{[^}]*transition:background-color/.test(css)],
	["action transitions", /\.kitaRestartAction\{[^}]*transition:background-color/.test(css)],
	["reduced-motion escape hatch", css.includes("prefers-reduced-motion")],
	["braces balanced", (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length]
];
console.log("\n--- injected CSS");
for (const [label, ok] of cssChecks) {
	if (!ok) failures += 1;
	console.log("   ", ok ? "ok  " : "FAIL", label);
}

const seats = {};
const ctx = {
	effect: () => () => {},
	slots: {
		inject: (name, cb) => { cb(); },
		register: (seat, component) => { seats[seat.name] = { seat, component }; return () => {}; }
	}
};
mod.apply(ctx);
console.log("seats:", Object.keys(seats).join(", "));

function makeStore(phase) {
	return {
		get: () => ({
			phase,
			bootIdBefore: "boot-1",
			startedAt: 0,
			elapsedSeconds: 7,
			error: "boom",
			mode: "task",
			taskName: "kita-dsh-restart",
			delaySeconds: 4
		}),
		subscribe: () => () => {},
		cancel() {},
		retry() {},
		reload() {},
		begin() {}
	};
}

const Overlay = seats["shell.overlay"].component;
const Button = seats["sidebar.footer.action"].component;
const check = (label, ok) => {
	if (!ok) failures += 1;
	console.log("   ", ok ? "ok  " : "FAIL", label);
};

for (const phase of ["confirm", "restarting", "failed", "idle"]) {
	const html = ReactDOMServer.renderToStaticMarkup(
		React.createElement(Overlay, { restart: makeStore(phase) })
	);
	console.log("\n--- phase=" + phase + " html len=" + html.length);
	if (phase === "idle") {
		check("renders nothing when idle", html === "");
		continue;
	}
	check("has centering layer", html.includes("kitaRestartOverlay"));
	check("has mask", html.includes("kitaRestartMask"));
	check("has card", html.includes("kitaRestartCard"));
	check("no leaving class while open", !html.includes("kitaRestartLeave"));
	check("mask is aria-hidden", /kitaRestartMask"[^>]*aria-hidden="true"/.test(html) || /aria-hidden="true"[^>]*kitaRestartMask/.test(html));
	const expectedRole = phase === "confirm" ? "dialog" : (phase === "restarting" ? "status" : "alert");
	check("role=" + expectedRole, html.includes('role="' + expectedRole + '"'));
	if (phase === "restarting") check("shows elapsed seconds", html.includes("已等待 7 秒"));
	if (phase === "failed") check("shows error text", html.includes("boom"));
	if (phase === "confirm") check("has confirm + cancel actions", html.includes("确认重启") && html.includes("取消"));
}

for (const wide of [true, false]) {
	const html = ReactDOMServer.renderToStaticMarkup(
		React.createElement(Button, { wide, restart: makeStore("idle") })
	);
	console.log("\n--- button wide=" + wide);
	check("has button class", html.includes("kitaRestartBtn"));
	check(wide ? "shows label" : "rail (icon-only)", wide ? html.includes("kitaRestartLabel") : !html.includes("kitaRestartLabel"));
	check(wide ? "no rail class" : "has rail class", wide ? !html.includes("kitaRestartBtn_rail") : html.includes("kitaRestartBtn_rail"));
}

console.log("\n" + (failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"));
process.exit(failures === 0 ? 0 : 1);
