/**
 * kita-force-steer client half — a busy submission IS an interrupt.
 *
 * Official steering (busy-Enter / the Send button) only lands at a step
 * boundary: ReactLoopAgent#preStep claims the next-step inbox when a step
 * opens, and a step is one model request plus its tool calls. A steer
 * submitted while a long tool call runs therefore waits behind that call.
 * The stronger primitive already exists one layer down: SessionFace.cancel()
 * aborts the active turn while KEEPING the pending inbox ("Pending queued
 * work remains and resumes in FIFO order after the Host reaches cancellation
 * quiescence"), and that abort signal reaches the tool itself (the PTC
 * runtime kills its node child on abort).
 *
 * This half turns that pair into the DEFAULT reading of a busy submission:
 * while the addressed agent is running, plain Enter and the primary Send
 * button are captured at the document boundary, the turn is cancelled, and
 * the draft goes out as steering. The accelerated chord (Cmd/Ctrl+Enter)
 * is deliberately left alone, so the official "opposite mode" still gives
 * an uninterrupted path: with busyEnter=steer that chord queues instead of
 * interrupting.
 *
 * Gestures that must keep working are released untouched:
 *  - the slash/at candidate menu owns Enter while it is open (role=listbox),
 *  - Shift+Enter is a line break, Alt+Ime/accelerated chords stay official,
 *  - an empty draft never interrupts,
 *  - the submit machine's own busy phases (adjudicating/submitting) are left
 *    to the official bar.
 *
 * Everything rides public faces — ctx.sessions.binding(id).session for
 * cancel/prompt, the slot's own useInput/inputActions for the draft. No
 * official package is patched and no CSS-module hash is matched for the
 * business path; the send button is recognized through the official
 * data-composer-card marker plus the composer row's primary control.
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

		/** Field-diagnostics handle. */
		const DEBUG_KEY = "__kitaForceSteer";
		/** Official composer surface marker (stable data attribute). */
		const CARD_SELECTOR = "[data-composer-card]";
		/** The composer row's primary control is the Send button. */
		const SEND_SELECTOR = "[class*=\"_primary\"]";
		/** The slash/at candidate menu: while open it owns the Enter key. */
		const MENU_SELECTOR = "[data-composer-card] [role=\"listbox\"]";
		/** Submit-machine phases that already own the gesture. */
		const MACHINE_BUSY_PHASES = ["adjudicating", "submitting"];

		/**
		 * Stop one composer gesture before the official handler sees it.
		 * @param event - the document-level keyboard or pointer event.
		 */
		function swallow(event) {
			event.preventDefault();
			event.stopPropagation();
			if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
		}

		/**
		 * Whether one DOM node belongs to the composer's Send button.
		 * @param target - the event target.
		 * @returns whether the target sits inside the primary control of a composer card.
		 */
		function isSendButton(target) {
			if (target === null || target === undefined || typeof target.closest !== "function") return false;
			const card = target.closest(CARD_SELECTOR);
			if (card === null) return false;
			const primary = target.closest(SEND_SELECTOR);
			return primary !== null && card.contains(primary);
		}

		/**
		 * Whether the slash/at candidate menu currently owns the keyboard.
		 * @param doc - the document to inspect.
		 * @returns whether an open candidate listbox exists inside a composer card.
		 */
		function menuOwnsKeyboard(doc) {
			try {
				return doc.querySelector(MENU_SELECTOR) !== null;
			} catch (error) {
				return false;
			}
		}

		/**
		 * Cancel the running turn, then deliver the draft as steering.
		 * @param forceSteer - the cancel/steer business face.
		 * @param sessionId - addressed session.
		 * @param inputActions - the slot's composer actions (draft + official submit).
		 * @param draft - draft text captured for this gesture.
		 * @param attachmentCount - number of attachment drafts carried with the gesture.
		 * @param readDraft - reads the current draft (settlement guard for clearing).
		 */
		function deliver(forceSteer, sessionId, inputActions, draft, attachmentCount, readDraft) {
			// 1) Interrupt first: the Host keeps the inbox, so the message below
			//    runs as soon as the aborted activity converges.
			forceSteer.cancel(sessionId);
			if (draft.trim() === "" && attachmentCount === 0) return;
			// 2) Attachments need the official submit machine (file receipts and
			//    image serialization live there); plain text goes straight out as
			//    steering so it never depends on the busy-Enter preference.
			if (attachmentCount > 0) {
				inputActions.submit();
				return;
			}
			const submitted = draft;
			void forceSteer.steer(sessionId, submitted).then((ok) => {
				if (ok && readDraft() === submitted) inputActions.setDraft("");
			});
		}

		/**
		 * Headless composer control: installs the busy-submission interceptor and
		 * renders nothing. It exists as a slot occupant only to receive the
		 * session/input runtime props the interceptor needs.
		 * @param props - slot runtime props (sessionId plus the session standard kit)
		 *   and this entry's injected forceSteer face.
		 * @returns null (no DOM of its own).
		 */
		function ForceSteerGesture(props) {
			const forceSteer = props.forceSteer;
			const sessionId = props.sessionId;
			const inputActions = props.inputActions;
			const draft = props.useInput((s) => s.draft);
			const phase = props.useInput((s) => s.phase);
			const attachmentCount = props.useInput((s) => (s.attachmentIds === undefined ? 0 : s.attachmentIds.length));
			const running = props.useSession((s) => s.running) === true;
			const removed = props.useSession((s) => s.removed) === true;
			// Latest readings for the document-level listeners, which outlive one render.
			const latest = react.useRef({ draft, attachmentCount, running, removed, phase });
			latest.current = { draft, attachmentCount, running, removed, phase };
			const readDraft = react.useCallback(() => latest.current.draft, []);
			react.useEffect(() => {
				const doc = document;
				/** Whether a gesture may be claimed right now. */
				function claimable() {
					const now = latest.current;
					if (!now.running || now.removed) return false;
					if (now.phase === "adjudicating" || now.phase === "submitting") return false;
					return inputActions !== undefined;
				}
				/** Whether this gesture carries anything to deliver. */
				function carriesContent() {
					const now = latest.current;
					return now.draft.trim() !== "" || now.attachmentCount > 0;
				}
				/** Run the interrupt-then-steer gesture for the current draft. */
				function claim(event) {
					const now = latest.current;
					swallow(event);
					deliver(forceSteer, sessionId, inputActions, now.draft, now.attachmentCount, readDraft);
				}
				/**
				 * Plain Enter submits. Shift+Enter is a line break, the accelerated
				 * chord keeps the official opposite mode, and an open candidate menu
				 * keeps the key for itself.
				 */
				function onKeyDown(event) {
					if (event.key !== "Enter" || event.isComposing === true) return;
					if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
					if (!claimable() || !carriesContent()) return;
					if (menuOwnsKeyboard(doc)) return;
					claim(event);
				}
				/** The primary Send button shares the plain-Enter semantics. */
				function onClick(event) {
					if (!claimable() || !carriesContent()) return;
					if (!isSendButton(event.target)) return;
					claim(event);
				}
				doc.addEventListener("keydown", onKeyDown, true);
				doc.addEventListener("click", onClick, true);
				return () => {
					doc.removeEventListener("keydown", onKeyDown, true);
					doc.removeEventListener("click", onClick, true);
				};
			}, [sessionId, forceSteer, inputActions, readDraft]);
			return null;
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
			const forceSteer = createForceSteer(ctx);
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "kita-force-steer",
				order: 20,
				inject: () => ({ forceSteer })
			}, ForceSteerGesture));
			try {
				globalThis[DEBUG_KEY] = { forceSteer, mode: "busy-submit-interrupt" };
			} catch { /* non-browser env */ }
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
