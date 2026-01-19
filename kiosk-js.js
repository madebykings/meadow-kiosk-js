<script>
(() => {
  "use strict";

  /* ----------------------------
     VERSION BANNER (helps confirm you're running the latest)
  ---------------------------- */
  console.log("[Meadow] SCRIPT_VERSION 2026-01-16 full_dropin_paid_guard+cta_stock_fix");

  /* ----------------------------
     CONFIG
  ---------------------------- */
  const API_BASE = "/wp-json/meadow/v1";

  // ✅ Adaptive polling (#3)
  const POLL_MS = {
    ads: 5000,
    browse: 3500,
    payment: 1500,
    finalising: 1500,
    vending: 2500,
    thankyou: 3000,
    error: 2500,
    payment_failed: 2500,
    default: 3000
  };

  const QS = new URLSearchParams(window.location.search);
  const KIOSK_ID = Number(window.MEADOW_KIOSK_ID || QS.get("kiosk_id") || 0);
  const API_KEY  = String(window.MEADOW_API_KEY || "");

  const DEBUG = (QS.get("debug") === "1") || !!window.MEADOW_DEBUG;

  /* ----------------------------
     DEBUG
  ---------------------------- */
  function dbg(...args) { if (DEBUG) console.log("[Meadow]", ...args); }
  function dbgWarn(...args) { if (DEBUG) console.warn("[Meadow]", ...args); }
  function ms(since) { return Math.round(performance.now() - since); }

  /* ----------------------------
     PI BASE (Cloudflare tunnel only)
  ---------------------------- */
  // IMPORTANT: browser UI is HTTPS; do NOT call http://127.0.0.1 from here.
  // Always use your per-kiosk Cloudflare Tunnel hostname.
  const PI_BASE = String(window.MEADOW_PI_BASE || "https://kiosk1-pi.meadowvending.com");
  dbg("PI_BASE", PI_BASE);

  function startHeartbeat() {
    // Best-effort; never block UX on heartbeat failures.
    setInterval(() => {
      fetch(`${PI_BASE}/heartbeat`, { method: "POST", cache: "no-store" }).catch(() => {});
    }, 5000);
  }

  /* ----------------------------
     SECTION IDS + DEFAULTS
  ---------------------------- */
  const SECTION_IDS = {
    ads:            "kiosk-ads",
    browse:         "kiosk-browse",
    payment:        "kiosk-payment",
    finalising:     "kiosk-finalising",
    vending:        "kiosk-vending",
    thankyou:       "kiosk-thankyou",
    error:          "kiosk-error",
    payment_failed: "kiosk-payment-failed"
    // NOTE: no "paid" section; if we see serverMode="paid" we’ll map it (see poll)
  };

  const DEFAULTS = {
    idle_timeout: 20,
    thankyou_timeout: 8,
    error_timeout: 8,
    payment_failed_timeout: 6,

    browse_return_mode: "ads",
    thankyou_return_mode: "ads",

    error_return_mode: "browse",
    payment_failed_return_mode: "browse",
  };

  /* ----------------------------
     SIGMA WARMUP (browse screen)
  ---------------------------- */
  // Calls PI /sigma/warm in the background to let Sigma clear STATUS=20 etc.
  // Safe because the Pi side uses a SIGMA_LOCK so warm never overlaps purchase.
  const SIGMA_WARM = {
    enabled: true,
    min_interval_ms: 60_000,     // at most once per minute
    delay_after_browse_ms: 400,  // let UI paint first
    request_timeout_ms: 7000     // don't hang forever if tunnel is slow
  };

  let lastSigmaWarmAt = 0;
  let sigmaWarmInFlight = false;

  function abortableFetch(url, opts = {}, timeoutMs = 0) {
    const t = Number(timeoutMs || 0);
    if (!t || !("AbortController" in window)) return fetch(url, opts);

    const ac = new AbortController();
    const id = setTimeout(() => ac.abort(), t);
    return fetch(url, { ...opts, signal: ac.signal })
      .finally(() => clearTimeout(id));
  }

  // ✅ supports {force:true} and bypasses buyFlowStarted/throttle when forced
  async function piSigmaWarm(reason = "", opts = {}) {
    const force = !!(opts && opts.force);

    if (!SIGMA_WARM.enabled) return;
    if (!PI_BASE) return;

    // Only block during buy flow if not forced
    if (buyFlowStarted && !force) return;

    // Don't pile on, unless forced
    if (sigmaWarmInFlight && !force) return;

    const now = Date.now();
    if (!force && (now - lastSigmaWarmAt < SIGMA_WARM.min_interval_ms)) return;

    sigmaWarmInFlight = true;
    lastSigmaWarmAt = now;

    const t0 = performance.now();
    dbg("SIGMA_WARM: start", { reason, force });

    try {
      const res = await abortableFetch(`${PI_BASE}/sigma/warm`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      }, SIGMA_WARM.request_timeout_ms);

      let payload = null;
      try { payload = await res.json(); } catch { payload = null; }

      dbg("SIGMA_WARM: done", {
        ms: Math.round(performance.now() - t0),
        ok: !!res.ok,
        status: res.status,
        payload
      });
    } catch (e) {
      dbgWarn("SIGMA_WARM: fail", { ms: Math.round(performance.now() - t0), msg: e?.message || String(e) });
    } finally {
      sigmaWarmInFlight = false;
    }
  }

  /* ----------------------------
     STATE
  ---------------------------- */
  let SECTIONS = {};
  let currentMode = "ads";
  let screenETag = "";
  let buyFlowStarted = false;

  let selectedMotor = Number(sessionStorage.getItem("MEADOW_SELECTED_MOTOR") || 0);

  let idleTimer = null;
  let idleArmed = false;
  let idleFireAtMs = 0;
  let idleReturnMode = "ads";

  let lastIdleTimeout = null;
  let lastThankyouTimeout = null;
  let lastServerMode = null;
  let serverOrderId = 0;

  let switching = false;

  let uiLockUntilMs = 0;

  let lastIdleResetAt = 0;
  const IDLE_RESET_MIN_MS = 1200;

  let suppressPollUntilMs = 0;
  let pollTimer = null;

  function suppressPoll(msVal, reason="") {
    suppressPollUntilMs = Date.now() + Number(msVal || 0);
    dbg("suppressPoll", { ms: msVal, reason, untilISO: new Date(suppressPollUntilMs).toISOString() });
  }
  function pollSuppressed() { return Date.now() < suppressPollUntilMs; }

  function lockUI(msVal, reason = "") {
    uiLockUntilMs = Date.now() + Number(msVal || 0);
    dbg("UI LOCK", { ms: msVal, reason, untilISO: new Date(uiLockUntilMs).toISOString() });
  }
  function unlockUI(reason = "") {
    if (uiLockUntilMs) dbg("UI UNLOCK", { reason });
    uiLockUntilMs = 0;
  }
  function uiLocked() { return Date.now() < uiLockUntilMs; }

  /* ----------------------------
     FETCH
  ---------------------------- */
  async function fetchJSON(url, opts = {}) {
    const t0 = performance.now();
    const res = await fetch(url, opts);

    if (res.status === 304) {
      return { __not_modified: true, __etag: (res.headers.get("ETag") || "") };
    }

    const ct = (res.headers.get("content-type") || "").toLowerCase();

    let data = null;
    if (ct.includes("application/json")) data = await res.json();
    else {
      const text = await res.text();
      try { data = JSON.parse(text); } catch { data = { raw_text: text }; }
    }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      err.ms = Math.round(performance.now() - t0);
      throw err;
    }

    if (ct.includes("application/json") && data && typeof data === "object") {
      const et = res.headers.get("ETag");
      if (et) data.__etag = et;
    }

    dbg("fetch OK", { url, ms: Math.round(performance.now() - t0) });
    return data;
  }

  async function fetchPiJSON(path, opts = {}) {
    return await fetchJSON(`${PI_BASE}${path}`, opts);
  }

  /* ----------------------------
     UI (fade via .is-active)
  ---------------------------- */
  function buildSections() {
    SECTIONS = {};
    Object.keys(SECTION_IDS).forEach((mode) => {
      SECTIONS[mode] = document.getElementById(SECTION_IDS[mode]) || null;
    });
  }

  function showSection(mode) {
    if (mode === currentMode) return;

    const from = currentMode;
    const to = mode;

    const toEl = SECTIONS[to];

    if (!toEl) {
      console.error("[Meadow] Missing section element:", to);
      return;
    }

    dbg("SHOW", { from, to });

    switching = true;

    // IMPORTANT: activate target FIRST
    toEl.classList.add("is-active");

    // then remove others
    Object.entries(SECTIONS).forEach(([m, el]) => {
      if (!el) return;
      if (m !== to) el.classList.remove("is-active");
    });

    setTimeout(() => { switching = false; }, 400);

    currentMode = to;
    window.MEADOW_MODE = currentMode;

    if (to === "browse") {
      setTimeout(() => { piSigmaWarm("entered_browse").catch(() => {}); }, SIGMA_WARM.delay_after_browse_ms);
    }

    schedulePoll(0, "mode_change");
  }

  /* ----------------------------
     ADS PLAYER
  ---------------------------- */
  const AdPlayer = (() => {
    let stage = null;
    let playlist = [];
    let idx = 0;
    let playTimer = null;
    let flushTimer = null;
    let refreshTimer = null;
    let running = false;

    const imp = new Map();

    function ensureStage() {
      if (!stage) stage = document.getElementById("meadow-ad-stage");
      return !!stage;
    }

    function clearTimers() {
      if (playTimer) clearTimeout(playTimer);
      playTimer = null;
      if (flushTimer) clearInterval(flushTimer);
      flushTimer = null;
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = null;
    }

    function showFallback() {
      if (!stage) return;
      stage.innerHTML = `
        <div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;
                    font-size:28px;font-weight:700;">
          Tap to start
        </div>`;
    }

    async function loadPlaylist({ preserveIndex = true } = {}) {
      if (!KIOSK_ID) throw new Error("missing kiosk_id");
      const data = await fetchJSON(`${API_BASE}/kiosk-ads?kiosk_id=${encodeURIComponent(KIOSK_ID)}`, {
        method: "GET",
        cache: "no-store"
      });

      const next = Array.isArray(data.ads) ? data.ads : [];

      if (!preserveIndex) idx = 0;

      playlist = next;
      if (playlist.length) idx = idx % playlist.length;

      dbg("ads playlist loaded", { count: playlist.length, preserveIndex, idx });
    }

    function inc(ad_id) {
      const n = imp.get(ad_id) || 0;
      imp.set(ad_id, n + 1);
    }

    async function flush() {
      if (!imp.size) return;
      if (!KIOSK_ID || !API_KEY) return;

      const items = Array.from(imp.entries()).map(([ad_id, n]) => ({ ad_id, n }));
      imp.clear();

      try {
        await fetchJSON(`${API_BASE}/ad-impression`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kiosk_id: KIOSK_ID, key: API_KEY, items })
        });
        dbg("ads impressions flushed", { items });
      } catch (e) {
        dbgWarn("ads impressions flush failed", { msg: e?.message || String(e) });
      }
    }

    function render(ad) {
      if (!stage) return;
      stage.innerHTML = "";

      if (ad.type === "image") {
        const img = document.createElement("img");
        img.src = ad.url;
        img.alt = "";
        img.style.width = "100%";
        img.style.height = "100%";
        img.style.objectFit = "cover";
        img.style.display = "block";
        stage.appendChild(img);
      } else if (ad.type === "video") {
        const v = document.createElement("video");
        v.src = ad.url;
        v.muted = true;
        v.playsInline = true;
        v.autoplay = true;
        v.loop = false;
        v.preload = "auto";
        v.style.width = "100%";
        v.style.height = "100%";
        v.style.objectFit = "cover";
        v.style.display = "block";
        stage.appendChild(v);
      }
    }

    function step() {
      if (!running) return;

      if (!playlist.length) {
        showFallback();
        return;
      }

      const ad = playlist[idx % playlist.length];
      idx++;

      render(ad);
      if (ad && ad.ad_id) inc(ad.ad_id);

      const dur = Number(ad.duration || 8);
      playTimer = setTimeout(step, Math.max(1, dur) * 1000);
    }

    async function start() {
      if (running) return;
      running = true;

      if (!ensureStage()) {
        dbg("ads stage missing (#meadow-ad-stage) — slideshow disabled");
        return;
      }

      clearTimers();
      stage.innerHTML = "";

      try {
        await loadPlaylist({ preserveIndex: false });
        if (!playlist.length) {
          showFallback();
          return;
        }
        step();
        flushTimer = setInterval(flush, 30000);
        refreshTimer = setInterval(refresh, 60000);
      } catch (e) {
        dbgWarn("ads start failed", { msg: e?.message || String(e) });
        showFallback();
      }
    }

    async function stop() {
      if (!running) return;
      running = false;
      clearTimers();
      await flush();
    }

    async function refresh() {
      try { await loadPlaylist({ preserveIndex: true }); } catch (e) {
        dbgWarn("ads refresh failed", { msg: e?.message || String(e) });
      }
    }

    return { start, stop, refresh };
  })();

  /* ----------------------------
     IDLE
  ---------------------------- */
  function clearIdle(reason = "") {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    idleArmed = false;
    idleFireAtMs = 0;
    idleReturnMode = "ads";
    if (reason) dbg("idle disarmed", { reason, from: currentMode });
  }

  function armIdleOnce(seconds, returnMode = "ads", reason = "") {
    const t = Number(seconds || 0);
    if (!t || t <= 0) {
      dbg("idle NOT armed", { currentMode, t, returnMode, reason });
      return;
    }
    if (idleArmed) return;

    idleArmed = true;
    idleReturnMode = returnMode;
    idleFireAtMs = Date.now() + (t * 1000);

    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      idleArmed = false;
      dbg("idle FIRED", { from: currentMode, to: returnMode, reason });
      await setMode(returnMode, 0, { source: "idle", syncWP: true });
    }, t * 1000);

    dbg("idle armed", {
      from: currentMode, t, returnMode, reason,
      fireAtISO: new Date(idleFireAtMs).toISOString()
    });
  }

  function resetIdle(seconds, returnMode, reason) {
    clearIdle("reset:" + reason);
    armIdleOnce(seconds, returnMode, reason);
  }

  function effectiveIdleTimeout() {
    return (lastIdleTimeout === null ? DEFAULTS.idle_timeout : lastIdleTimeout);
  }
  function effectiveThankyouTimeout() {
    return (lastThankyouTimeout === null ? DEFAULTS.thankyou_timeout : lastThankyouTimeout);
  }

  /* ----------------------------
     MOTOR HELPERS
  ---------------------------- */
  function rememberMotor(motor, reason="") {
    const m = Number(motor || 0);
    if (!m) return;
    selectedMotor = m;
    sessionStorage.setItem("MEADOW_SELECTED_MOTOR", String(m));
    dbg("motor remembered", { motor: m, reason });
  }

  function clearRememberedMotor(reason="") {
    dbg("motor cleared", { reason, prev: selectedMotor });
    selectedMotor = 0;
    sessionStorage.removeItem("MEADOW_SELECTED_MOTOR");
  }

  function bestMotor() {
    const urlMotor = Number(new URLSearchParams(window.location.search).get("motor") || 0);
    return Number(urlMotor || selectedMotor || 0);
  }

  /* ----------------------------
     DISABLE CTA IF STOCK=0
  ---------------------------- */
  (function () {
    const DISABLED_CLASS = "meadow-cta-disabled";

    function parseMotorFromHref(href) {
      try {
        const url = new URL(href, window.location.href);
        const m = url.searchParams.get("motor");
        return m ? String(Number(m)) : null;
      } catch {
        return null;
      }
    }

    function disableCTA(a, reason = "Out of stock") {
      if (!a.dataset.meadowHref) a.dataset.meadowHref = a.getAttribute("href") || "";
      a.setAttribute("href", "#");
      a.setAttribute("aria-disabled", "true");
      a.setAttribute("tabindex", "-1");
      a.classList.add(DISABLED_CLASS);
      a.title = reason;
    }

    function enableCTA(a) {
      if (a.dataset.meadowHref) a.setAttribute("href", a.dataset.meadowHref);
      a.removeAttribute("aria-disabled");
      a.removeAttribute("tabindex");
      a.classList.remove(DISABLED_CLASS);
      a.removeAttribute("title");
    }

    window.MeadowApplyStockToCTAs = function (state) {
      const stockByMotor = state?.stock_by_motor || state?.state?.stock_by_motor;
      if (!stockByMotor) return;

      // ✅ FIX: selector should not rely on "elementor-cta" class if your theme uses different CTA class names.
      // Keep your original, but also include any <a> that has motor/action=buy in href.
      const ctas = Array.from(document.querySelectorAll(
        'a[href*="action=buy"][href*="motor="], a[data-meadow-href][data-meadow-href*="motor="]'
      ));

      ctas.forEach(a => {
        const href = a.getAttribute("href") || a.dataset.meadowHref || "";
        const motorKey = parseMotorFromHref(href);
        if (!motorKey) return;

        const stock = Number(stockByMotor[motorKey] ?? 0);
        if (stock <= 0) disableCTA(a);
        else enableCTA(a);
      });
    };

    document.addEventListener("click", (e) => {
      const a = e.target.closest("a." + DISABLED_CLASS);
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
    }, true);

    const css = `
      a.${DISABLED_CLASS} {
        pointer-events: none !important;
        opacity: 0.35 !important;
        filter: grayscale(100%) !important;
        cursor: not-allowed !important;
      }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  })();

  /* ----------------------------
     WP MODE UPDATE
  ---------------------------- */
  async function updateScreenMode(mode, order_id = 0) {
    if (!KIOSK_ID || !API_KEY) {
      dbgWarn("updateScreenMode skipped (missing kiosk_id/api_key)", { KIOSK_ID, hasKey: !!API_KEY });
      return;
    }
    const payload = { kiosk_id: KIOSK_ID, mode: String(mode), order_id: Number(order_id || 0), key: API_KEY };
    dbg("updateScreenMode ->", payload);

    try {
      await fetchJSON(`${API_BASE}/kiosk-screen`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      dbg("updateScreenMode OK", { mode });
    } catch (err) {
      dbgWarn("updateScreenMode FAIL", { mode, status: err?.status, data: err?.data });
    }
  }

  /* ----------------------------
     RESET ACTION
  ---------------------------- */
  async function resetToBrowse(reason = "manual_reset") {
    dbgWarn("RESET -> browse", { reason, from: currentMode });

    buyFlowStarted = false;
    unlockUI("resetToBrowse");
    clearIdle("resetToBrowse");
    clearRememberedMotor("resetToBrowse");

    suppressPoll(1200, `resetToBrowse(${reason})`);
    await setMode("browse", 0, { source: "resetToBrowse:" + reason, syncWP: true });
  }

  /* ----------------------------
     ADAPTIVE POLL LOOP
  ---------------------------- */
  function getPollIntervalMs(mode) {
    return Number(POLL_MS[String(mode || "").toLowerCase()] || POLL_MS.default || 3000);
  }

  function schedulePoll(delayMs = null, reason = "") {
    if (pollTimer) clearTimeout(pollTimer);
    const msDelay = (delayMs === null) ? getPollIntervalMs(currentMode) : Number(delayMs);
    pollTimer = setTimeout(async () => {
      await pollScreenState();
      schedulePoll(null, "loop");
    }, Math.max(250, msDelay));
    if (DEBUG) dbg("poll scheduled", { ms: msDelay, mode: currentMode, reason });
  }

  /* ----------------------------
     POLL
  ---------------------------- */
  async function pollScreenState() {
    if (!KIOSK_ID) return;

    if (buyFlowStarted && !["payment", "finalising"].includes(currentMode)) {
      dbg("poll ignored (buyFlowStarted)", { currentMode });
      return;
    }
    if (uiLocked()) { dbg("poll ignored (uiLocked)"); return; }
    if (pollSuppressed()) { dbg("poll ignored (suppressed)"); return; }
    if (["vending"].includes(currentMode)) { dbg("poll suppressed (critical)", { currentMode }); return; }

    try {
      const headers = {};

// IMPORTANT: while browsing, we want fresh stock updates; don't allow 304 short-circuit.
if (currentMode !== "browse" && screenETag) {
  headers["If-None-Match"] = screenETag;
} else if (currentMode === "browse") {
  // Clear it so we don't re-enable 304 on the next tick
  screenETag = "";
}

      const data = await fetchJSON(`${API_BASE}/kiosk-screen?kiosk_id=${encodeURIComponent(KIOSK_ID)}`, {
        method: "GET",
        cache: "no-store",
        headers
      });

      if (data && data.__not_modified) return;

      if (data && data.__etag) screenETag = String(data.__etag);

      let mode = String(data.mode || "ads").toLowerCase();

      // ✅ SAFETY: if server ever returns "paid", map to "vending" to keep UI sane.
      if (mode === "paid") mode = "vending";

      lastServerMode = mode;

      lastIdleTimeout = (data.idle_timeout !== undefined && data.idle_timeout !== null)
        ? Number(data.idle_timeout)
        : null;

      lastThankyouTimeout = (data.thankyou_timeout !== undefined && data.thankyou_timeout !== null)
        ? Number(data.thankyou_timeout)
        : null;

      serverOrderId = Number(data.order_id || 0);

      dbg("poll", { serverMode: mode, currentMode, idle_timeout: lastIdleTimeout, thankyou_timeout: lastThankyouTimeout, order_id: serverOrderId, selectedMotor });

      // ✅ apply stock->CTA disable
      try { window.MeadowApplyStockToCTAs?.(data); } catch {}

      if (mode !== currentMode) {
        showSection(mode);
        clearIdle("mode_change:" + mode);
        if (mode === "ads") AdPlayer.start(); else AdPlayer.stop();
      }

      if (mode === "payment" && !buyFlowStarted) {
        const motorToUse = bestMotor();
        if (motorToUse > 0) runBuyFlow(motorToUse);
      }

      if (mode === "browse") armIdleOnce(effectiveIdleTimeout(), DEFAULTS.browse_return_mode, "poll(browse)");
      else if (mode === "thankyou") armIdleOnce(effectiveThankyouTimeout(), DEFAULTS.thankyou_return_mode, "poll(thankyou)");
      else if (mode === "error") armIdleOnce(DEFAULTS.error_timeout, DEFAULTS.error_return_mode, "poll(error)");
      else if (mode === "payment_failed") armIdleOnce(DEFAULTS.payment_failed_timeout, DEFAULTS.payment_failed_return_mode, "poll(payment_failed)");
      else if (mode === "ads") clearIdle("poll(ads)");
      else clearIdle("poll(non_idle)");

    } catch (err) {
      dbgWarn("poll error", { status: err?.status, data: err?.data, ms: err?.ms });
    }
  }

  /* ----------------------------
     MODE SETTER
  ---------------------------- */
  async function setMode(mode, order_id = 0, { source = "local", syncWP = true } = {}) {
    dbg("setMode", { mode, order_id, source, syncWP });

    if (syncWP) suppressPoll(1200, `setMode(${mode})`);

    const prev = currentMode;
    showSection(mode);

    if (mode === "ads") AdPlayer.start(); else AdPlayer.stop();

    if (syncWP) updateScreenMode(mode, order_id);

    if (prev !== mode) clearIdle("setMode_change:" + mode);

    if (mode === "browse") armIdleOnce(effectiveIdleTimeout(), DEFAULTS.browse_return_mode, "setMode(browse)");
    else if (mode === "thankyou") armIdleOnce(effectiveThankyouTimeout(), DEFAULTS.thankyou_return_mode, "setMode(thankyou)");
    else if (mode === "error") armIdleOnce(DEFAULTS.error_timeout, DEFAULTS.error_return_mode, "setMode(error)");
    else if (mode === "payment_failed") armIdleOnce(DEFAULTS.payment_failed_timeout, DEFAULTS.payment_failed_return_mode, "setMode(payment_failed)");
    else if (mode === "ads") clearIdle("setMode(ads)");
    else clearIdle("setMode(non_idle)");
  }

  /* ----------------------------
     PI CALLS
  ---------------------------- */
  async function piSigmaPurchase({ amount_minor, currency_num, reference }) {
    // ✅ Abortable purchase so the UI never hangs forever on tunnel issues.
    const res = await abortableFetch(`${PI_BASE}/sigma/purchase`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount_minor: Number(amount_minor),
        currency_num: String(currency_num),
        reference: String(reference)
      })
    }, 220000); // 220s max

    let data = null;
    try { data = await res.json(); } catch { data = null; }

    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function piVend({ motor }) {
    return await fetchPiJSON(`/vend`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ motor: Number(motor) })
    });
  }

  /* ----------------------------
     BUY FLOW
  ---------------------------- */
  async function runBuyFlow(motorToUse) {
    if (buyFlowStarted) return;
    buyFlowStarted = true;

    const motor = Number(motorToUse || 0);
    if (!KIOSK_ID || !motor) {
      await setMode("error", 0, { source: "buyFlow(missing_params)", syncWP: false });
      buyFlowStarted = false;
      return;
    }
    if (!API_KEY) {
      await setMode("error", 0, { source: "buyFlow(missing_key)", syncWP: false });
      buyFlowStarted = false;
      return;
    }

    rememberMotor(motor, "runBuyFlow(start)");

    let session_id = "";
    let order_id = 0;

    const tClick = performance.now();
    dbg("TIMING: buyFlow start", { motor, kiosk: KIOSK_ID });

    try {
      lockUI(12000, "buyFlow(start->payment)");
      await setMode("payment", 0, { source: "buyFlow(start)", syncWP: true });
      dbg("TIMING: after setMode(payment)", { ms: ms(tClick) });

      const tSP = performance.now();
      const startData = await fetchJSON(`${API_BASE}/start-payment`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body: new URLSearchParams({
          kiosk_id: String(KIOSK_ID),
          motor: String(motor),
          key: String(API_KEY),
        }).toString()
      });
      dbg("TIMING: start-payment returned", { ms: ms(tSP), total_ms: ms(tClick) });

      unlockUI("start-payment OK");

      session_id = String(startData.session_id || "");
      order_id   = Number(startData.order_id || 0);
      if (!session_id) throw new Error("start-payment returned no session_id");

      const amount_minor = Number(startData.amount_minor);
      const currency_num = String(startData.currency_num || "826");
      const reference    = String(startData.reference || "");

      // ---- TIMING: Sigma purchase ----
      dbg("TIMING: before piSigmaPurchase", { amount_minor, currency_num, reference });

      const wait2 = setTimeout(() => dbg("TIMING: still waiting for piSigmaPurchase (2s)"), 2000);
      const wait5 = setTimeout(() => dbg("TIMING: still waiting for piSigmaPurchase (5s)"), 5000);
      const wait7 = setTimeout(() => dbg("TIMING: still waiting for piSigmaPurchase (7s)"), 7000);

      const tPi = performance.now();
      let pay;
      try {
        pay = await piSigmaPurchase({ amount_minor, currency_num, reference });
      } finally {
        clearTimeout(wait2);
        clearTimeout(wait5);
        clearTimeout(wait7);
      }

      dbg("TIMING: piSigmaPurchase returned", {
        ms: Math.round(performance.now() - tPi),
        approved: !!pay?.approved,
        status: String(pay?.status || ""),
        stage: String(pay?.stage || "")
      });
      // ---- /TIMING ----

      // report payment result to WP (non-blocking)
      fetchJSON(`${API_BASE}/payment-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kiosk_id: KIOSK_ID,
          key: API_KEY,
          session_id,
          approved: !!pay.approved,
          status: String(pay.status || ""),
          stage: String(pay.stage || ""),
          raw: pay.raw || pay,
          receipt: pay.receipt || "",
          txid: String(pay.txid || "")
        })
      }).catch(() => {});

      if (!pay.approved) {
        await setMode("payment_failed", order_id, { source: "buyFlow(declined)", syncWP: true });
        resetIdle(DEFAULTS.payment_failed_timeout, "browse", "buyFlow(payment_failed_return)");
        buyFlowStarted = false;
        return;
      }

      await setMode("vending", order_id, { source: "buyFlow(vend)", syncWP: true });

      const vend = await piVend({ motor });

      // report vend result to WP (non-blocking)
      fetchJSON(`${API_BASE}/vend-result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kiosk_id: KIOSK_ID,
          key: API_KEY,
          session_id,
          success: !!vend.success,
          error: String(vend.error || ""),
          details: vend || {}
        })
      }).catch(() => {});

      if (!vend.success) {
        await setMode("error", order_id, { source: "buyFlow(vend_failed)", syncWP: true });
        resetIdle(DEFAULTS.error_timeout, "browse", "buyFlow(error_return)");
        buyFlowStarted = false;
        return;
      }

      setTimeout(async () => {
        await setMode("thankyou", order_id, { source: "buyFlow(thankyou)", syncWP: true });
        resetIdle(effectiveThankyouTimeout(), "ads", "buyFlow(thankyou_return)");
        buyFlowStarted = false;
        clearRememberedMotor("success");
      }, 2500);

    } catch (err) {
      unlockUI("buyFlow exception");
      dbgWarn("Buy flow error", { msg: String(err?.message || err), status: err?.status, data: err?.data });
      await setMode("error", order_id, { source: "buyFlow(exception)", syncWP: true });
      resetIdle(DEFAULTS.error_timeout, "browse", "buyFlow(exception_return)");
      buyFlowStarted = false;
    }
  }

  /* ----------------------------
     CLICK + IDLE RESET HANDLERS
  ---------------------------- */
  function enableHandlers() {
    const ads = SECTIONS.ads;
    if (ads) {
      ads.addEventListener("click", async () => {
        await setMode("browse", 0, { source: "touch(ads)", syncWP: true });
      }, { passive: true });
    }

    const buyAnotherBtn = document.getElementById("btn-buy-another");
    if (buyAnotherBtn) {
      buyAnotherBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await resetToBrowse("btn-buy-another");
      });
    }

    const tryAgainBtn = document.getElementById("btn-try-again");
    if (tryAgainBtn) {
      tryAgainBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await resetToBrowse("btn-try-again");
      });
    }

    document.addEventListener("click", (e) => {
      const a = e.target.closest('a[href*="action=buy"][href*="motor="], a[data-meadow-href*="action=buy"][data-meadow-href*="motor="]');
      if (!a) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      e.preventDefault();

      const href = a.getAttribute("href") || a.dataset.meadowHref || "";
      const url = new URL(href, window.location.origin);
      const motor = Number(url.searchParams.get("motor") || 0);
      if (!motor) return;

      rememberMotor(motor, "click(product)");

      const nqs = new URLSearchParams(location.search);
      if (KIOSK_ID) nqs.set("kiosk_id", String(KIOSK_ID));
      if (DEBUG) nqs.set("debug", "1");
      history.replaceState({}, document.title, `${location.pathname}?${nqs.toString()}`);

      runBuyFlow(motor);
    }, { passive: false });

    const activityEvents = ["pointerdown","touchstart","click","keydown"];
    activityEvents.forEach((evt) => {
      window.addEventListener(evt, () => {
        if (buyFlowStarted) return;
        if (switching) return;

        const now = Date.now();
        if (now - lastIdleResetAt < IDLE_RESET_MIN_MS) return;
        lastIdleResetAt = now;

        if (["browse","error","payment_failed","thankyou"].includes(currentMode)) {
          const t =
            (currentMode === "thankyou") ? effectiveThankyouTimeout()
            : (currentMode === "payment_failed") ? DEFAULTS.payment_failed_timeout
            : (currentMode === "error") ? DEFAULTS.error_timeout
            : effectiveIdleTimeout();

          const returnMode =
            (currentMode === "thankyou") ? DEFAULTS.thankyou_return_mode
            : (currentMode === "payment_failed") ? DEFAULTS.payment_failed_return_mode
            : (currentMode === "error") ? DEFAULTS.error_return_mode
            : DEFAULTS.browse_return_mode;

          resetIdle(t, returnMode, "user-activity:" + evt);
        }
      }, { passive: true });
    });
  }

  /* ----------------------------
     SIGMA WARM LOOP (only while on browse)
  ---------------------------- */
  function startSigmaWarmLoop() {
    const intervalMs = SIGMA_WARM.min_interval_ms;
    dbg("SIGMA_WARM: loop started", { interval_ms: intervalMs });

    setInterval(() => {
      // Only warm while idling on browse; never warm during buy flow unless forced.
      if (currentMode !== "browse") return;
      if (buyFlowStarted) return;

      piSigmaWarm("browse_interval").catch(() => {});
    }, intervalMs);
  }

  /* ----------------------------
     INIT
  ---------------------------- */
  document.addEventListener("DOMContentLoaded", () => {
    buildSections();

    if (DEBUG) {
      const missing = Object.entries(SECTION_IDS)
        .filter(([mode, id]) => !document.getElementById(id))
        .map(([mode, id]) => ({ mode, id }));
      if (missing.length) console.warn("[Meadow] Missing section elements:", missing);
    }

    startHeartbeat();
    startSigmaWarmLoop();

    // Force clean boot: make sure at least one section is visible.
    currentMode = "__boot__";
    showSection("ads");

    AdPlayer.start();
    enableHandlers();

    schedulePoll(0, "boot");
  });

})();
</script>
