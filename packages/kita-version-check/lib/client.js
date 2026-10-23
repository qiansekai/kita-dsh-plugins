/**
 * kita-version-check - client half.
 *
 * Two seats, one store, and NO sidebar-foot button: the footer row already
 * belongs to one full-width action (the restart entry), so a second occupant
 * there pushes it out of the 256px column. The entry therefore lives among the
 * global panel icons (sidebar.panellist) and opens a main panel, which is the
 * additive seat the sidebar reserves for exactly this kind of page.
 *
 *   sidebar.panellist  the icon entry beside Plugins / Schedules
 *   main               the version page itself, dispatched by the same id
 *
 * The host half owns every fact: the running version comes from the process,
 * and the registry answer is cached so opening the page costs at most one
 * request per refresh interval.
 *
 * This file is a client module-system CJS bundle: it must stay in the
 * "window.__ModuleLoader__.load({ id, factory })" form, with "require" as the
 * only module boundary (the "react" static table name is provided by the
 * framework boot graph).
 */
window.__ModuleLoader__.load({
	id: "kita-version-check",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		/** Panel id: the sidebar entry id and the main panel key are the same. */
		const PANEL_ID = "kita-version-check";

		// ---- Package-owned stylesheet (idempotent, framework-cleanup convention) ----
		// Opaque only: a translucent surface over live content is what makes text
		// unreadable. Every token below is from the documented theme directory.
		const CSS = [
			".kitaVersionPanel{box-sizing:border-box;width:100%;max-width:680px;margin:0 auto;",
			"padding:28px 24px 32px;color:var(--dsw-alias-label-primary);",
			"font-family:inherit;font-size:13px;line-height:19px}",
			".kitaVersionPanelHead{display:flex;align-items:center;gap:12px;margin-bottom:16px}",
			".kitaVersionPanelTitle{flex:1;min-width:0;font-size:16px;font-weight:500;line-height:24px}",
			".kitaVersionCurrent{display:flex;align-items:baseline;flex-wrap:wrap;gap:10px;margin-bottom:10px}",
			".kitaVersionCurrentValue{font-size:24px;font-weight:500;line-height:30px;letter-spacing:.2px}",
			".kitaVersionMeta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}",
			".kitaVersionVerdict{margin:0 0 16px;padding:10px 12px;border-radius:8px;",
			"border-left:3px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);",
			"color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px;word-break:break-word}",
			".kitaVersionVerdict_new{border-left-color:var(--dsw-alias-state-warn-primary)}",
			".kitaVersionVerdict_bad{border-left-color:var(--dsw-alias-state-error-primary)}",
			".kitaVersionTable{display:flex;flex-direction:column;gap:2px;margin-bottom:18px}",
			".kitaVersionRow{display:grid;grid-template-columns:70px 1fr auto auto;align-items:center;gap:10px;",
			"padding:7px 10px;border-radius:7px;font-size:12px;line-height:18px}",
			".kitaVersionRow:nth-child(odd){background:var(--dsw-alias-bg-layer-2)}",
			".kitaVersionTag{color:var(--dsw-alias-label-secondary);font-family:inherit}",
			".kitaVersionVer{font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".kitaVersionWhen{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}",
			".kitaVersionPill{padding:0 6px;border-radius:5px;font-size:11px;line-height:17px;white-space:nowrap;",
			"border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}",
			".kitaVersionPill_newer{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary);font-weight:500}",
			".kitaVersionPill_equal{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}",
			".kitaVersionSection{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;margin:0 0 6px 10px}",
			".kitaVersionRecent{display:flex;flex-direction:column;gap:1px;margin-bottom:16px}",
			".kitaVersionRecentRow{display:grid;grid-template-columns:1fr auto;gap:10px;padding:3px 10px;",
			"font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
			".kitaVersionHint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:17px;margin-top:2px}",
			".kitaVersionActions{display:flex;gap:8px;flex:none}",
			".kitaVersionAction{height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;",
			"border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);",
			"transition:background-color .16s ease,filter .16s ease,transform .1s ease}",
			".kitaVersionAction:hover{background:var(--dsw-alias-bg-layer-2)}",
			".kitaVersionAction:active{transform:scale(.98)}",
			".kitaVersionAction:disabled{opacity:.6;cursor:default}",
			".kitaVersionAction:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".kitaVersionAction_primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:500}",
			".kitaVersionAction_primary:hover{filter:brightness(1.08);background:var(--dsw-alias-brand-primary)}",
			".kitaVersionIcon{position:relative;display:inline-flex;align-items:center;justify-content:center;flex:none}",
			".kitaVersionDot{position:absolute;top:-1px;right:-1px;width:7px;height:7px;border-radius:50%;",
			"background:var(--dsw-alias-state-warn-primary);box-shadow:0 0 0 2px var(--dsw-specific-sidebar-fill)}"
		].join("");
		const tagId = "kita-version-check/version.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "kita-version-check";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** Read the host snapshot; "force" asks it to hit the registry again. */
		async function requestState(force) {
			const response = await fetch(force ? "/kita-version-check/refresh" : "/kita-version-check/state", {
				method: force ? "POST" : "GET",
				headers: { accept: "application/json" },
				cache: "no-store",
				credentials: "same-origin"
			});
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			const payload = await response.json();
			if (payload === null || typeof payload !== "object" || payload.ok !== true) {
				throw new Error("响应格式无效");
			}
			return payload;
		}

		/** One store per plugin activation, shared by the icon and the panel. */
		function createStore() {
			let state = { loading: false, payload: null, error: null };
			const listeners = new Set();
			const emit = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (error) {
						if (typeof console !== "undefined") console.error("[kita-version-check] listener failed", error);
					}
				}
			};
			const set = (patch) => {
				state = Object.assign({}, state, patch);
				emit();
			};
			const load = async (force) => {
				if (state.loading) return;
				set({ loading: true, error: null });
				try {
					const payload = await requestState(force);
					set({ payload, loading: false, error: null });
				} catch (error) {
					set({ loading: false, error: String(error && error.message ? error.message : error) });
				}
			};
			return {
				get: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				/** Warm the answer so the icon can carry an update badge at once. */
				prime() {
					if (state.payload === null && !state.loading) void load(false);
				},
				refresh() {
					void load(true);
				},
				dispose() {
					listeners.clear();
				}
			};
		}

		function formatWhen(value) {
			if (typeof value !== "string" || value === "") return "";
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return "";
			const pad = (input) => (input < 10 ? "0" + String(input) : String(input));
			return String(date.getFullYear()) + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate())
				+ " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		function formatClock(value) {
			if (typeof value !== "number" || value <= 0) return "";
			const date = new Date(value);
			if (Number.isNaN(date.getTime())) return "";
			const pad = (input) => (input < 10 ? "0" + String(input) : String(input));
			return pad(date.getHours()) + ":" + pad(date.getMinutes());
		}

		/** Newest channel that is actually newer than the running version. */
		function pendingUpdate(payload) {
			if (payload === null) return null;
			const newer = (payload.channels || []).filter((channel) => channel.relation === "newer");
			if (newer.length === 0) return null;
			let best = newer[0];
			for (const channel of newer.slice(1)) {
				if (String(channel.version) > String(best.version)) best = channel;
			}
			return best;
		}

		function pillClass(relation) {
			if (relation === "newer") return "kitaVersionPill kitaVersionPill_newer";
			if (relation === "equal") return "kitaVersionPill kitaVersionPill_equal";
			return "kitaVersionPill";
		}

		function pillText(relation) {
			if (relation === "newer") return "有新版";
			if (relation === "equal") return "当前";
			if (relation === "older") return "更新";
			return "未知";
		}

		function useSnapshot(versionCheck) {
			const [snapshot, setSnapshot] = react.useState(versionCheck.get());
			react.useEffect(() => versionCheck.subscribe(() => setSnapshot(versionCheck.get())), [versionCheck]);
			return snapshot;
		}

		/** Up-arrow glyph: "a release exists above this one". */
		function VersionGlyph({ size }) {
			return react.createElement("svg", {
				width: size,
				height: size,
				viewBox: "0 0 16 16",
				"aria-hidden": "true",
				focusable: "false"
			},
				react.createElement("path", {
					d: "M8 12.2V4.2",
					fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round"
				}),
				react.createElement("path", {
					d: "M4.3 7.5L8 3.8l3.7 3.7",
					fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round"
				}),
				react.createElement("path", {
					d: "M3 13.4h10",
					fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round"
				})
			);
		}

		/** Sidebar entry: an icon only, plus a dot when a release is waiting. */
		function VersionIcon({ size, active, versionCheck }) {
			const snapshot = useSnapshot(versionCheck);
			const pending = pendingUpdate(snapshot.payload);
			const edge = typeof size === "number" && size > 0 ? size : 18;
			return react.createElement("span", { className: "kitaVersionIcon", "aria-hidden": "true" },
				react.createElement(VersionGlyph, { size: edge }),
				pending !== null ? react.createElement("span", { className: "kitaVersionDot" }) : null
			);
		}

		/** The version page rendered in the main column. */
		function VersionPanel({ versionCheck }) {
			const snapshot = useSnapshot(versionCheck);
			react.useEffect(() => versionCheck.prime(), [versionCheck]);
			const payload = snapshot.payload;
			const current = payload !== null && payload.current ? payload.current : null;
			const pending = pendingUpdate(payload);
			const hasUpdate = pending !== null;
			const version = current !== null && typeof current.version === "string" && current.version !== "" ? current.version : "未知";
			const env = current !== null && typeof current.env === "string" ? current.env : "";
			const checkedAt = payload !== null ? formatClock(payload.checkedAt) : "";
			const interval = payload !== null && typeof payload.refreshIntervalMinutes === "number" ? payload.refreshIntervalMinutes : 0;

			let verdictText = "尚未检查";
			let verdictClass = "kitaVersionVerdict";
			if (snapshot.loading && payload === null) {
				verdictText = "正在检查上游版本…";
			} else if (payload === null) {
				verdictText = "无法检查版本：" + String(snapshot.error === null ? "未知错误" : snapshot.error);
				verdictClass = "kitaVersionVerdict kitaVersionVerdict_bad";
			} else if (hasUpdate) {
				verdictText = "上游有新版本：" + String(pending.tag) + " " + String(pending.version)
					+ (String(pending.publishedAt) !== "" ? " · " + formatWhen(String(pending.publishedAt)) : "");
				verdictClass = "kitaVersionVerdict kitaVersionVerdict_new";
			} else if (payload.channels && payload.channels.length > 0) {
				const latest = payload.channels[0];
				verdictText = "已是最新（" + String(latest.tag) + " " + String(latest.version) + "）";
			} else {
				verdictText = "上游没有任何通道版本可比对";
			}

			const rows = [];
			if (payload !== null && Array.isArray(payload.channels)) {
				for (const channel of payload.channels) {
					rows.push(react.createElement("div", { className: "kitaVersionRow", key: "ch:" + String(channel.tag) },
						react.createElement("span", { className: "kitaVersionTag" }, String(channel.tag)),
						react.createElement("span", { className: "kitaVersionVer" }, String(channel.version)),
						react.createElement("span", { className: "kitaVersionWhen" }, formatWhen(String(channel.publishedAt ?? ""))),
						react.createElement("span", { className: pillClass(channel.relation) }, pillText(channel.relation))
					));
				}
			}

			const recentRows = [];
			if (payload !== null && Array.isArray(payload.recent)) {
				for (const entry of payload.recent.slice(0, 6)) {
					recentRows.push(react.createElement("div", { className: "kitaVersionRecentRow", key: "rc:" + String(entry.version) },
						react.createElement("span", null, String(entry.version)),
						react.createElement("span", null, formatWhen(String(entry.publishedAt ?? "")))
					));
				}
			}

			const errorRow = snapshot.error !== null && payload !== null
				? react.createElement("div", { className: "kitaVersionVerdict kitaVersionVerdict_bad" }, "刷新失败：" + String(snapshot.error))
				: null;

			const hintParts = [];
			if (checkedAt !== "") hintParts.push("上次检查 " + checkedAt);
			if (interval > 0) hintParts.push(String(interval) + " 分钟缓存");
			if (current !== null && current.resolved !== true) hintParts.push("未能定位运行版本");
			hintParts.push("升级走演练 + replay-patches，勿在运行中 pnpm install");

			return react.createElement("div", { className: "kitaVersionPanel" }, [
				react.createElement("div", { className: "kitaVersionPanelHead", key: "head" }, [
					react.createElement("div", { className: "kitaVersionPanelTitle", key: "title" }, "DSH 版本与更新"),
					react.createElement("div", { className: "kitaVersionActions", key: "actions" },
						react.createElement("button", {
							type: "button",
							className: "kitaVersionAction kitaVersionAction_primary",
							disabled: snapshot.loading === true,
							onClick: () => versionCheck.refresh()
						}, snapshot.loading === true ? "检查中…" : "重新检查")
					)
				]),
				react.createElement("div", { className: "kitaVersionCurrent", key: "current" }, [
					react.createElement("span", { className: "kitaVersionCurrentValue", key: "value" }, "v" + version),
					env !== "" ? react.createElement("span", { className: "kitaVersionMeta", key: "env" }, "env " + env) : null,
					payload !== null && payload.via ? react.createElement("span", { className: "kitaVersionMeta", key: "via" }, String(payload.via)) : null
				]),
				react.createElement("div", { className: verdictClass, key: "verdict" }, verdictText),
				rows.length > 0 ? react.createElement("div", { className: "kitaVersionTable", key: "table" }, rows) : null,
				errorRow,
				recentRows.length > 0
					? react.createElement("div", { key: "recent" }, [
						react.createElement("div", { className: "kitaVersionSection", key: "label" }, "最近发布"),
						react.createElement("div", { className: "kitaVersionRecent", key: "list" }, recentRows)
					])
					: null,
				react.createElement("div", { className: "kitaVersionHint", key: "hint" }, hintParts.join(" · "))
			]);
		}

		const inject = ["slots"];

		function apply(ctx) {
			const versionCheck = createStore();
			ctx.effect(() => () => versionCheck.dispose(), "kita-version-check: store");
			versionCheck.prime();
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				inject: () => ({ versionCheck })
			}, VersionPanel));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				label: "版本更新",
				inject: () => ({ versionCheck })
			}, VersionIcon));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
