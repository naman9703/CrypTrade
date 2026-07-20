/**
 * Binance USD-M Futures User Data Stream — push updates for account / positions.
 * @see https://binance-docs.github.io/apidocs/futures/en/#user-data-streams
 *
 * REST `/fapi/v2/account` remains the source of truth on cold start and after reconnect;
 * ACCOUNT_UPDATE events merge into the cached snapshot so callers can skip REST when fresh.
 */

/** @param {unknown} v */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Hedge mode uses LONG/SHORT slots per symbol; one-way uses BOTH. */
function normalizePositionSideKey(ps) {
  const u = String(ps ?? "BOTH").trim().toUpperCase();
  if (u === "LONG" || u === "SHORT") return u;
  return "BOTH";
}

/**
 * Merge Binance ACCOUNT_UPDATE `P` row into REST-shaped position object.
 * @param {Record<string, unknown> | null} prev
 * @param {Record<string, unknown>} upd Binance short keys: s, pa, ep, cr, up, mt, iw, ps
 */
function mergePositionFromAccountUpdate(prev, upd) {
  const sym = String(upd.s || "").toUpperCase();
  const pa = num(upd.pa);
  const base = prev && typeof prev === "object" ? { ...prev } : {};
  return {
    ...base,
    symbol: sym || base.symbol,
    positionAmt: String(upd.pa ?? base.positionAmt ?? "0"),
    entryPrice: String(upd.ep ?? base.entryPrice ?? "0"),
    unrealizedProfit: String(upd.up ?? base.unrealizedProfit ?? "0"),
    accumulatedRealized: String(upd.cr ?? base.accumulatedRealized ?? "0"),
    marginType: String(upd.mt ?? base.marginType ?? ""),
    isolatedWallet: String(upd.iw ?? base.isolatedWallet ?? "0"),
    positionSide: String(upd.ps ?? base.positionSide ?? "BOTH"),
    updateTime: Date.now(),
    leverage: base.leverage ?? upd.leverage,
  };
}

/**
 * @param {object} opts
 * @param {{ info?: (o: object) => void, warn?: (o: object) => void }} opts.log
 * @param {string} opts.tag
 * @param {import("axios").AxiosInstance} opts.http
 * @param {string} opts.apiKey
 * @param {string} opts.userWsBase e.g. `wss://fstream.binance.com/ws` (no trailing slash)
 * @param {typeof import("ws")} opts.WebSocket
 * @param {number} [opts.keepAliveIntervalMs]
 * @param {number} [opts.reconnectDelayMs]
 */
export function createUsdMUserDataStream({
  log,
  tag,
  http,
  apiKey,
  userWsBase,
  WebSocket,
  keepAliveIntervalMs = 50 * 60 * 1000,
  reconnectDelayMs = 4000,
}) {
  let listenKey = null;
  /** @type {import("ws") | null} */
  let ws = null;
  let keepAliveTimer = null;
  let reconnectTimer = null;
  let stopped = false;
  let startPromise = null;
  let suppressCloseReconnect = false;
  /** @type {Record<string, unknown> | null} */
  let mergedAccount = null;
  let lastEventAt = 0;
  let connected = false;
  /** @type {Set<() => void>} */
  const accountPushListeners = new Set();

  function notifyAccountPushListeners() {
    for (const fn of [...accountPushListeners]) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
  }

  function clearTimers() {
    if (keepAliveTimer) {
      try {
        clearInterval(keepAliveTimer);
      } catch {
        /* ignore */
      }
    }
    keepAliveTimer = null;
    if (reconnectTimer) {
      try {
        clearTimeout(reconnectTimer);
      } catch {
        /* ignore */
      }
    }
    reconnectTimer = null;
  }

  function closeWs({ suppressReconnect = false } = {}) {
    connected = false;
    if (suppressReconnect && ws) suppressCloseReconnect = true;
    try {
      ws?.terminate?.();
    } catch {
      /* ignore */
    }
    try {
      ws?.close?.();
    } catch {
      /* ignore */
    }
    ws = null;
  }

  async function createListenKey() {
    const { data } = await http.request({ method: "POST", url: "/fapi/v1/listenKey" });
    const lk = data?.listenKey;
    if (!lk || typeof lk !== "string") throw new Error(`${tag}:listen_key_missing`);
    return lk;
  }

  async function keepAliveListenKey() {
    if (!listenKey) return;
    await http.request({ method: "PUT", url: "/fapi/v1/listenKey", params: { listenKey } });
  }

  function applyAccountUpdate(a) {
    if (!mergedAccount || typeof mergedAccount !== "object") return;
    const B = Array.isArray(a?.B) ? a.B : [];
    for (const b of B) {
      const asset = String(b?.a || "").toUpperCase();
      if (asset === "USDT") {
        if (b.wb != null && b.wb !== "") mergedAccount.totalWalletBalance = String(b.wb);
        if (b.cw != null && b.cw !== "") mergedAccount.availableBalance = String(b.cw);
      }
    }
    const P = Array.isArray(a?.P) ? a.P : [];
    if (!P.length) {
      lastEventAt = Date.now();
      notifyAccountPushListeners();
      return;
    }
    const ps = Array.isArray(mergedAccount.positions) ? [...mergedAccount.positions] : [];
    for (const upd of P) {
      const sym = String(upd?.s || "").toUpperCase();
      if (!sym) continue;
      const sideKey = normalizePositionSideKey(upd?.ps);
      const idx = ps.findIndex(
        (p) =>
          String(p?.symbol || "").toUpperCase() === sym && normalizePositionSideKey(p?.positionSide) === sideKey,
      );
      const pa = num(upd.pa);
      if (Math.abs(pa) < 1e-12) {
        if (idx >= 0) ps.splice(idx, 1);
      } else {
        const row = mergePositionFromAccountUpdate(idx >= 0 ? ps[idx] : null, upd);
        if (idx >= 0) ps[idx] = row;
        else ps.push(row);
      }
    }
    mergedAccount.positions = ps;
    lastEventAt = Date.now();
    notifyAccountPushListeners();
  }

  function onJsonMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(String(raw || ""));
    } catch {
      return;
    }
    const ev = String(msg?.e || "");
    if (ev === "ACCOUNT_UPDATE") {
      applyAccountUpdate(msg?.a);
    } else if (ev === "ORDER_TRADE_UPDATE") {
      notifyAccountPushListeners();
    } else if (ev === "listenKeyExpired") {
      log?.warn?.(`${tag}_listen_key_expired`, {});
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (stopped) return;
    clearTimers();
    closeWs();
    listenKey = null;
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void start().catch(() => {});
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  }

  async function openWs() {
    if (stopped || !listenKey) return;
    const base = String(userWsBase || "").trim().replace(/\/$/, "");
    const url = `${base}/${listenKey}`;
    const socket = new WebSocket(url);
    ws = socket;

    socket.on("open", () => {
      connected = true;
      log?.info?.(`${tag}_user_stream_open`, { urlHost: (() => { try { return new URL(base).host; } catch { return ""; } })() });
    });

    socket.on("message", (data) => {
      onJsonMessage(data);
    });

    socket.on("error", (err) => {
      log?.warn?.(`${tag}_user_stream_ws_error`, { error: String(err?.message || err) });
    });

    socket.on("close", () => {
      connected = false;
      log?.warn?.(`${tag}_user_stream_ws_close`, {});
      if (suppressCloseReconnect) {
        suppressCloseReconnect = false;
        return;
      }
      scheduleReconnect();
    });
  }

  async function start() {
    if (stopped || !apiKey) return;
    if (startPromise) return startPromise;
    if (connected || reconnectTimer || listenKey) return;
    startPromise = (async () => {
    clearTimers();
    closeWs({ suppressReconnect: true });
    try {
      listenKey = await createListenKey();
    } catch (e) {
      log?.warn?.(`${tag}_listen_key_start_failed`, { error: String(e?.message || e) });
      scheduleReconnect();
      return;
    }
    keepAliveTimer = setInterval(() => {
      keepAliveListenKey().catch((e) => {
        log?.warn?.(`${tag}_listen_key_keepalive_failed`, { error: String(e?.message || e) });
      });
    }, keepAliveIntervalMs);
    keepAliveTimer.unref?.();
    await openWs();
    })().finally(() => {
      startPromise = null;
    });
    return startPromise;
  }

  function stop() {
    stopped = true;
    startPromise = null;
    clearTimers();
    closeWs({ suppressReconnect: true });
    listenKey = null;
    mergedAccount = null;
    lastEventAt = 0;
    accountPushListeners.clear();
  }

  /**
   * Replace merged snapshot (full `/fapi/v2/account` payload).
   * @param {Record<string, unknown>} data
   */
  function ingestRestSnapshot(data) {
    if (!data || typeof data !== "object") return;
    mergedAccount = JSON.parse(JSON.stringify(data));
    lastEventAt = Date.now();
  }

  /**
   * @param {number} nowMs
   * @param {number} maxAgeMs
   */
  function isFresh(nowMs, maxAgeMs) {
    return connected && mergedAccount != null && nowMs - lastEventAt <= maxAgeMs;
  }

  /** @returns {Record<string, unknown> | null} */
  function getMergedAccount() {
    return mergedAccount;
  }

  /**
   * Subscribe to push-style account/position updates (after ACCOUNT_UPDATE merge or ORDER_TRADE_UPDATE).
   * @param {() => void} fn
   * @returns {() => void} unsubscribe
   */
  function subscribeAccountPush(fn) {
    if (typeof fn !== "function") return () => {};
    accountPushListeners.add(fn);
    return () => {
      accountPushListeners.delete(fn);
    };
  }

  return {
    start,
    stop,
    ingestRestSnapshot,
    isFresh,
    getMergedAccount,
    subscribeAccountPush,
    get connected() {
      return connected;
    },
    get lastEventAt() {
      return lastEventAt;
    },
  };
}
