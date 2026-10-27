/**
 * kita-reconnect-on-visible client half — reconnect when the tab returns to the
 * foreground, then repair a Session list that went stale while it was away.
 *
 * Problem 1 (v1.0.0): a tab that goes to sleep or backgrounds for a while loses
 * its WebSocket. The official ConnectionController retries (0.5s..10s tiers) and
 * then lands on the terminal disconnected state, from which it only resumes on a
 * browser 'online' event. Returning from the lock screen does not fire 'online',
 * so the user had to click the reconnect button every time.
 *
 * Problem 2 (v1.1.0): the Session list is maintained incrementally. The Host
 * broadcasts 'api-session/added' once, when the Session is created, and never
 * replays it. A tab that was disconnected while another client (e.g. the phone)
 * created Sessions keeps its old list indefinitely: the sidebar silently omits
 * those rows until the page is reloaded. The official re-established-generation
 * path (handleConnected -> refreshList) does re-query, but only when the
 * connection actually drops and re-establishes; a tab that misses the broadcast
 * window without a measurable disconnect never repairs itself.
 *
 * Fix: after the tab becomes visible again, verify the list against the Host
 * and rebuild it when the Host reports Sessions this client does not know. The
 * rebuild is location.reload() because no client-facing service exposes
 * refreshList. A reload is disruptive, so the rails are:
 *   - never while the composer holds a draft (the user is typing),
 *   - only once the client list phase is 'ready' (no half-loaded comparison),
 *   - the same missing-set reloads at most once per RELOAD_COOLDOWN_MS,
 *   - two reloads are always at least RELOAD_MIN_GAP_MS apart (no loop),
 *   - localStorage 'kita-reconnect-on-visible.autoReload' = 'off' disables
 *     automatic rebuilds (banner plus manual refresh still available),
 *   - globalThis.__kitaReconnectOnVisible.disableAutoReload() is a live gate.
 * A background poll only shows the banner; it never reloads.
 *
 * Deliberately DOM plus public services: no private Session-controller state.
 * This file is a client module-system CJS bundle: it must stay in the
 * window.__ModuleLoader__.load({ id, factory }) form.
 */
window.__ModuleLoader__.load({
  id: "kita-reconnect-on-visible",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /** ConnectionIndicator renders this button only in the terminal disconnected phase. */
    const BUTTON_SELECTOR = 'button[data-phase="disconnected"]';
    /** Debounce for repeated visibilitychange bursts (quick lock/unlock). */
    const CLICK_GAP_MS = 4000;
    /** Minimum gap between two Host list verifications. */
    const CHECK_GAP_MS = 20000;
    /** Background verification cadence; only ever shows the banner. */
    const POLL_MS = 120000;
    /** Same missing-set: do not auto-reload again before this window elapses. */
    const RELOAD_COOLDOWN_MS = 600000;
    /** Two reloads are always at least this far apart, whatever the signature. */
    const RELOAD_MIN_GAP_MS = 60000;
    /** Diagnostic surface for field testing. */
    const DEBUG_KEY = "__kitaReconnectOnVisible";
    /** localStorage guards (both are plain strings, never secrets). */
    const RELOAD_GUARD_KEY = "kita-reconnect-on-visible.reloadGuard";
    const AUTO_RELOAD_KEY = "kita-reconnect-on-visible.autoReload";
    /** Banner element id. */
    const BANNER_ID = "kita-reconnect-on-visible-banner";

    //#region pure helpers (unit-tested offline by scripts/verify-client.mjs)

    /**
     * Sessions the Host reports that this client list does not know.
     * @param serverItems - Host session.list items (may be anything).
     * @param localState - client SessionListState snapshot.
     * @returns missing Session ids, or null when the comparison is unsafe.
     */
    function sessionMissing(serverItems, localState) {
      if (!Array.isArray(serverItems)) return null;
      if (localState === null || typeof localState !== "object") return null;
      if (localState.phase !== "ready") return null;
      const byId = localState.byId;
      if (byId === null || typeof byId !== "object") return null;
      const missing = [];
      for (const item of serverItems) {
        if (item === null || typeof item !== "object") continue;
        const id = item.sessionId;
        if (typeof id !== "string" || id === "") continue;
        // Subagent children are hidden by the sidebar by design; never rebuild for them.
        if (item.origin === "subagent") continue;
        if (Object.prototype.hasOwnProperty.call(byId, id)) continue;
        missing.push(id);
      }
      return missing;
    }

    /**
     * Order-independent signature of a missing set.
     * @param ids - Session ids.
     * @returns stable signature string.
     */
    function missingSignature(ids) {
      return [...ids].sort().join("\n");
    }

    /** @returns whether automatic rebuilds are enabled by the stored switch. */
    function autoReloadEnabled() {
      try {
        const value = globalThis.localStorage?.getItem(AUTO_RELOAD_KEY);
        return value !== "off";
      } catch {
        return true;
      }
    }

    /** @returns the stored reload guard, or null. */
    function readReloadGuard() {
      try {
        const raw = globalThis.localStorage?.getItem(RELOAD_GUARD_KEY);
        if (typeof raw !== "string") return null;
        const parsed = JSON.parse(raw);
        return parsed !== null && typeof parsed === "object" ? parsed : null;
      } catch {
        return null;
      }
    }

    /** Persist one reload decision so a loop cannot form across reloads. */
    function writeReloadGuard(guard) {
      try {
        globalThis.localStorage?.setItem(RELOAD_GUARD_KEY, JSON.stringify(guard));
      } catch { /* storage unavailable: the in-memory gates still apply */ }
    }

    /**
     * Decide whether an automatic reload may run now.
     * @param signature - missing-set signature being handled.
     * @param now - current epoch milliseconds.
     * @returns whether the reload is allowed.
     */
    function reloadAllowed(signature, now) {
      const guard = readReloadGuard();
      if (guard === null) return true;
      if (typeof guard.at === "number" && now - guard.at < RELOAD_MIN_GAP_MS) return false;
      if (guard.signature === signature && typeof guard.at === "number" && now - guard.at < RELOAD_COOLDOWN_MS) return false;
      return true;
    }

    /** @returns whether the composer currently holds user input. */
    function composerHasDraft() {
      if (typeof document === "undefined" || document.querySelector === undefined) return false;
      const card = document.querySelector("[data-composer-card]");
      if (card === null) return false;
      const field = card.querySelector('textarea, input[type="text"], [contenteditable="true"]');
      if (field === null) return false;
      const value = typeof field.value === "string" ? field.value : (field.textContent ?? "");
      return value.trim() !== "";
    }

    //#endregion

    /** Remove the staleness banner when present. */
    function dismissBanner() {
      if (typeof document === "undefined") return;
      const existing = document.getElementById(BANNER_ID);
      if (existing !== null) existing.remove();
    }

    /**
     * Offer a manual rebuild without disturbing the page.
     * @param count - how many Host Sessions are missing locally.
     * @param onRefresh - rebuild action.
     */
    function showBanner(count, onRefresh) {
      if (typeof document === "undefined" || document.body === null) return;
      dismissBanner();
      const bar = document.createElement("div");
      bar.id = BANNER_ID;
      bar.setAttribute("role", "status");
      bar.style.cssText = [
        "position:fixed",
        "right:16px",
        "bottom:16px",
        "z-index:2147483647",
        "display:flex",
        "align-items:center",
        "gap:10px",
        "max-width:min(420px,calc(100vw - 32px))",
        "padding:10px 12px",
        "border-radius:10px",
        "border:1px solid rgba(127,127,127,0.35)",
        "background:rgba(28,28,30,0.94)",
        "color:#f2f2f7",
        "font:13px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif",
        "box-shadow:0 6px 24px rgba(0,0,0,0.35)",
      ].join(";");
      const label = document.createElement("span");
      label.textContent = count + " 条会话未同步到本页（来自其他设备）";
      label.style.flex = "1 1 auto";
      const refresh = document.createElement("button");
      refresh.type = "button";
      refresh.textContent = "刷新";
      refresh.style.cssText = "flex:0 0 auto;padding:4px 10px;border-radius:6px;border:1px solid rgba(127,127,127,0.45);background:transparent;color:inherit;font:inherit;cursor:pointer";
      refresh.addEventListener("click", () => {
        dismissBanner();
        onRefresh();
      });
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "×";
      close.setAttribute("aria-label", "关闭提示");
      close.style.cssText = "flex:0 0 auto;padding:0 4px;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;opacity:0.75";
      close.addEventListener("click", dismissBanner);
      bar.append(label, refresh, close);
      document.body.appendChild(bar);
    }

    /**
     * Services this client half must reach. The runner's guard facade only
     * opens declared services (an undeclared function plugin reaches none),
     * so the declaration below is load-bearing, not documentation.
     */
    const inject = ["sessions", "remote", "remote.session"];

    /**
     * Install the reconnect + list-repair behavior.
     * @param ctx - Client Cordis context.
     */
    function apply(ctx) {
      let lastClickAt = 0;
      let lastCheckAt = 0;
      let autoReloadBlocked = false;
      let checkTimer = null;

      /** Recover a terminal disconnected connection through the official banner. */
      const tryReconnect = () => {
        if (typeof document === "undefined" || document.visibilityState !== "visible") return;
        const button = document.querySelector(BUTTON_SELECTOR);
        if (button === null) return;
        const now = Date.now();
        if (now - lastClickAt < CLICK_GAP_MS) return;
        lastClickAt = now;
        try { console.info("[kita-reconnect-on-visible] disconnected banner present after visibility change; clicking reconnect"); } catch { /* console unavailable */ }
        button.click();
      };

      /** @returns the injected sessions face when present. */
      const sessionService = () => {
        try { return ctx.sessions ?? ctx.get("sessions"); } catch { return undefined; }
      };

      /** @returns the Remote projection when present. */
      const remoteService = () => {
        try { return ctx.remote ?? ctx.get("remote"); } catch { return undefined; }
      };

      /**
       * Compare the Host list with this client's list.
       * @returns a status plus the missing ids when the lists disagree.
       */
      /** Describe which service link is unavailable (kept on every outcome). */
      const probe = () => {
        const sessions = sessionService();
        const remote = remoteService();
        const list = sessions === undefined || sessions === null ? undefined : sessions.list;
        const endpoint = remote === undefined || remote === null ? undefined : remote.session;
        return {
          sessions: sessions === undefined || sessions === null ? "missing" : "present",
          sessionsList: list === undefined || list === null ? "missing" : typeof list.getSnapshot === "function" ? "readable" : "unreadable",
          remote: remote === undefined || remote === null ? "missing" : "present",
          remoteSession: endpoint === undefined || endpoint === null ? "missing" : "present",
          remoteSessionList: endpoint === undefined || endpoint === null ? "missing" : typeof endpoint.list === "function" ? "callable" : "unreadable",
        };
      };

      /**
       * Compare the Host list with this client's list.
       * @returns a status (plus the missing ids when the lists disagree) and a probe.
       */
      const inspectList = async () => {
        const detail = probe();
        const sessions = sessionService();
        if (sessions === undefined || sessions === null) return { status: "unavailable", detail };
        const list = sessions.list;
        if (list === undefined || list === null || typeof list.getSnapshot !== "function") return { status: "unavailable", detail };
        const local = list.getSnapshot();
        if (local === null || typeof local !== "object" || local.phase !== "ready") return { status: "not-ready", detail };
        const remote = remoteService();
        const endpoint = remote === undefined || remote === null ? undefined : remote.session;
        if (endpoint === undefined || endpoint === null || typeof endpoint.list !== "function") return { status: "unavailable", detail };
        const result = await endpoint.list({});
        if (result === null || typeof result !== "object" || result.ok !== true) return { status: "list-failed", detail };
        const missing = sessionMissing(result.value?.items, local);
        if (missing === null) return { status: "unavailable", detail };
        if (missing.length === 0) return { status: "clean", missing, detail };
        return { status: "stale", missing, detail };
      };

      /**
       * Verify once and either rebuild, offer a banner, or do nothing.
       * @param auto - whether a reload is permitted for this verification.
       * @returns the inspection outcome, or null when throttled.
       */
      const runCheck = async (auto) => {
        const now = Date.now();
        if (now - lastCheckAt < CHECK_GAP_MS) return null;
        lastCheckAt = now;
        let outcome;
        try { outcome = await inspectList(); } catch { return null; }
        if (outcome.status !== "stale") return outcome;
        const signature = missingSignature(outcome.missing);
        const blocked = autoReloadBlocked || !autoReloadEnabled();
        if (auto && !blocked && !composerHasDraft() && reloadAllowed(signature, Date.now())) {
          writeReloadGuard({ signature, at: Date.now() });
          try { console.warn("[kita-reconnect-on-visible] Host Sessions absent from this client; reloading to rebuild the list", outcome.missing); } catch { /* console unavailable */ }
          location.reload();
          return outcome;
        }
        showBanner(outcome.missing.length, () => location.reload());
        return outcome;
      };

      /** Visible again: recover a dead connection, then verify the list. */
      const onVisibility = () => {
        if (typeof document === "undefined" || document.visibilityState !== "visible") return;
        tryReconnect();
        if (checkTimer !== null) clearTimeout(checkTimer);
        // Give the re-established connection a moment to publish its baseline.
        checkTimer = setTimeout(() => {
          checkTimer = null;
          void runCheck(true);
        }, 1200);
      };

      ctx.effect(() => {
        document.addEventListener("visibilitychange", onVisibility);
        const poll = setInterval(() => {
          if (typeof document === "undefined" || document.visibilityState !== "visible") return;
          void runCheck(false);
        }, POLL_MS);
        // Mount-time safety net: the tab may unfreeze after the terminal
        // disconnected state was published, or restore from BFCache.
        tryReconnect();
        const mount = setTimeout(() => { void runCheck(false); }, 3000);
        return () => {
          document.removeEventListener("visibilitychange", onVisibility);
          clearInterval(poll);
          clearTimeout(mount);
          if (checkTimer !== null) clearTimeout(checkTimer);
          dismissBanner();
        };
      }, "kita-reconnect-on-visible.client");

      try {
        globalThis[DEBUG_KEY] = {
          tryReconnect,
          runCheck,
          inspectList,
          disableAutoReload: () => { autoReloadBlocked = true; },
          enableAutoReload: () => { autoReloadBlocked = false; },
        };
      } catch { /* non-browser env */ }
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__test = { sessionMissing, missingSignature, reloadAllowed, composerHasDraft, autoReloadEnabled };
    return module.exports;
  }
});
