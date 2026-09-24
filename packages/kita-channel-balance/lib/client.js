/**
 * kita-channel-balance client half — composer 工具行里的渠道余额胶囊 + 展开面板。
 *
 * 两个座位共享一个 store：
 *   conversation.input.left  composer 工具行（模型选择器同排）的余额胶囊
 *   shell.overlay            点开的明细面板（遮罩点击 / Esc 关闭，列出全部渠道）
 *
 * 数据只读：GET /kita-balance/state 取 host 聚合快照，面板里的「刷新」走
 * POST /kita-balance/refresh 强制重取。凭据、上游调用都在 host 半，
 * 这里拿到的永远只有金额、状态与更新时间。
 *
 * 本文件是客户端模块系统的 CJS bundle：必须保持
 * window.__ModuleLoader__.load({ id, factory }) 形式，require 是唯一的模块边界
 * （react 由框架启动图提供）。
 */
window.__ModuleLoader__.load({
	id: "kita-channel-balance",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		// ---- Package-owned stylesheet (idempotent, framework-cleanup convention) ----
		const CSS = [
			".kitaBalanceChip{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:190px;",
			"box-sizing:border-box;padding:0 9px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;",
			"background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;",
			"line-height:16px;cursor:pointer;white-space:nowrap;overflow:hidden;transition:background-color .16s ease,color .16s ease}",
			".kitaBalanceChip:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".kitaBalanceChip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".kitaBalanceChip_warn{color:var(--dsw-alias-state-error-primary)}",
			".kitaBalanceChip_muted{color:var(--dsw-alias-label-tertiary)}",
			".kitaBalanceChipDot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none;opacity:.75}",
			".kitaBalanceChipValue{overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}",
			".kitaBalanceOverlay{position:fixed;inset:0;z-index:60;pointer-events:auto;box-sizing:border-box;",
			"display:flex;align-items:center;justify-content:center;padding:24px;animation:kitaBalanceLayerIn .16s ease-out}",
			".kitaBalanceMask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);",
			"backdrop-filter:var(--dsw-mask-blur);-webkit-backdrop-filter:var(--dsw-mask-blur)}",
			".kitaBalanceCard{position:relative;z-index:1;box-sizing:border-box;width:392px;max-width:100%;",
			"max-height:min(70vh,560px);display:flex;flex-direction:column;padding:14px 14px 12px;",
			"background:var(--dsw-specific-menu,var(--dsw-alias-bg-base));border:.5px solid var(--dsw-alias-border-l4);",
			"border-radius:12px;box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);",
			"font-family:inherit;font-size:13px;line-height:19px;animation:kitaBalanceCardIn .2s cubic-bezier(.16,1,.3,1)}",
			".kitaBalanceOverlay.kitaBalanceLeave{animation:kitaBalanceLayerOut .14s ease-in forwards}",
			".kitaBalanceOverlay.kitaBalanceLeave .kitaBalanceCard{animation:kitaBalanceCardOut .14s ease-in forwards}",
			"@keyframes kitaBalanceLayerIn{from{opacity:0}to{opacity:1}}",
			"@keyframes kitaBalanceLayerOut{from{opacity:1}to{opacity:0}}",
			"@keyframes kitaBalanceCardIn{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}",
			"@keyframes kitaBalanceCardOut{from{opacity:1;transform:none}to{opacity:0;transform:scale(.98)}}",
			"@media (prefers-reduced-motion:reduce){.kitaBalanceOverlay,.kitaBalanceCard{animation:none}}",
			".kitaBalanceTitle{font-size:14px;font-weight:500;line-height:20px;margin-bottom:2px}",
			".kitaBalanceSubtitle{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;margin-bottom:10px}",
			".kitaBalanceList{display:flex;flex-direction:column;gap:2px;overflow-y:auto;margin:0 -4px;padding:0 4px}",
			".kitaBalanceRow{display:flex;align-items:baseline;gap:10px;padding:7px 6px;border-radius:8px}",
			".kitaBalanceRow_active{background:var(--dsw-alias-interactive-bg-hover)}",
			".kitaBalanceRowName{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".kitaBalanceRowTag{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:4px}",
			".kitaBalanceRowValue{flex:none;font-variant-numeric:tabular-nums;font-weight:500}",
			".kitaBalanceRowValue_bad{font-weight:400;color:var(--dsw-alias-state-error-primary)}",
			".kitaBalanceRowNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;padding:0 6px 4px 6px;word-break:break-word}",
			".kitaBalanceFoot{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:12px;",
			"padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l4)}",
			".kitaBalanceStamp{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}",
			".kitaBalanceActions{display:flex;gap:8px;flex:none}",
			".kitaBalanceAction{height:28px;padding:0 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:12px;",
			"border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);",
			"transition:background-color .16s ease,transform .1s ease}",
			".kitaBalanceAction:hover{background:var(--dsw-alias-interactive-bg-hover)}",
			".kitaBalanceAction:active{transform:scale(.98)}",
			".kitaBalanceAction:disabled{opacity:.55;cursor:default}",
			".kitaBalanceAction:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".kitaBalanceEmpty{color:var(--dsw-alias-label-tertiary);padding:10px 6px}"
		].join("");
		const tagId = "kita-channel-balance/balance.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "kita-channel-balance";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		/** 轮询间隔兜底；快照自带的 refreshIntervalMs 优先。 */
		const POLL_FALLBACK_MS = 60000;
		/** 必须覆盖下面的退出关键帧，卡片在它走完后卸载。 */
		const EXIT_ANIMATION_MS = 160;

		/** 读一份余额快照；force 走 host 的强制刷新路由。 */
		async function fetchState(force) {
			const response = await fetch(force ? "/kita-balance/refresh" : "/kita-balance/state", {
				method: force ? "POST" : "GET",
				headers: { accept: "application/json", ...(force ? { "content-type": "application/json" } : {}) },
				cache: "no-store",
				credentials: "same-origin"
			});
			if (!response.ok) throw new Error("HTTP " + String(response.status));
			return await response.json();
		}

		/** 共享状态：胶囊与面板读同一个 store。 */
		function createBalanceStore() {
			const listeners = new Set();
			const state = {
				status: "idle",
				payload: null,
				error: null,
				refreshing: false,
				panelOpen: false
			};
			let snapshot = { ...state };

			function emit() {
				snapshot = { ...state };
				for (const listener of Array.from(listeners)) listener();
			}

			async function load(force) {
				if (force) {
					state.refreshing = true;
					emit();
				}
				try {
					const payload = await fetchState(force === true);
					state.payload = payload;
					state.error = null;
					state.status = "ready";
				} catch (error) {
					state.error = String(error && error.message ? error.message : error);
					state.status = state.payload === null ? "error" : "stale";
				}
				state.refreshing = false;
				emit();
			}

			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
				get() { return snapshot; },
				load,
				openPanel() { state.panelOpen = true; emit(); },
				closePanel() { state.panelOpen = false; emit(); },
				togglePanel() { state.panelOpen = !state.panelOpen; emit(); }
			};
		}

		/** 当前渠道：会话/默认路由命中的渠道优先，否则第一个官方渠道，再否则第一个渠道。 */
		function pickActive(payload) {
			if (payload === null || payload === undefined || !Array.isArray(payload.channels)) return null;
			const provider = payload.active !== null && payload.active !== undefined ? String(payload.active.provider || "") : "";
			if (provider !== "") {
				const hit = payload.channels.find((channel) => channel.provider === provider);
				if (hit !== undefined) return hit;
			}
			const official = payload.channels.find((channel) => channel.official === true);
			if (official !== undefined) return official;
			return payload.channels.length > 0 ? payload.channels[0] : null;
		}

		/** 渠道本轮可展示的金额：优先余额（remaining），否则额度（total）。 */
		function amountOf(channel) {
			if (channel === null || channel === undefined || channel.balance === null || channel.balance === undefined) return null;
			const value = channel.balance.remaining !== null && channel.balance.remaining !== undefined
				? channel.balance.remaining
				: channel.balance.total;
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : null;
		}

		function formatAmount(value, currency) {
			if (value === null) return "";
			const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : "";
			const magnitude = Math.abs(value);
			const digits = magnitude > 0 && magnitude < 1 ? 4 : 2;
			return symbol + value.toFixed(digits);
		}

		const STATUS_TEXT = {
			"no-key": "未配置凭据",
			auth: "鉴权失败",
			error: "查询失败",
			unsupported: "无余额端点"
		};

		/** 一枚渠道的展示摘要：金额文本 + 是否告警 + 悬浮说明。 */
		function summarize(channel) {
			if (channel === null || channel === undefined) {
				return { text: "—", tone: "muted", title: "未发现可用渠道" };
			}
			if (channel.status === "ok") {
				const balance = channel.balance;
				const currency = balance !== null && balance !== undefined ? balance.currency : "";
				// new-api 对无限额度 token 回 1 亿哨兵值，直接显示金额会变成一长串数字。
				if (balance !== null && balance !== undefined && balance.unlimited === true) {
					return { text: "无限额度", tone: "normal", title: channel.label + "：站点返回无限额度" };
				}
				const amount = amountOf(channel);
				const text = formatAmount(amount, currency);
				const stale = channel.available === false;
				return {
					text: text === "" ? "—" : text,
					tone: stale ? "warn" : "normal",
					title: channel.label + (stale ? "（余额不足）" : "")
				};
			}
			return {
				text: STATUS_TEXT[channel.status] !== undefined ? STATUS_TEXT[channel.status] : "—",
				tone: "muted",
				title: channel.label + (channel.message ? "：" + channel.message : "")
			};
		}

		function formatStamp(generatedAt) {
			if (typeof generatedAt !== "number" || !Number.isFinite(generatedAt)) return "尚未取到数据";
			const date = new Date(generatedAt);
			const pad = (value) => String(value).padStart(2, "0");
			return "更新于 " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
		}

		/** Composer 工具行里的余额胶囊（模型选择器同排）。 */
		function BalanceChip(props) {
			const balance = props.balance;
			const [state, setState] = react.useState(balance.get());
			react.useEffect(() => balance.subscribe(() => setState(balance.get())), [balance]);
			const payload = state.payload;
			const channel = pickActive(payload);
			const summary = summarize(channel);
			const toneClass = summary.tone === "warn"
				? " kitaBalanceChip_warn"
				: summary.tone === "muted" ? " kitaBalanceChip_muted" : "";
			const pending = state.status === "idle" || (state.status === "error" && payload === null);
			return react.createElement("button", {
				type: "button",
				className: "kitaBalanceChip" + toneClass,
				title: summary.title + (state.error !== null ? "（" + state.error + "）" : ""),
				"aria-label": "渠道余额：" + summary.text,
				onClick: () => balance.togglePanel()
			}, [
				react.createElement("span", { key: "dot", className: "kitaBalanceChipDot", "aria-hidden": "true" }),
				react.createElement("span", { key: "value", className: "kitaBalanceChipValue" }, pending ? "余额 …" : summary.text)
			]);
		}

		/** 明细面板：全部渠道 + 生成时间 + 手动刷新。 */
		function BalancePanel(props) {
			const balance = props.balance;
			const [state, setState] = react.useState(balance.get());
			react.useEffect(() => balance.subscribe(() => setState(balance.get())), [balance]);
			const open = state.panelOpen;
			const [mounted, setMounted] = react.useState(open);
			const [leaving, setLeaving] = react.useState(false);

			react.useEffect(() => {
				if (open) {
					setLeaving(false);
					setMounted(true);
					return undefined;
				}
				if (!mounted) return undefined;
				setLeaving(true);
				const timer = setTimeout(() => {
					setLeaving(false);
					setMounted(false);
				}, EXIT_ANIMATION_MS);
				return () => clearTimeout(timer);
			}, [open, mounted]);

			react.useEffect(() => {
				if (!mounted || leaving) return undefined;
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					balance.closePanel();
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [mounted, leaving, balance]);

			react.useEffect(() => {
				if (open) void balance.load(false);
			}, [open, balance]);

			if (!mounted) return null;

			const payload = state.payload;
			const channels = payload !== null && payload !== undefined && Array.isArray(payload.channels) ? payload.channels : [];
			const active = pickActive(payload);
			const activeProvider = active !== null && active !== undefined ? active.provider : "";

			const rows = [];
			if (channels.length === 0) {
				rows.push(react.createElement("div", { key: "empty", className: "kitaBalanceEmpty" }, "未发现渠道：settings 里没有 provider 配置？"));
			}
			for (const channel of channels) {
				const summary = summarize(channel);
				let note = String(channel.message || "");
				if (channel.status === "ok") {
					note = channel.template === "deepseek-platform" ? "平台账号余额" : String(channel.endpoint || "");
					const balance = channel.balance;
					if (balance !== null && balance !== undefined && balance.used !== null && balance.used !== undefined) {
						note = "已用 " + formatAmount(Number(balance.used), balance.currency);
					} else if (balance !== null && balance !== undefined && balance.granted !== null && balance.granted !== undefined) {
						note = (channel.template === "deepseek-platform" ? "平台账号余额 · " : "") + "赠金 " + formatAmount(Number(balance.granted), balance.currency);
					}
				}
				rows.push(react.createElement("div", {
					key: "row:" + channel.provider,
					className: "kitaBalanceRow" + (channel.provider === activeProvider ? " kitaBalanceRow_active" : "")
				}, [
					react.createElement("span", { key: "name", className: "kitaBalanceRowName" },
						channel.label,
						channel.official === true ? react.createElement("span", { className: "kitaBalanceRowTag" }, "官方") : null
					),
					react.createElement("span", {
						key: "value",
						className: "kitaBalanceRowValue" + (summary.tone === "muted" ? " kitaBalanceRowValue_bad" : "")
					}, summary.text)
				]));
				if (note !== "") {
					rows.push(react.createElement("div", { key: "note:" + channel.provider, className: "kitaBalanceRowNote" }, note));
				}
			}

			return react.createElement("div", { className: "kitaBalanceOverlay" + (leaving ? " kitaBalanceLeave" : "") }, [
				react.createElement("div", {
					key: "mask",
					className: "kitaBalanceMask",
					"aria-hidden": "true",
					onClick: () => balance.closePanel()
				}),
				react.createElement("div", {
					key: "card",
					className: "kitaBalanceCard",
					role: "dialog",
					"aria-label": "渠道余额"
				}, [
					react.createElement("div", { key: "title", className: "kitaBalanceTitle" }, "渠道余额"),
					react.createElement("div", { key: "subtitle", className: "kitaBalanceSubtitle" },
						payload !== null && payload !== undefined && payload.active !== null && payload.active !== undefined && payload.active.model
							? "当前会话路由 " + String(payload.active.provider || "") + " / " + String(payload.active.model)
							: "按设置里的默认路由高亮"),
					react.createElement("div", { key: "list", className: "kitaBalanceList" }, rows),
					react.createElement("div", { key: "foot", className: "kitaBalanceFoot" }, [
						react.createElement("span", { key: "stamp", className: "kitaBalanceStamp" },
							state.error !== null && state.status !== "ready"
								? "取快照失败：" + state.error
								: formatStamp(payload !== null && payload !== undefined ? payload.generatedAt : null)
						),
						react.createElement("span", { key: "actions", className: "kitaBalanceActions" }, [
							react.createElement("button", {
								key: "refresh",
								type: "button",
								className: "kitaBalanceAction",
								disabled: state.refreshing === true,
								onClick: () => { void balance.load(true); }
							}, state.refreshing === true ? "刷新中…" : "刷新"),
							react.createElement("button", {
								key: "close",
								type: "button",
								className: "kitaBalanceAction",
								onClick: () => balance.closePanel()
							}, "关闭")
						])
					])
				])
			]);
		}

		const inject = ["slots"];

		function apply(ctx) {
			const balance = createBalanceStore();
			let pollTimer = null;

			function schedule(intervalMs) {
				if (pollTimer !== null) clearInterval(pollTimer);
				const period = typeof intervalMs === "number" && intervalMs > 0 ? intervalMs : POLL_FALLBACK_MS;
				pollTimer = setInterval(() => { void balance.load(false); }, period);
			}

			// 快照自带轮询节奏时跟随它，否则用兜底间隔。
			const unsubscribe = balance.subscribe(() => {
				const snapshot = balance.get();
				if (snapshot.payload !== null && snapshot.payload !== undefined && typeof snapshot.payload.refreshIntervalMs === "number") {
					schedule(snapshot.payload.refreshIntervalMs);
				}
			});

			ctx.effect(() => () => {
				unsubscribe();
				if (pollTimer !== null) clearInterval(pollTimer);
			}, "kita-channel-balance: poll timer");

			// 回到前台立刻补一次，避免后台标签页错过刷新。
			ctx.effect(() => {
				const onVisible = () => { if (document.visibilityState === "visible") void balance.load(false); };
				document.addEventListener("visibilitychange", onVisible);
				return () => document.removeEventListener("visibilitychange", onVisible);
			}, "kita-channel-balance: visibility refresh");

			ctx.slots.inject("conversation.input.left", () => ctx.slots.register({
				name: "conversation.input.left",
				id: "kita-channel-balance",
				order: 5,
				inject: () => ({ balance })
			}, BalanceChip));

			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "kita-channel-balance.panel",
				order: 91,
				inject: () => ({ balance })
			}, BalancePanel));

			schedule(POLL_FALLBACK_MS);
			void balance.load(false);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
