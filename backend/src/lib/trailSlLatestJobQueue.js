/**
 * Per-symbol "latest wins" async queue for trailing SL exchange work.
 *
 * - Only one worker chain per symbol; new submissions **replace** the pending slot
 *   (intermediate SL levels are dropped — no T2 then T4 if T4 arrived before T2 ran).
 * - Intended for single-process bots. Multiple Node instances on the same Binance account
 *   still need an external coordinator — this does not merge cross-process.
 */

/**
 * @param {object} mem  Bot memory root (persists queue state on `mem._trailSlLatestJobBySymbol`).
 * @param {string} symU Upper symbol, e.g. BTCUSDT
 * @param {() => Promise<void>} run  Async body (caller wraps exchange + verify + locks).
 */
export function submitLatestTrailingSlJob(mem, symU, run) {
  const map = (mem._trailSlLatestJobBySymbol = mem._trailSlLatestJobBySymbol || {});
  const st = map[symU] || (map[symU] = { pending: null, draining: false });
  st.pending = run;
  if (!st.draining) {
    st.draining = true;
    void drainLatestTrailingSlSlot(mem, symU);
  }
}

async function drainLatestTrailingSlSlot(mem, symU) {
  const map = mem._trailSlLatestJobBySymbol;
  const st = map?.[symU];
  if (!st) return;
  try {
    while (st.pending) {
      const run = st.pending;
      st.pending = null;
      try {
        await run();
      } catch {
        /* caller should log; never break the chain */
      }
    }
  } finally {
    st.draining = false;
    if (st.pending) {
      st.draining = true;
      await drainLatestTrailingSlSlot(mem, symU);
    }
  }
}
