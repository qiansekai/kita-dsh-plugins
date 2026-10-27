/**
 * kita-dsh-shell-bridge client half — the poller that talks to the phone shell.
 *
 * It renders nothing. It sits in \`shell.overlay\` purely to be mounted once per
 * page, then polls the host's \`/kita-shell/state\` route and forwards working /
 * done transitions to \`window.DshShell.notifySessionState\` — the interface the
 * dsh-mobile-shell WebView injects.
 *
 * On a desktop browser \`window.DshShell\` does not exist; the poller then does
 * nothing at all, so this plugin is invisible outside the phone shell.
 *
 * This file is a client module-system CJS bundle: it must stay in the
 * \`window.__ModuleLoader__.load({ id, factory })\` form, with \`require\` as the
 * only module boundary (the \`react\` static table name is provided by the
 * framework boot graph).
 */
window.__ModuleLoader__.load({
	id: "kita-dsh-shell-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		/** Poll cadence: fast enough to feel live, cheap enough to ignore. */
		const POLL_MS = 4000;
		const STATE_ROUTE = "/kita-shell/state";

		/** The shell bridge is present only inside the dsh-mobile-shell WebView. */
		function shell() {
			const api = globalThis.DshShell;
			return api !== undefined && api !== null && typeof api.notifySessionState === "function" ? api : null;
		}

		/**
		 * Invisible poller. Keeps one Map of the last state it reported per
		 * session so a transition fires exactly once.
		 */
		function Bridge() {
			const reported = react.useRef(null);
			if (reported.current === null) reported.current = new Map();

			react.useEffect(() => {
				let stopped = false;
				const tick = () => {
					const api = shell();
					if (api === null) return;
					fetch(STATE_ROUTE, { credentials: "same-origin", cache: "no-store" })
						.then((response) => (response.ok ? response.json() : null))
						.then((payload) => {
							if (stopped || payload === null || !Array.isArray(payload.sessions)) return;
							for (const session of payload.sessions) {
								if (session === null || typeof session !== "object") continue;
								const sessionId = typeof session.sessionId === "string" ? session.sessionId : "";
								if (sessionId.length === 0) continue;
								const next = session.running === true ? "working" : "idle";
								const previous = reported.current.get(sessionId);
								reported.current.set(sessionId, next);
								if (previous === undefined || previous === next) continue;
								if (next === "working") {
									api.notifySessionState(JSON.stringify({
										sessionId,
										title: typeof session.title === "string" && session.title.length > 0 ? session.title : "DSH 会话",
										state: "working",
										detail: ""
									}));
								} else {
									api.notifySessionState(JSON.stringify({
										sessionId,
										title: typeof session.title === "string" && session.title.length > 0 ? session.title : "DSH 会话",
										state: "done",
										detail: ""
									}));
								}
							}
						})
						.catch(() => { /* route unreachable during a restart: ignore */ });
				};
				tick();
				const timer = setInterval(tick, POLL_MS);
				return () => {
					stopped = true;
					clearInterval(timer);
				};
			}, []);

			return null;
		}

		/**
		 * Dropzone bridge: harvest absolute paths from the local DSH Dropzone
		 * floating window (a native WinForms process on 127.0.0.1) and type
		 * them into the composer.
		 *
		 * A browser cannot read the path behind an OS drop, so a tiny native
		 * window owns the drop; this poller drains its queue. Insertion uses
		 * execCommand("insertText") on the Lexical contenteditable, so the
		 * composer sees a real text edit (its own input pipeline and undo
		 * stack stay coherent).
		 */
		/** Shipped native queue port; config.ini owns the same number (see README). */
		const DROPZONE_DEFAULT_PORT = 47615;
		/** Browser-side override for when config.ini was changed to another port. */
		const DROPZONE_PORT_KEY = "kita-shell-bridge.dropzonePort";
		const DROPZONE_POLL_MS = 900;
		/** Backoff once the native window is unreachable, so a stopped dropzone stops logging on every poll. */
		const DROPZONE_RETRY_MS = 15000;
		const DROPZONE_RETRY_MAX_MS = 60000;
		const DROPZONE_FAILURES_BEFORE_BACKOFF = 3;
		const DROPZONE_FAILURES_BEFORE_IDLE = 10;

		/**
		 * Resolve the native queue origin.
		 * @returns the loopback origin the dropzone window listens on.
		 */
		function dropzoneOrigin() {
			let port = DROPZONE_DEFAULT_PORT;
			try {
				const stored = Number(globalThis.localStorage?.getItem(DROPZONE_PORT_KEY));
				if (Number.isInteger(stored) && stored > 0 && stored < 65536) port = stored;
			} catch { /* storage unavailable */ }
			return "http://127.0.0.1:" + port;
		}

		/**
		 * The active composer's editable element, when one is mounted and writable.
		 * The empty hero also renders a composer input, but with
		 * contenteditable="false" until a workspace is picked.
		 */
		function composerEditor() {
			const card = document.querySelector("[data-composer-card]");
			if (card === null) return null;
			const editor = card.querySelector("[data-composer-input]");
			if (!(editor instanceof HTMLElement)) return null;
			if (editor.getAttribute("contenteditable") !== "true") return null;
			return editor;
		}

		/**
		 * Append paths at the end of the composer; returns whether the edit landed.
		 *
		 * Append-only by construction: no newline may appear in the payload.
		 * Lexical answers execCommand("insertText") with true for a string that
		 * contains a newline while changing nothing, which silently dropped the
		 * paths whenever a draft already had text. The DOM comparison below turns
		 * that silent no-op into a failure so the caller can put them back.
		 */
		function insertPaths(editor, paths) {
			const text = paths.join(" ");
			editor.focus();
			const selection = window.getSelection();
			if (selection !== null) {
				const range = document.createRange();
				range.selectNodeContents(editor);
				range.collapse(false);
				selection.removeAllRanges();
				selection.addRange(range);
			}
			const before = editor.textContent;
			const needsLeadingSpace = before.trim().length > 0 && !/\s$/.test(before);
			const body = (needsLeadingSpace ? " " : "") + text + " ";
			const applied = document.execCommand("insertText", false, body);
			return applied === true && editor.textContent !== before;
		}

		/** Put harvested paths back when no composer is mounted yet. */
		function returnPaths(paths) {
			for (const path of paths) {
				fetch(dropzoneOrigin() + "/add?path=" + encodeURIComponent(path), { cache: "no-store" }).catch(() => {});
			}
		}

		/**
		 * Invisible dropzone poller. One per mounted page; the native window's
		 * /take is destructive, so concurrent tabs cannot insert the same path.
		 */
				function DropzoneBridge() {
			react.useEffect(() => {
				let stopped = false;
				let failures = 0;
				let timer = null;
				/** Schedule the next poll; a stopped poller never re-arms. */
				const schedule = (delay) => {
					if (stopped) return;
					timer = setTimeout(run, delay);
				};
				const run = () => {
					if (stopped) return;
					if (document.visibilityState !== "visible") {
						schedule(DROPZONE_POLL_MS);
						return;
					}
					fetch(dropzoneOrigin() + "/take", { cache: "no-store" })
						.then((response) => {
							if (!response.ok) throw new Error("take " + response.status);
							failures = 0;
							return response.json();
						})
						.then((payload) => {
							if (stopped || payload === null || !Array.isArray(payload.paths) || payload.paths.length === 0) return;
							const paths = payload.paths.filter((path) => typeof path === "string" && path.length > 0);
							if (paths.length === 0) return;
							const editor = composerEditor();
							if (editor === null || !insertPaths(editor, paths)) returnPaths(paths);
						})
						.catch(() => {
							// The native window is not running: stay quiet and back off instead of polling hard.
							failures += 1;
						})
						.finally(() => {
							if (failures === 0) schedule(DROPZONE_POLL_MS);
							else if (failures >= DROPZONE_FAILURES_BEFORE_IDLE) schedule(DROPZONE_RETRY_MAX_MS);
							else if (failures >= DROPZONE_FAILURES_BEFORE_BACKOFF) schedule(DROPZONE_RETRY_MS);
							else schedule(DROPZONE_POLL_MS);
						});
				};
				/** Coming back to the tab resets the backoff so a restarted dropzone is picked up at once. */
				const wake = () => {
					if (document.visibilityState !== "visible") return;
					failures = 0;
					if (timer !== null) clearTimeout(timer);
					timer = null;
					run();
				};
				document.addEventListener("visibilitychange", wake);
				run();
				return () => {
					stopped = true;
					document.removeEventListener("visibilitychange", wake);
					if (timer !== null) clearTimeout(timer);
				};
			}, []);

			return null;
		}
		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "shell-bridge-poller",
				order: 900
			}, Bridge));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dropzone-bridge-poller",
				order: 901
			}, DropzoneBridge));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
