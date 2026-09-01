/**
 * kita-session-title-auto client half — the header title mark.
 *
 * Registers one additive entry in `conversation.session.header.actions`
 * (order -20, left of the static session context). It reads the host-published
 * `kitaTitleAuto` projection (see lib/index.js) and renders:
 *   ✨ provider-maintained title, with a pop-and-fade "已更新" flash whenever a
 *      new revision changes the title text;
 *   📌 user-pinned title (automatic regeneration paused).
 * The tooltip always carries the latest revision's clock (HH:MM:SS).
 *
 * This file is a client module-system CJS bundle: it must stay in the
 * `window.__ModuleLoader__.load({ id, factory })` form, with `require` as the
 * only module boundary (the `react` static table name is provided by the
 * framework boot graph).
 */
window.__ModuleLoader__.load({
	id: "kita-session-title-auto",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		// ---- Package-owned stylesheet (idempotent, framework-cleanup convention) ----
		const CSS = [
			".kitaTitleMark{display:inline-flex;align-items:center;gap:3px;",
			"min-height:28px;font-size:12px;line-height:18px;padding:3px 2px;",
			"color:var(--dsw-alias-label-tertiary);white-space:nowrap;cursor:help;",
			"transition:color .4s ease}",
			".kitaTitleMark:hover{color:var(--dsw-alias-label-secondary)}",
			".kitaTitleMark_flash{animation:kitaTitleMarkPop 4.2s ease forwards}",
			".kitaTitleMark_note{font-size:10px}",
			"@keyframes kitaTitleMarkPop{",
			"0%{opacity:0;transform:scale(.5)}",
			"10%{opacity:1;transform:scale(1.3)}",
			"22%{transform:scale(1)}",
			"80%{opacity:1}",
			"100%{opacity:.55;transform:scale(1)}",
			"}"
		].join("");
		const tagId = "kita-session-title-auto/title-mark.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "kita-session-title-auto";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		function pad2(value) {
			return (value < 10 ? "0" : "") + String(value);
		}

		/** Local HH:MM:SS clock for the tooltip. */
		function formatClock(ms) {
			const date = new Date(ms);
			return pad2(date.getHours()) + ":" + pad2(date.getMinutes()) + ":" + pad2(date.getSeconds());
		}

		/**
		 * Header mark for the current session. Slot standard props supply
		 * `sessionId` and `useProjection`; the host projection `kitaTitleAuto`
		 * carries { kind, title, updatedAt, seq } for the latest `session/title`
		 * event. The flash fires only when a provider revision actually changes
		 * the title text (a same-text re-render stays quiet), while the tooltip
		 * clock follows every real revision through `seq`.
		 */
		function TitleMark({ useProjection }) {
			const meta = useProjection("kitaTitleAuto");
			const [flash, setFlash] = react.useState(false);
			const previous = react.useRef({ seen: false, seq: -1, title: null });

			react.useEffect(() => {
				if (meta === undefined || meta === null || typeof meta.seq !== "number") return;
				const prev = previous.current;
				const currentTitle = typeof meta.title === "string" ? meta.title : null;
				const changedTitle = prev.seen && prev.title !== null && prev.title !== currentTitle;
				const newerRevision = prev.seen && meta.seq > prev.seq;
				previous.current = { seen: true, seq: meta.seq, title: currentTitle };
				if (changedTitle && newerRevision && meta.kind === "provider") setFlash(true);
			}, [meta]);

			if (meta === undefined || meta === null) return null;
			if (meta.kind !== "provider" && meta.kind !== "user") return null;

			const pinned = meta.kind === "user";
			const icon = pinned ? "\uD83D\uDCCC" : "\u2728";
			const label = pinned ? "标题已钉住，自动重拟暂停" : "标题由 AI 自动维护";
			const clock = typeof meta.updatedAt === "number" && meta.updatedAt > 0 ? formatClock(meta.updatedAt) : "";
			const tooltip = label + (clock.length > 0 ? " · 最近更新 " + clock : "");

			const children = [icon];
			if (flash) {
				children.push(react.createElement("span", { className: "kitaTitleMark_note", key: "note" }, "已更新"));
			}
			return react.createElement("span", {
				className: "kitaTitleMark" + (flash ? " kitaTitleMark_flash" : ""),
				title: tooltip,
				"aria-label": tooltip,
				role: "img",
				key: String(meta.seq),
				onAnimationEnd: flash ? () => setFlash(false) : undefined
			}, children);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "title-auto-mark",
				order: -20
			}, TitleMark));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
