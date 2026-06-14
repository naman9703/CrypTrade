import axios from "axios";
import { isStrictBinanceAccountMode } from "../../lib/tradingModePersistence.js";

function truthyEnv(v) {
  const s = String(v ?? "").toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

function trimTelegramText(s, max = 3900) {
  const t = String(s ?? "").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 20)}\n…(truncated)`;
}

/**
 * Telegram integration that never blocks trading:
 * - Activity/trade hooks only enqueue strings (sync).
 * - sendMessage runs in a micro-task / async drain with pacing.
 * - Command polling runs in its own async loop.
 */
export function createTelegramSidecar({ log, appState }) {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || "").trim();
  /** Prefer numeric string; Telegram private chats are positive integers, groups negative. */
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "").trim();
  const enabled = truthyEnv(process.env.TELEGRAM_ENABLED) && token.length > 10 && chatId.length > 0;

  const base = `https://api.telegram.org/bot${token}`;
  const queue = [];
  let drainScheduled = false;
  let pollStop = false;
  let offset = 0;

  function enqueue(text) {
    if (!enabled || !text) return;
    if (queue.length > 120) queue.splice(0, queue.length - 120);
    queue.push(text);
    if (!drainScheduled) {
      drainScheduled = true;
      queueMicrotask(() => {
        void drain();
      });
    }
  }

  function telegramErrDetail(e) {
    const d = e?.response?.data;
    if (d && typeof d === "object" && d.description) return String(d.description);
    return String(e?.message || e);
  }

  async function drain() {
    drainScheduled = false;
    while (queue.length > 0 && enabled) {
      const text = queue.shift();
      try {
        const out = await axios.post(
          `${base}/sendMessage`,
          { chat_id: chatId, text: trimTelegramText(text), disable_web_page_preview: true },
          { timeout: 15000 },
        );
        if (out.data?.ok === false) {
          log.warn("telegram_send_api_error", { description: out.data?.description || out.data });
        }
      } catch (e) {
        log.warn("telegram_send_failed", {
          error: telegramErrDetail(e),
          status: e?.response?.status,
          hint:
            "Open a chat with your bot in Telegram and tap Start first. TELEGRAM_CHAT_ID must match message.chat.id from that chat. If you used BotFather setWebhook, long polling is blocked until webhook is removed.",
        });
      }
      await new Promise((r) => setTimeout(r, 70));
    }
  }

  function chatAllowed(id) {
    if (id == null || chatId === "") return false;
    return String(id) === chatId || String(Number(id)) === chatId;
  }

  /** Skip Telegram for noisy non-action signal lines (still in Activity / WS). */
  function shouldSuppressSignalOnTelegram(payload) {
    if (payload?.category !== "signal") return false;
    const r = payload.reason != null ? String(payload.reason) : "";
    const d = payload.detail;
    const dr = d && typeof d === "object" && d.reason != null ? String(d.reason) : "";
    return (
      r === "bar_close_not_ready_buffer_mismatch" ||
      dr === "bar_close_not_ready_buffer_mismatch" ||
      r === "supertrend_autotrade_off_or_market_mode_mismatch" ||
      dr === "supertrend_autotrade_off_or_market_mode_mismatch"
    );
  }

  /** Categories forwarded from Activity (indicator signals, engine on/off). */
  function notifyActivity(payload) {
    if (!enabled) return;
    const cat = payload?.category;
    if (cat === "bot_lifecycle" || cat === "signal" || cat === "manual_trade") {
      if (shouldSuppressSignalOnTelegram(payload)) return;
      const ts = payload.ts ? String(payload.ts) : "";
      const line = ts ? `[${ts}] ${payload.msg}` : String(payload.msg);
      enqueue(line);
    }
  }

  function notifyTrade(trade) {
    if (!enabled || !trade || typeof trade !== "object") return;
    const t = /** @type {Record<string, unknown>} */ (trade);
    const typ = String(t.type || "").toUpperCase();
    const sym = t.symbol != null ? String(t.symbol) : "—";
    if (typ === "OPEN") {
      const side = t.side != null ? String(t.side) : "—";
      const qty = t.qty != null ? String(t.qty) : "—";
      const px = t.price != null ? String(t.price) : "—";
      enqueue(`TRADE OPEN · ${sym} ${side} qty=${qty} @ ${px}`);
      return;
    }
    if (typ === "CLOSE") {
      const pnl = t.pnl != null ? Number(t.pnl) : NaN;
      const pnlS = Number.isFinite(pnl) ? pnl.toFixed(4) : String(t.pnl ?? "—");
      const rid = t.reason != null ? String(t.reason) : "";
      const strat = t.strategy != null ? String(t.strategy) : t.strategyKey != null ? String(t.strategyKey) : "";
      const fee = t.fee != null ? String(t.fee) : "";
      const parts = [`TRADE CLOSE · ${sym}`, `pnl=${pnlS}`];
      if (fee) parts.push(`fee=${fee}`);
      if (strat) parts.push(`strat=${strat}`);
      if (rid) parts.push(`reason=${rid}`);
      enqueue(parts.join(" · "));
    }
  }

  function fmtNum(v, decimals = 2) {
    const n = Number(v);
    return Number.isFinite(n) ? n.toFixed(decimals) : "—";
  }

  /** Daily PnL field is a fraction on paper sims (0.012 = 1.2%) but may be 0 on many Binance paths. */
  function fmtDailyPct(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    const asPct = Math.abs(n) <= 1 ? n * 100 : n;
    return `${asPct.toFixed(2)}%`;
  }

  async function buildStatusMessage() {
    const lines = [];
    const bot = appState.bot.getPublicState();
    lines.push(`Status · ${new Date().toISOString()}`);
    lines.push(`Mode: ${appState.mode}`);
    lines.push(`Engine: ${bot.running ? "RUNNING" : "STOPPED"}`);
    lines.push(`Symbol: ${bot.symbol} · TF ${bot.timeframe}`);
    if (bot.feed && typeof bot.feed === "object") {
      const src = bot.feed.source ?? "—";
      const ok = bot.feed.ok === false ? "stale" : "ok";
      lines.push(`Feed: ${src} (${ok})`);
    }
    const perf = bot.performance || {};
    lines.push(
      `Rolling (${perf.totalTrades ?? 0} closes): WR=${fmtNum(perf.winRate, 4)} avgPnl=${fmtNum(perf.avgPnl)}`,
    );
    lines.push(`Risk: maxDD=${fmtNum(perf.maxDrawdownPct, 4)} peakEq=${fmtNum(perf.peakEquity)}`);
    const ai = bot.lastAi;
    if (ai && ai.probability != null && Number.isFinite(Number(ai.probability))) {
      lines.push(`Last AI prob: ${fmtNum(Number(ai.probability), 3)}`);
    }

    try {
      const strictAcc = isStrictBinanceAccountMode(appState.mode);
      const acct = await appState.exchange.getAccount().catch(() => null);
      const positions =
        acct == null && strictAcc
          ? []
          : await appState.exchange.getPositions().catch(() => []);

      lines.push("— Portfolio —");
      if (acct == null) {
        lines.push(
          strictAcc
            ? "Binance account unavailable — check API keys, IP whitelist, permissions."
            : "Account snapshot unavailable.",
        );
        lines.push("Equity / PnL / positions: —");
      } else {
        if (acct?.venues && typeof acct.venues === "object") {
          lines.push("Wallets (hybrid):");
          const sp = acct.venues.spot;
          const fu = acct.venues.futures;
          if (sp && sp.equity != null) {
            lines.push(`Spot equity ${fmtNum(sp.equity)} · free ${fmtNum(sp.freeBalance)}`);
          }
          if (fu && fu.equity != null) {
            lines.push(`Futures wallet ${fmtNum(fu.equity)} · free ${fmtNum(fu.freeBalance)}`);
          }
        }

        let baseEq = null;
        if (acct.equity != null && Number.isFinite(Number(acct.equity))) {
          baseEq = Number(acct.equity);
        }

        let uSum = 0;
        for (const p of positions) {
          const u = Number(p?.unrealizedPnl ?? p?.unrealizedProfit ?? 0);
          if (Number.isFinite(u)) uSum += u;
        }
        const eqWithU = baseEq != null ? baseEq + uSum : null;

        lines.push(
          baseEq != null
            ? `Base equity ${fmtNum(baseEq)} USDT`
            : `Base equity: —${acct.accountFetchPartial ? " (partial fetch)" : ""}`,
        );
        lines.push(
          eqWithU != null
            ? `Unrealized Σ ${fmtNum(uSum)} → with uPnL ${fmtNum(eqWithU)} USDT`
            : `Unrealized Σ ${fmtNum(uSum)} → with uPnL: —`,
        );
        if (acct?.dailyPnlPct != null && Number.isFinite(Number(acct.dailyPnlPct))) {
          lines.push(`Daily PnL ${fmtDailyPct(acct.dailyPnlPct)}`);
        }

        if (positions.length) {
          lines.push("— Positions —");
          for (const p of positions.slice(0, 6)) {
            const ven = p?.venue ? String(p.venue) : "";
            const sym = p?.symbol ?? "—";
            const side = p?.side ?? "—";
            const u = p?.unrealizedPnl ?? p?.unrealizedProfit;
            lines.push(`${ven ? `${ven} ` : ""}${sym} ${side} uPnL≈${fmtNum(u)}`);
          }
          if (positions.length > 6) lines.push(`… +${positions.length - 6} more`);
        } else {
          lines.push("Open positions: none");
        }
      }
    } catch {
      lines.push("(account/positions unavailable)");
    }
    return lines.join("\n");
  }

  async function handleMessage(text, fromChatId) {
    if (!chatAllowed(fromChatId)) {
      log.warn("telegram_chat_rejected", {
        fromChatId,
        expectedChatIdEnv: chatId,
        hint: "Set TELEGRAM_CHAT_ID to this fromChatId (or your user id from @userinfobot) so commands work.",
      });
      return;
    }
    const raw = String(text || "").trim();
    const [cmd0] = raw.split(/\s+/);
    const cmd = cmd0.toLowerCase();

    if (cmd === "/help" || cmd === "/start") {
      enqueue(
        [
          "Commands:",
          "/status — bot, symbol, equity, positions, rolling PnL stats",
          "/bot_on — start engine (same as UI Start)",
          "/bot_off — stop engine",
          "/help — this text",
        ].join("\n"),
      );
      return;
    }

    if (cmd === "/status") {
      const body = await buildStatusMessage();
      enqueue(body);
      return;
    }

    if (cmd === "/bot_on") {
      appState.bot.start({
        wsHub: appState.wsHub,
        reason: "telegram",
        source: "telegram",
      });
      enqueue("Engine start requested (telegram).");
      return;
    }

    if (cmd === "/bot_off") {
      appState.bot.stop({
        wsHub: appState.wsHub,
        reason: "telegram",
        source: "telegram",
      });
      enqueue("Engine stop requested (telegram).");
      return;
    }

    enqueue(`Unknown command: ${cmd0}. Try /help`);
  }

  async function pollLoop() {
    if (!enabled || pollStop) return;
    try {
      const { data } = await axios.get(`${base}/getUpdates`, {
        params: { offset: offset > 0 ? offset : undefined, timeout: 25 },
        timeout: 32000,
      });
      if (data?.ok === false) {
        log.warn("telegram_get_updates_not_ok", { description: data?.description || data });
      }
      const updates = Array.isArray(data?.result) ? data.result : [];
      for (const u of updates) {
        if (typeof u?.update_id === "number") offset = u.update_id + 1;
        const msg = u?.message;
        const text = msg?.text;
        const cid = msg?.chat?.id;
        if (text != null && cid != null) {
          void handleMessage(text, cid).catch((e) =>
            log.warn("telegram_command_failed", { error: String(e?.message || e) }),
          );
        }
      }
    } catch (e) {
      log.warn("telegram_get_updates_failed", {
        error: telegramErrDetail(e),
        status: e?.response?.status,
        hint: "If a webhook is set on this bot, call deleteWebhook or delete it via @BotFather so getUpdates (long poll) can receive commands.",
      });
    }
    if (!pollStop && enabled) setTimeout(() => void pollLoop(), 250);
  }

  return {
    enabled,
    notifyActivity,
    notifyTrade,
    start() {
      if (!enabled) return;
      pollStop = false;
      log.info("telegram_sidecar_started", { chatConfigured: Boolean(chatId) });
      void (async () => {
        try {
          const del = await axios.post(`${base}/deleteWebhook`, { drop_pending_updates: false }, { timeout: 15000 });
          if (del.data?.ok) log.info("telegram_polling_mode", { note: "webhook cleared so getUpdates works" });
          else log.warn("telegram_delete_webhook_response", { data: del.data });
        } catch (e) {
          log.warn("telegram_delete_webhook_failed", { error: telegramErrDetail(e) });
        }
        try {
          const me = await axios.get(`${base}/getMe`, { timeout: 10000 });
          if (me.data?.ok && me.data?.result) {
            log.info("telegram_bot_identity", {
              username: me.data.result.username,
              id: me.data.result.id,
            });
          }
        } catch (e) {
          log.warn("telegram_get_me_failed", { error: telegramErrDetail(e) });
        }
        if (truthyEnv(process.env.TELEGRAM_STARTUP_PING)) {
          enqueue("Trading bot — Telegram outbound OK. You'll get signal & trade alerts here.");
        }
        void pollLoop();
      })();
    },
    stop() {
      pollStop = true;
    },
  };
}
