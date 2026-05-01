import { getPool } from "../db/pool.js";
import { resolveWalletSnapshotAccountId, scheduleWalletSnapshotWrite } from "../db/services/walletService.js";
import { ENGINE_TRADING_MODES } from "../state/appState.js";

/**
 * Periodic wallet_snapshots (scheduled) for running engines — non-blocking, errors swallowed.
 * @param {{ getEngine: (m: string) => { exchange?: { getAccount?: () => Promise<unknown>, getPositions?: () => Promise<unknown[]> } } | null, getActiveAccount: (slug: string) => string | null }} appState
 * @param {{ warn?: (m: string, d?: unknown) => void }} [log]
 * @param {number} [intervalMs=60000]
 * @returns {() => void} stop function
 */
export function startWalletSnapshotPoller(appState, log, intervalMs = 60_000) {
  if (!getPool()) return () => {};
  const ms = Math.max(15_000, Math.min(300_000, Number(intervalMs) || 60_000));
  const tick = () => {
    for (const m of ENGINE_TRADING_MODES) {
      const row = appState.getEngine(m);
      const ex = row?.exchange;
      if (!ex || typeof ex.getAccount !== "function") continue;
      void (async () => {
        try {
          const aid = await resolveWalletSnapshotAccountId(appState, m);
          if (!aid) return;
          const acct = await ex.getAccount().catch(() => null);
          if (acct == null) return;
          const pos = typeof ex.getPositions === "function" ? await ex.getPositions().catch(() => []) : [];
          scheduleWalletSnapshotWrite(aid, acct, Array.isArray(pos) ? pos : []);
        } catch (e) {
          log?.warn?.("wallet_snapshot_poller_tick_failed", { mode: m, error: String(e?.message || e) });
        }
      })();
    }
  };
  const id = setInterval(tick, ms);
  return () => clearInterval(id);
}
