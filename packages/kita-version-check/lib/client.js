/**
 * kita-version-check - client half.
 *
 * Two seats share one store:
 *   sidebar.footer.action  the version entry beside Settings (narrow = icon rail)
 *   shell.overlay          the detail panel: running version, registry channels,
 *                          the update verdict, and a manual refresh
 *
 * The host half owns every fact: the running version is resolved from the
 * process itself (never from this page), and the registry answer is cached so
 * opening the panel costs at most one request per refresh interval.
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

		// ---- Package-owned stylesheet (idempotent, framework-cleanup convention) ----
		const CSS = [
			".kitaVersionBtn{display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;",
			"width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;",
			"border:none;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);",
			"font-family:inherit;font-size:14px;cursor:pointer;overflow:hidden;flex:none;",
			"transition:background-color .16s ease,color .16s ease}",
			".kitaVersionBtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".kitaVersionBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".kitaVersionBtn_rail{width:36px;height:36px;margin:0;padding:0;border-radius:50%;justify-content:center;gap:0}",
			".kitaVersionBtn_update{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-brand-primary))}",
			".kitaVersionIcon{position:relative;display:inline-flex;flex:none}",
			".kitaVersionDot{position:absolute;top:-2px;right:-3px;width:7px;height:7px;border-radius:50%;",
			"background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-brand-primary));",
			"box-shadow:0 0 0 2px var(--dsw-alias-bg-base)}",
			".kitaVersionLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".kitaVersionOverlay{position:fixed;inset:0;z-index:60;pointer-events:auto;box-sizing:border-box;",
			"display:flex;align-items:center;justify-content:center;padding:24px;animation:kitaVersionLayerIn .16s ease-out}",
			".kitaVersionMask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);",
			"backdrop-filter:var(--dsw-mask-blur);-webkit-backdrop-filter:var(--dsw-mask-blur)}",
			".kitaVersionCard{position:relative;z-index:1;box-sizing:border-box;width:400px;max-width:100%;",
			"max-height:calc(100vh - 48px);overflow:auto;padding:16px 16px 12px;",
			"background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));",
			"border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;",
			"box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);",
			"font-family:inherit;font-size:13px;line-height:19px;",
			"animation:kitaVersionCardIn .2s cubic-bezier(.16,1,.3,1)}",
			"@keyframes kitaVersionLayerIn{from{opacity:0}to{opacity:1}}",
			"@keyframes kitaVersionCardIn{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}",
			"@media (prefers-reduced-motion:reduce){.kitaVersionOverlay,.kitaVersionCard{animation:none}}",
			".kitaVersionHead{display:flex;align-items:center;gap:8px;margin-bottom:12px}",
			".kitaVersionTitle{font-size:14px;font-weight:500;line-height:20px;flex:1;min-width:0}",
			".kitaVersionCurrent{display:flex;align-items:baseline;flex-wrap:wrap;gap:8px;margin-bottom:8px}",
			".kitaVersionCurrentValue{font-size:20px;font-weight:500;line-height:26px;letter-spacing:.2px}",
			".kitaVersionMeta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}",
			".kitaVersionVerdict{margin:8px 0 12px;padding:8px 10px;border-radius:8px;",
			"background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);",
			"font-size:12px;line-height:18px;word-break:break-word}",
			".kitaVersionVerdict_new{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-brand-primary)) 14%,transparent);",
			"color:var(--dsw-alias-label-primary)}",
			".kitaVersionVerdict_bad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);",
			"color:var(--dsw-alias-state-error-primary)}",
			".kitaVersionTable{display:flex;flex-direction:column;gap:2px;margin-bottom:10px}",
			".kitaVersionRow{display:grid;grid-template-columns:56px 1fr auto auto;align-items:center;gap:8px;",
			"padding:5px 8px;border-radius:7px;font-size:12px;line-height:18px}",
			".kitaVersionRow:nth-child(odd){background:var(--dsw-alias-interactive-bg-hover)}",
			".kitaVersionTag{color:var(--dsw-alias-label-secondary);font-family:inherit}",
			".kitaVersionVer{font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".kitaVersionWhen{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;white-space:nowrap}",
			".kitaVersionPill{padding:0 6px;border-radius:5px;font-size:11px;line-height:17px;white-space:nowrap;",
			"border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary)}",
			".kitaVersionPill_newer{border-color:transparent;background:var(--dsw-alias-state-warning-primary,var(--dsw-alias-brand-primary));color:#fff}",
			".kitaVersionPill_equal{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}",
			".kitaVersionSection{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;margin:0 0 4px 8px}",
			".kitaVersionRecent{display:flex;flex-direction:column;gap:1px;margin-bottom:10px}",
			".kitaVersionRecentRow{display:grid;grid-template-columns:1fr auto;gap:8px;padding:2px 8px;",
			"font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}",
			".kitaVersionFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}",
			".kitaVersionHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;flex:1;min-width:0}",
			".kitaVersionActions{display:flex;gap:8px;flex:none}",
			".kitaVersionAction{height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;",
			"border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);",
			"transition:background-color .16s ease,filter .16s ease,transform .1s ease}",
			".kitaVersionAction:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".kitaVersionAction:active{transform:scale(.98)}",
			".kitaVersionAction:disabled{opacity:.55;cursor:default}",
			".kitaVersionAction:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".kitaVersionAction_primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}",
			".kitaVersionAction_primary:hover{filter:brightness(1.08);background:var(--dsw-alias-brand-primary)}"
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

		/** One store per plugin activation, handed to both seats through inject. */
		function createStore() {
			let state = { open: false, loading: false, payload: null, error: null };
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
				/** Warm the answer so the sidebar entry can show a version at once. */
				prime() {
					if (state.payload === null && !state.loading) void load(false);
				},
				open() {
					set({ open: true });
					if (state.payload === null && !state.loading) void load(false);
				},
				close() {
					set({ open: false });
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
				// The host already ordered them by channel config; pick the highest
				// version among equals by comparing date as a stable tiebreaker.
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

		/** Up-arrow glyph: "a release exists above this one". */
		function VersionGlyph({ size, badge }) {
			return react.createElement("span", { className: "kitaVersionIcon" },
				react.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
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
				),
				badge ? react.createElement("span", { className: "kitaVersionDot", "aria-hidden": "true" }) : null
			);
		}

		/** Sidebar-foot entry: the only always-visible surface of this plugin. */
		function FooterButton({ wide, versionCheck }) {
			const [snapshot, setSnapshot] = react.useState(versionCheck.get());
			react.useEffect(() => versionCheck.subscribe(() => setSnapshot(versionCheck.get())), [versionCheck]);
			const payload = snapshot.payload;
			const current = payload !== null && payload.current ? payload.current : null;
			const pending = pendingUpdate(payload);
			const hasUpdate = pending !== null;
			const version = current !== null && typeof current.version === "string" && current.version !== "" ? current.version : "";
			let text = "检查版本";
			if (version !== "") text = "v" + version;
			if (hasUpdate) text = "v" + version + " · 有新版";
			if (snapshot.loading && payload === null) text = "检查版本…";
			let tooltip = "DSH 版本与更新";
			if (version !== "") tooltip = "当前 DSH 版本 " + version;
			if (hasUpdate) tooltip = tooltip + "，上游有新版本 " + String(pending.version) + "（点击查看）";
			return react.createElement("button", {
				type: "button",
				className: "kitaVersionBtn" + (wide ? "" : " kitaVersionBtn_rail") + (hasUpdate ? " kitaVersionBtn_update" : ""),
				title: tooltip,
				"aria-label": tooltip,
				onClick: () => versionCheck.open()
			}, [
				react.createElement(VersionGlyph, { key: "icon", size: wide ? 16 : 18, badge: hasUpdate }),
				wide ? react.createElement("span", { key: "label", className: "kitaVersionLabel" }, text) : null
			]);
		}

		/** Frame-wide surface: the version / update panel. */
		function VersionOverlay({ versionCheck }) {
			const [snapshot, setSnapshot] = react.useState(versionCheck.get());
			react.useEffect(() => versionCheck.subscribe(() => setSnapshot(versionCheck.get())), [versionCheck]);
			const open = snapshot.open === true;

			react.useEffect(() => {
				if (!open) return undefined;
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					versionCheck.close();
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [open, versionCheck]);

			if (!open) return null;

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
				for (const entry of payload.recent.slice(0, 5)) {
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
			hintParts.push("升级走演练 + replay-patches，勿在运行中 pnpm install");

			return react.createElement("div", { className: "kitaVersionOverlay" }, [
				react.createElement("div", {
					key: "mask",
					className: "kitaVersionMask",
					"aria-hidden": "true",
					onClick: () => versionCheck.close()
				}),
				react.createElement("div", {
					key: "card",
					className: "kitaVersionCard",
					role: "dialog",
					"aria-modal": "true",
					"aria-label": "DSH 版本与更新"
				}, [
					react.createElement("div", { className: "kitaVersionHead", key: "head" }, [
						react.createElement(VersionGlyph, { key: "glyph", size: 16, badge: hasUpdate }),
						react.createElement("div", { className: "kitaVersionTitle", key: "title" }, "DSH 版本与更新")
					]),
					react.createElement("div", { className: "kitaVersionCurrent", key: "current" }, [
						react.createElement("span", { className: "kitaVersionCurrentValue", key: "value" }, "v" + version),
						env !== "" ? react.createElement("span", { className: "kitaVersionMeta", key: "env" }, "env " + env) : null,
						current !== null && current.resolved !== true
							? react.createElement("span", { className: "kitaVersionMeta", key: "unresolved" }, "未能定位运行版本")
							: null
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
					react.createElement("div", { className: "kitaVersionFoot", key: "foot" }, [
						react.createElement("div", { className: "kitaVersionHint", key: "hint" }, hintParts.join(" · ")),
						react.createElement("div", { className: "kitaVersionActions", key: "actions" }, [
							react.createElement("button", {
								key: "refresh",
								type: "button",
								className: "kitaVersionAction kitaVersionAction_primary",
								disabled: snapshot.loading === true,
								onClick: () => versionCheck.refresh()
							}, snapshot.loading === true ? "检查中…" : "重新检查"),
							react.createElement("button", {
								key: "close",
								type: "button",
								className: "kitaVersionAction",
								onClick: () => versionCheck.close()
							}, "关闭")
						])
					])
				])
			]);
		}

		const inject = ["slots"];

		function apply(ctx) {
			const versionCheck = createStore();
			ctx.effect(() => () => versionCheck.dispose(), "kita-version-check: store");
			versionCheck.prime();
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "kita-version-check",
				order: 15,
				label: "版本更新",
				inject: () => ({ versionCheck })
			}, FooterButton));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "kita-version-check.overlay",
				order: 91,
				inject: () => ({ versionCheck })
			}, VersionOverlay));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
