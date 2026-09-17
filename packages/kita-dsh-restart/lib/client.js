/**
 * kita-dsh-restart client half - the sidebar-foot restart button and its
 * confirmation / progress surface.
 *
 * Two seats share one store:
 *   sidebar.footer.action  the button beside Settings (narrow = icon-only rail)
 *   shell.overlay          the confirmation and progress card, top-center
 *
 * Restart flow: click -> confirm card -> POST /kita-restart/run -> poll
 * /kita-restart/status until the reported `bootId` differs from the one that
 * answered the request. A different bootId means a NEW process is answering,
 * i.e. the restart completed; the page then reloads. During the restart the
 * fetches simply fail (connection refused) and are treated as "still down".
 * No launch token is involved: the browser-session cookie is signed with a
 * secret persisted in the home's credential store and stays valid across the
 * restart.
 *
 * This file is a client module-system CJS bundle: it must stay in the
 * `window.__ModuleLoader__.load({ id, factory })` form, with `require` as the
 * only module boundary (the `react` static table name is provided by the
 * framework boot graph).
 */
window.__ModuleLoader__.load({
	id: "kita-dsh-restart",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		// ---- Package-owned stylesheet (idempotent, framework-cleanup convention) ----
		const CSS = [
			".kitaRestartBtn{display:inline-flex;align-items:center;gap:8px;box-sizing:border-box;",
			"width:calc(100% + 4px);height:42px;margin:0 -2px;padding:0 10px 0 8px;",
			"border:none;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);",
			"font-family:inherit;font-size:14px;cursor:pointer;overflow:hidden;flex:none}",
			".kitaRestartBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".kitaRestartBtn:disabled{opacity:.55;cursor:default}",
			".kitaRestartBtn_rail{width:36px;height:36px;margin:0;padding:0;border-radius:50%;justify-content:center;gap:0}",
			".kitaRestartBtnIcon{display:inline-flex;flex:none}",
			".kitaRestartBtnSpin{animation:kitaRestartSpin 1s linear infinite;transform-origin:50% 50%}",
			"@keyframes kitaRestartSpin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}",
			".kitaRestartLabel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".kitaRestartCard{position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:60;pointer-events:auto;",
			"box-sizing:border-box;width:352px;max-width:calc(100vw - 32px);padding:14px 14px 12px;",
			"background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));",
			"border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;",
			"box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);",
			"font-family:inherit;font-size:13px;line-height:19px}",
			".kitaRestartCardTitle{font-size:14px;font-weight:500;line-height:20px;margin-bottom:6px}",
			".kitaRestartCardText{color:var(--dsw-alias-label-secondary)}",
			".kitaRestartCardMeta{color:var(--dsw-alias-label-tertiary);margin-top:6px;font-size:12px;line-height:18px}",
			".kitaRestartCardError{color:var(--dsw-alias-state-error-primary);margin-top:6px;font-size:12px;line-height:18px;word-break:break-word}",
			".kitaRestartCardRow{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}",
			".kitaRestartAction{height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13px;",
			"border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}",
			".kitaRestartAction:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".kitaRestartAction_primary{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff}",
			".kitaRestartAction_primary:hover{filter:brightness(1.08);background:var(--dsw-alias-state-error-primary)}"
		].join("");
		const tagId = "kita-dsh-restart/restart.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "kita-dsh-restart";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		const POLL_INTERVAL_MS = 1500;
		const WAIT_TIMEOUT_MS = 180000;
		const RELOAD_DELAY_MS = 900;

		/** Read the host restart status; throws while the process is down. */
		async function fetchStatus() {
			const response = await fetch("/kita-restart/status", {
				method: "GET",
				headers: { accept: "application/json" },
				cache: "no-store",
				credentials: "same-origin"
			});
			if (!response.ok) throw new Error("status HTTP " + String(response.status));
			return await response.json();
		}

		/**
		 * The shared restart state machine. One instance per plugin activation,
		 * handed to both slot components through their `inject` props.
		 */
		function createRestartStore() {
			let state = {
				phase: "idle",
				bootIdBefore: null,
				startedAt: 0,
				elapsedSeconds: 0,
				error: null,
				mode: "",
				taskName: "",
				delaySeconds: 4
			};
			const listeners = new Set();
			let timer = null;

			const emit = () => {
				for (const listener of [...listeners]) {
					try {
						listener();
					} catch (error) {
						if (typeof console !== "undefined") console.error("[kita-dsh-restart] listener failed", error);
					}
				}
			};
			const set = (patch) => {
				state = Object.assign({}, state, patch);
				emit();
			};
			const stopPolling = () => {
				if (timer !== null) {
					clearInterval(timer);
					timer = null;
				}
			};

			const isRestarting = () => state.phase === "restarting";

			/** One poll: a changed bootId proves a fresh process is serving. */
			const poll = async () => {
				if (!isRestarting()) {
					stopPolling();
					return;
				}
				const elapsed = Date.now() - state.startedAt;
				if (elapsed > WAIT_TIMEOUT_MS) {
					stopPolling();
					set({ phase: "failed", elapsedSeconds: Math.round(elapsed / 1000), error: "等待超时：3 分钟内没有等到新实例。请手动确认 dsh 是否已启动。" });
					return;
				}
				set({ elapsedSeconds: Math.round(elapsed / 1000) });
				try {
					const payload = await fetchStatus();
					if (payload !== null && typeof payload.bootId === "string" && payload.bootId !== state.bootIdBefore) {
						stopPolling();
						set({ phase: "ready", mode: payload.task && payload.task.name ? state.mode : state.mode });
						// The cookie is signed by a persisted secret, so a plain reload
						// lands authenticated on the new process.
						setTimeout(() => {
							try {
								window.location.reload();
							} catch (error) {
								if (typeof console !== "undefined") console.error("[kita-dsh-restart] reload failed", error);
							}
						}, RELOAD_DELAY_MS);
					}
				} catch (error) {
					// Connection refused while the process is down is the expected state.
				}
			};

			return {
				get: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				/** Open the confirmation card (button click). */
				open() {
					if (state.phase === "restarting") return;
					set({ phase: "confirm", error: null });
				},
				cancel() {
					stopPolling();
					set({ phase: "idle", error: null, elapsedSeconds: 0 });
				},
				/** Confirmed: ask the host to restart, then watch for the new bootId. */
				async begin(delaySeconds) {
					if (state.phase === "restarting") return;
					stopPolling();
					set({ phase: "restarting", startedAt: Date.now(), elapsedSeconds: 0, error: null, mode: "", bootIdBefore: null });
					let payload = null;
					try {
						const response = await fetch("/kita-restart/run", {
							method: "POST",
							headers: { "content-type": "application/json", accept: "application/json" },
							body: JSON.stringify({ delaySeconds }),
							credentials: "same-origin"
						});
						payload = await response.json().catch(() => null);
						if (!response.ok || payload === null || payload.ok !== true) {
							const detail = payload !== null && typeof payload.error === "string" ? payload.error : "HTTP " + String(response.status);
							set({ phase: "failed", error: detail });
							return;
						}
					} catch (error) {
						set({ phase: "failed", error: "请求失败：" + String(error && error.message ? error.message : error) });
						return;
					}
					set({
						bootIdBefore: payload.bootId,
						mode: typeof payload.mode === "string" ? payload.mode : "",
						taskName: typeof payload.taskName === "string" ? payload.taskName : "",
						delaySeconds: typeof payload.delaySeconds === "number" ? payload.delaySeconds : delaySeconds
					});
					timer = setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
					void poll();
				},
				retry() {
					stopPolling();
					set({ phase: "idle", error: null, elapsedSeconds: 0 });
				},
				reload() {
					try {
						window.location.reload();
					} catch (error) {
						if (typeof console !== "undefined") console.error("[kita-dsh-restart] reload failed", error);
					}
				},
				dispose() {
					stopPolling();
					listeners.clear();
				}
			};
		}

		/** Circular-arrow glyph drawn inline: no icon-package dependency to hold. */
		function RestartGlyph({ size, spinning }) {
			return react.createElement("span", { className: "kitaRestartBtnIcon" + (spinning ? " kitaRestartBtnSpin" : "") },
				react.createElement("svg", { width: size, height: size, viewBox: "0 0 16 16", "aria-hidden": "true", focusable: "false" },
					react.createElement("path", {
						d: "M13.2 8a5.2 5.2 0 1 1-1.6-3.76",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 1.5,
						strokeLinecap: "round"
					}),
					react.createElement("path", {
						d: "M13.4 1.7v3h-3",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: 1.5,
						strokeLinecap: "round",
						strokeLinejoin: "round"
					})
				)
			);
		}

		/** Sidebar-foot button: the whole entry point of this plugin. */
		function RestartButton({ wide, restart }) {
			const [snapshot, setSnapshot] = react.useState(restart.get());
			react.useEffect(() => restart.subscribe(() => setSnapshot(restart.get())), [restart]);
			const busy = snapshot.phase === "restarting";
			const tooltip = busy
				? "正在重启 DSH Web…"
				: "重启 DSH Web（重新加载 host 侧插件与配置）";
			return react.createElement("button", {
				type: "button",
				className: "kitaRestartBtn" + (wide ? "" : " kitaRestartBtn_rail"),
				title: tooltip,
				"aria-label": tooltip,
				disabled: busy,
				onClick: () => restart.open()
			}, [
				react.createElement(RestartGlyph, { key: "icon", size: wide ? 16 : 18, spinning: busy }),
				wide ? react.createElement("span", { key: "label", className: "kitaRestartLabel" }, busy ? "重启中…" : "重启 DSH") : null
			]);
		}

		/** Frame-wide surface: the confirmation and progress card. */
		function RestartOverlay({ restart }) {
			const [snapshot, setSnapshot] = react.useState(restart.get());
			react.useEffect(() => restart.subscribe(() => setSnapshot(restart.get())), [restart]);
			const phase = snapshot.phase;
			if (phase === "idle" || phase === "ready") return null;

			const rows = [];
			if (phase === "confirm") {
				rows.push(react.createElement("div", { className: "kitaRestartCardTitle", key: "t" }, "重启 DSH Web？"));
				rows.push(react.createElement("div", { className: "kitaRestartCardText", key: "b" },
					"将停止当前 dsh 进程并重新启动它，用于加载新的 host 侧插件或配置。",
					react.createElement("br"),
					"正在运行的会话活动会中断；页面在 20-40 秒后自动恢复。"
				));
				rows.push(react.createElement("div", { className: "kitaRestartCardRow", key: "r" }, [
					react.createElement("button", {
						key: "cancel",
						type: "button",
						className: "kitaRestartAction",
						onClick: () => restart.cancel()
					}, "取消"),
					react.createElement("button", {
						key: "go",
						type: "button",
						className: "kitaRestartAction kitaRestartAction_primary",
						onClick: () => { void restart.begin(4); }
					}, "确认重启")
				]));
				return react.createElement("div", { className: "kitaRestartCard", role: "dialog", "aria-label": "重启 DSH Web" }, rows);
			}

			if (phase === "restarting") {
				rows.push(react.createElement("div", { className: "kitaRestartCardTitle", key: "t" }, "正在重启 DSH Web…"));
				rows.push(react.createElement("div", { className: "kitaRestartCardText", key: "b" }, "进程正在退出并重新启动。页面恢复连接后会自动刷新。"));
				rows.push(react.createElement("div", { className: "kitaRestartCardMeta", key: "m" },
					"已等待 " + String(snapshot.elapsedSeconds) + " 秒" + (snapshot.mode ? " · 触发方式 " + snapshot.mode : "")
				));
				rows.push(react.createElement("div", { className: "kitaRestartCardRow", key: "r" },
					react.createElement("button", {
						type: "button",
						className: "kitaRestartAction",
						onClick: () => restart.cancel()
					}, "停止等待")
				));
				return react.createElement("div", { className: "kitaRestartCard", role: "status", "aria-live": "polite" }, rows);
			}

			rows.push(react.createElement("div", { className: "kitaRestartCardTitle", key: "t" }, "重启未能完成"));
			rows.push(react.createElement("div", { className: "kitaRestartCardError", key: "e" }, snapshot.error === null ? "未知错误" : snapshot.error));
			rows.push(react.createElement("div", { className: "kitaRestartCardRow", key: "r" }, [
				react.createElement("button", {
					key: "retry",
					type: "button",
					className: "kitaRestartAction",
					onClick: () => restart.retry()
				}, "返回"),
				react.createElement("button", {
					key: "reload",
					type: "button",
					className: "kitaRestartAction kitaRestartAction_primary",
					onClick: () => restart.reload()
				}, "重新加载页面")
			]));
			return react.createElement("div", { className: "kitaRestartCard", role: "alert" }, rows);
		}

		const inject = ["slots"];

		function apply(ctx) {
			const restart = createRestartStore();
			ctx.effect(() => () => restart.dispose(), "kita-dsh-restart: poll timer");
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
				name: "sidebar.footer.action",
				id: "kita-dsh-restart",
				order: 20,
				inject: () => ({ restart })
			}, RestartButton));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "kita-dsh-restart.overlay",
				order: 90,
				inject: () => ({ restart })
			}, RestartOverlay));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
