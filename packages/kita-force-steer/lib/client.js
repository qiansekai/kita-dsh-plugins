/**
 * kita-force-steer client half — one gesture that interrupts the running turn
 * AND hands it your message.
 *
 * Official steering (busy-Enter / Cmd+Enter / "插话发送" on a queued row) only
 * lands at a step boundary: ReactLoopAgent#preStep claims the next-step inbox
 * when a step opens, and a step is one model request plus its tool calls. A
 * steer submitted while a long tool call runs therefore waits behind that
 * call. The stronger primitive already exists one layer down: SessionFace
 * .cancel() aborts the active turn while KEEPING the pending inbox ("Pending
 * queued work remains and resumes in FIFO order after the Host reaches
 * cancellation quiescence"), and that abort signal reaches the tool itself
 * (the PTC runtime kills its node child on abort). This plugin pairs the two:
 * cancel first, then submit the draft as steering, so the message is admitted
 * as soon as the cancelled activity converges instead of waiting for the tool.
 *
 * Everything rides public faces — ctx.sessions.binding(id).session for
 * cancel/prompt, the slot's own useInput/inputActions for the draft. No
 * official package is patched and no CSS-module class name is matched.
 *
 * This file is a client module-system CJS bundle: it must stay in the
 * window.__ModuleLoader__.load({ id, factory }) form.
 */
window.__ModuleLoader__.load({
	id: "kita-force-steer",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var react = require("react");

		// ---- Package-owned stylesheet (idempotent, framework-cleanup convention) ----
		const CSS = [
			".kitaForceSteer{display:inline-flex;align-items:center;gap:5px;height:28px;box-sizing:border-box;",
			"padding:0 9px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:transparent;",
			"color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:16px;",
			"cursor:pointer;white-space:nowrap;overflow:hidden;transition:background-color .16s ease,color .16s ease}",
			".kitaForceSteer:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".kitaForceSteer:disabled{opacity:.4;cursor:default}",
			".kitaForceSteer:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
			".kitaForceSteerGlyph{width:12px;height:12px;flex:none;display:block}",
			".kitaForceSteer_armed{color:var(--dsw-alias-state-error-primary)}"
		].join("");

		const STYLE_ID = "kita-force-steer-style";
		/** Field-diagnostics handle. */
		const DEBUG_KEY = "__kitaForceSteer";

		/** Inject the package stylesheet once per document. */
		function installStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID) !== null) return;
			const tag = document.createElement("style");
			tag.id = STYLE_ID;
			tag.textContent = CSS;
			(document.head === null ? document.documentElement : document.head).appendChild(tag);
		}

		/** Interrupt glyph: a bolt, read as "act now". */
		function glyph() {
			return react.createElement("svg", {
				className: "kitaForceSteerGlyph",
				viewBox: "0 0 16 16",
				"aria-hidden": "true",
				focusable: "false"
			}, react.createElement("path", {
				fill: "currentColor",
				d: "M9.2 1.2 3.4 8.6h3.3l-.9 6.2 6.8-8.4H9.5z"
			}));
		}

		/**
		 * Composer control that cancels the running turn and immediately submits
		 * the current draft as steering.
		 * @param props - slot runtime props (sessionId plus the session standard kit)
		 *   and this entry's injected forceSteer face.
		 */
		function ForceSteerButton(props) {
			const forceSteer = props.forceSteer;
			const sessionId = props.sessionId;
			const inputActions = props.inputActions;
			const draft = props.useInput((s) => s.draft);
			const phase = props.useInput((s) => s.phase);
			const attachmentCount = props.useInput((s) => (s.attachmentIds === undefined ? 0 : s.attachmentIds.length));
			const running = props.useSession((s) => s.running) === true;
			const removed = props.useSession((s) => s.removed) === true;
			// Latest draft for the async settlement guard (clear only if untouched).
			const latestDraft = react.useRef(draft);
			latestDraft.current = draft;
			const machineBusy = phase === "adjudicating" || phase === "submitting";
			const hasDraft = draft.trim() !== "" || attachmentCount > 0;
			const disabled = !running || removed || machineBusy || inputActions === undefined;
			const title = running
				? (hasDraft ? "强制插话：打断当前生成并立即发送草稿" : "强制插话：打断当前生成")
				: "仅运行中可强制插话";
			const onPress = react.useCallback(() => {
				if (disabled) return;
				// 1) Interrupt first: the Host keeps the inbox, so anything already
				//    queued (and the message below) runs once the abort converges.
				forceSteer.cancel(sessionId);
				if (!hasDraft) return;
				// 2) Attachments need the official submit machine (file receipts and
				//    image serialization live there); plain text goes straight out as
				//    steering so it does not depend on the busy-Enter preference.
				if (attachmentCount > 0) {
					inputActions.submit();
					return;
				}
				const submitted = draft;
				void forceSteer.steer(sessionId, submitted).then((ok) => {
					if (ok && latestDraft.current === submitted) inputActions.setDraft("");
				});
			}, [
				disabled,
				hasDraft,
				attachmentCount,
				draft,
				sessionId,
				forceSteer,
				inputActions
			]);
			return react.createElement("button", {
				type: "button",
				className: "kitaForceSteer" + (hasDraft ? " kitaForceSteer_armed" : ""),
				title,
				"aria-label": title,
				disabled,
				onClick: onPress
			}, [
				glyph(),
				react.createElement("span", { key: "label" }, hasDraft ? "插话" : "打断")
			]);
		}

		/**
		 * Build the business face over the Client sessions service.
		 * @param ctx - client cordis context.
		 * @returns cancel/steer verbs addressed by session id.
		 */
		function createForceSteer(ctx) {
			/** The materialized Session binding for one id, or undefined. */
			function bindingOf(sessionId) {
				try {
					return ctx.sessions.binding(sessionId);
				} catch (error) {
					return undefined;
				}
			}
			return {
				/**
				 * Abort the active turn, keeping pending inbox work.
				 * @param sessionId - addressed session.
				 */
				cancel(sessionId) {
					const binding = bindingOf(sessionId);
					if (binding === undefined) return;
					void binding.session.cancel().catch(() => {});
				},
				/**
				 * Admit one plain-text steering message with its local echo.
				 * @param sessionId - addressed session.
				 * @param text - draft text to send.
				 * @returns whether the Host accepted the prompt.
				 */
				async steer(sessionId, text) {
					const binding = bindingOf(sessionId);
					if (binding === undefined) return false;
					const session = binding.session;
					const handle = session.beginSubmission({ mode: "steer", text, attachments: [] });
					let result;
					try {
						result = await session.prompt([{ type: "text", text }], "steer", undefined, handle.requestId);
					} catch (error) {
						handle.abandon();
						return false;
					}
					if (result === undefined || result.ok !== true) {
						handle.abandon();
						return false;
					}
					return true;
				}
			};
		}

		const inject = ["slots", "sessions"];

		/**
		 * Plugin entry point.
		 * @param ctx - cordis client context carrying the slots and sessions services.
		 */
		function apply(ctx) {
			installStyle();
			const forceSteer = createForceSteer(ctx);
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "kita-force-steer",
				order: 20,
				inject: () => ({ forceSteer })
			}, ForceSteerButton));
			try {
				globalThis[DEBUG_KEY] = { forceSteer };
			} catch { /* non-browser env */ }
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
