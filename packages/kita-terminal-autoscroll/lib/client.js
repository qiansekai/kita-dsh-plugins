/**
 * kita-terminal-autoscroll client half — keep terminal output pinned to the
 * newest line.
 *
 * Problem: dsh renders every shell surface through the shared TerminalBlock
 * primitive, whose output region is an 'overflow-y: auto' scroller capped by
 * '--dsl-terminal-output-max-height' (288px in the background-jobs menu, 224px
 * in tool cards). New output is appended at the BOTTOM while the browser leaves
 * 'scrollTop' where it was, so the view stays on the older lines and the user
 * has to drag the scrollbar after every batch of output.
 *
 * Fix: sticky-bottom follow. When a terminal scroller's content grows we pin it
 * to 'scrollHeight'; scrolling up pauses the follow, returning to the bottom
 * resumes it. Nothing is injected into the official components and no CSS-module
 * class name is matched — the engine watches the DOM under every
 * '[data-terminal]' card, so it also survives upstream class-name churn.
 *
 * Only a GROWING scrollHeight counts as new output: the same card also hosts the
 * command banner, which scrolls on its own for long multi-line commands, and
 * yanking that one to its end would hide the command's first line.
 *
 * This file is a client module-system CJS bundle: it must stay in the
 * window.__ModuleLoader__.load({ id, factory }) form.
 */
window.__ModuleLoader__.load({
	id: "kita-terminal-autoscroll",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/** Terminal cards (TerminalBlock) carry this attribute on their root. */
		const DEFAULT_SELECTORS = ["[data-terminal]"];
		/** A scroller this close to the bottom still counts as pinned. */
		const DEFAULT_STICK_THRESHOLD_PX = 24;
		/** overflow-y values that make an element a scroll surface. */
		const SCROLLABLE = /^(auto|scroll)$/;
		/** Field-diagnostics handle. */
		const DEBUG_KEY = "__kitaTerminalAutoscroll";
		/** Extra frames allowed for a card whose layout has not settled yet. */
		const MAX_SETTLE_RETRIES = 2;

		/** Element for a node, or the node itself when it already is one. */
		function elementOf(node) {
			if (!node) return null;
			if (node.nodeType === 1) return node;
			return node.parentElement || null;
		}

		/** Whether an element scrolls vertically on its own. */
		function isScrollable(el) {
			if (!el || el.nodeType !== 1) return false;
			if (typeof getComputedStyle !== "function") return false;
			const style = getComputedStyle(el);
			return !!style && SCROLLABLE.test(String(style.overflowY || ""));
		}

		/** requestAnimationFrame, with a timer fallback for tests / hidden tabs. */
		function nextFrame(run) {
			if (typeof requestAnimationFrame === "function") return requestAnimationFrame(run);
			return setTimeout(run, 16);
		}

		/** Counterpart of nextFrame. */
		function cancelFrame(handle) {
			if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
			else clearTimeout(handle);
		}

		/**
		 * Build the follow engine against one document.
		 * @param doc - document whose terminal cards are followed.
		 * @param options - resolved selectors and stick threshold.
		 * @returns engine handle with scan, flush and stop.
		 */
		function createEngine(doc, options) {
			const selectors = options.selectors;
			const threshold = options.stickThresholdPx;
			const cachedScrollers = new WeakMap();
			const pinnedState = new WeakMap();
			const lastHeight = new WeakMap();
			const settleRetries = new WeakMap();
			let dirty = new Set();
			let frame = 0;

			/** Nearest terminal card containing a node, if any. */
			function rootOf(node) {
				const el = elementOf(node);
				if (!el || typeof el.closest !== "function") return null;
				for (const selector of selectors) {
					const root = el.closest(selector);
					if (root) return root;
				}
				return null;
			}

			/** Whether an element IS one of the configured terminal cards. */
			function isRoot(el) {
				if (!el || typeof el.matches !== "function") return false;
				for (const selector of selectors) {
					if (el.matches(selector)) return true;
				}
				return false;
			}

			/**
			 * Scroll surfaces inside one card. Cached because a card's structure is
			 * stable, but an empty result is never cached: the output region can
			 * appear one commit after the card itself.
			 */
			function scrollersOf(root) {
				const cached = cachedScrollers.get(root);
				if (cached) return cached;
				const found = [];
				const stack = [root];
				while (stack.length > 0) {
					const el = stack.pop();
					if (el !== root && isScrollable(el)) found.push(el);
					for (let i = 0; i < el.children.length; i++) stack.push(el.children[i]);
				}
				if (found.length > 0) cachedScrollers.set(root, found);
				return found;
			}

			function pinned(el) {
				return pinnedState.get(el) !== false;
			}

			/**
			 * Follow one scroller that just grew.
			 * @returns whether the scroller was moved.
			 */
			function follow(el) {
				const height = el.scrollHeight;
				const previous = lastHeight.get(el) || 0;
				lastHeight.set(el, height);
				if (height <= previous) return false;
				if (!pinned(el)) return false;
				el.scrollTop = height;
				return true;
			}

			function flush() {
				frame = 0;
				const roots = dirty;
				dirty = new Set();
				const retry = [];
				for (const root of roots) {
					if (root.isConnected === false) {
						settleRetries.delete(root);
						continue;
					}
					let settling = false;
					for (const el of scrollersOf(root)) {
						follow(el);
						// A card that mounted this frame may not have laid out yet; a
						// couple more frames pick up the settled height.
						const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
						if (pinned(el) && remaining > 1 && (settleRetries.get(root) || 0) < MAX_SETTLE_RETRIES) {
							settleRetries.set(root, (settleRetries.get(root) || 0) + 1);
							settling = true;
						}
					}
					if (settling) retry.push(root);
					else settleRetries.delete(root);
				}
				if (retry.length > 0) {
					for (const root of retry) dirty.add(root);
					schedule();
				}
			}

			function schedule() {
				if (frame) return;
				frame = nextFrame(flush);
			}

			function consider(node) {
				const el = elementOf(node);
				if (!el) return;
				if (isRoot(el)) {
					dirty.add(el);
					return;
				}
				const root = rootOf(el);
				if (root) dirty.add(root);
			}

			function onMutations(records) {
				for (const record of records) {
					consider(record.target);
					const added = record.addedNodes;
					if (added) {
						for (let i = 0; i < added.length; i++) consider(added[i]);
					}
				}
				schedule();
			}

			/** A scroller moved: re-derive whether the user is still at the bottom. */
			function onScroll(event) {
				const el = event.target;
				if (!isScrollable(el)) return;
				const remaining = el.scrollHeight - el.scrollTop - el.clientHeight;
				pinnedState.set(el, remaining <= threshold);
			}

			/**
			 * Adopt cards that already exist when the plugin loads: record their
			 * current height as the baseline so history is NOT yanked to the bottom,
			 * while every later append is followed.
			 */
			function scan() {
				const existing = doc.querySelectorAll(selectors.join(", "));
				for (let r = 0; r < existing.length; r++) {
					const root = existing[r];
					for (const el of scrollersOf(root)) lastHeight.set(el, el.scrollHeight);
				}
			}

			const observer = new MutationObserver(onMutations);
			const observed = doc.documentElement || doc;
			observer.observe(observed, { subtree: true, childList: true, characterData: true });
			doc.addEventListener("scroll", onScroll, true);

			return {
				scan,
				flush,
				stop() {
					observer.disconnect();
					doc.removeEventListener("scroll", onScroll, true);
					if (frame) cancelFrame(frame);
					frame = 0;
					dirty = new Set();
				}
			};
		}

		/**
		 * Plugin entry point.
		 * @param ctx - cordis client context.
		 * @param config - optional selectors / stickThresholdPx.
		 */
		function apply(ctx, config) {
			if (typeof document === "undefined") return;
			const configured = (config && Array.isArray(config.selectors))
				? config.selectors.filter((s) => typeof s === "string" && s.length > 0)
				: [];
			const options = {
				selectors: configured.length > 0 ? configured.slice() : DEFAULT_SELECTORS.slice(),
				stickThresholdPx: (config && Number.isFinite(config.stickThresholdPx)) ? config.stickThresholdPx : DEFAULT_STICK_THRESHOLD_PX
			};
			const engine = createEngine(document, options);
			engine.scan();
			if (ctx && typeof ctx.effect === "function") ctx.effect(() => () => engine.stop());
			try {
				globalThis[DEBUG_KEY] = { engine, options };
			} catch { /* non-browser env */ }
		}

		exports.apply = apply;
		return module.exports;
	}
});
