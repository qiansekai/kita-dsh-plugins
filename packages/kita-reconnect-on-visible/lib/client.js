/**
 * kita-reconnect-on-visible client half — auto-reconnect when the tab comes
 * back to the foreground.
 *
 * Problem: when the phone (or any client) goes to sleep / background for a
 * while, the browser drops the WebSocket. The official ConnectionController
 * auto-retries (0.5s..10s tiers) and then lands on the terminal
 * `disconnected` state, from which it only resumes on a browser `online`
 * event. Returning from lock screen does NOT fire `online` (the network did
 * not change), so the user must click the "立即重连" button every time.
 *
 * Fix: listen for `visibilitychange`; when the tab turns visible and the
 * shell's ConnectionIndicator is in the terminal `disconnected` phase
 * (`button[data-phase="disconnected"]`), click it — equivalent to the manual
 * recovery action, preserving page state (no reload).
 *
 * Deliberately DOM-based instead of injecting the `connection` service:
 * no framework-service contract to hold, no activation gating, silent no-op
 * if the official markup ever changes.
 *
 * This file is a client module-system CJS bundle: it must stay in the
 * `window.__ModuleLoader__.load({ id, factory })` form.
 */
window.__ModuleLoader__.load({
  id: "kita-reconnect-on-visible",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    // ConnectionIndicator renders this button only in the terminal
    // disconnected phase; aria-label "连接异常，点击立即重连".
    const BUTTON_SELECTOR = 'button[data-phase="disconnected"]';
    // Debounce window: visibilitychange may fire several times in a row
    // (e.g. quick lock/unlock); one click is enough to restart the loop.
    const CLICK_GAP_MS = 4000;
    // Diagnostic surface for field testing.
    const DEBUG_KEY = "__kitaReconnectOnVisible";

    function apply(ctx) {
      let lastClickAt = 0;

      const tryReconnect = () => {
        if (typeof document === "undefined" || document.visibilityState !== "visible") return;
        const button = document.querySelector(BUTTON_SELECTOR);
        if (!button) return;
        const now = Date.now();
        if (now - lastClickAt < CLICK_GAP_MS) return;
        lastClickAt = now;
        if (typeof console !== "undefined") {
          console.log("[kita-reconnect-on-visible] disconnected banner present after visibility change; clicking reconnect");
        }
        button.click();
      };

      ctx.effect(() => {
        document.addEventListener("visibilitychange", tryReconnect);
        // Mount-time safety net: if the tab unfroze after the terminal
        // disconnected state was published, the visibilitychange event may
        // already have been consumed before this plugin applied.
        tryReconnect();
        return () => {
          document.removeEventListener("visibilitychange", tryReconnect);
        };
      });

      try {
        globalThis[DEBUG_KEY] = { tryReconnect };
      } catch { /* non-browser env */ }
    }

    exports.apply = apply;
    return module.exports;
  }
});
