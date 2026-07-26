# 2026-07-25 — UI backtest 3 trades was not BUYBD

**Symptom:** User backtest BNBUSDT 15m → 3 trades, −1.2%, DD 3.1%.

**Actual snapshot** (`ca2cad4f`, `instance_snapshot`, 2026-01-01→2026-07-24):
- `intradayGateLiquidity: false`
- `intradayGateSmcIct: true`
- No BUYBD keys (mitigation / daySituationBias / displacement)

→ Ran **SMC/ICT**, not prepared-mit BUYBD. Research BUYBD on same coin is ~2+/wk expectancy green.

**Root causes**
1. Apply preset only stages a draft; backtest uses **saved** strategy/instance — must click **Save strategy**.
2. Research LIQ keys were **stripped** on Save (`SIGNAL_BRAIN_BOT_KEYS` / frontend persist allowlist missing dayBias/mitigation/disp/hours/playbook).
3. LIQ presets did not explicitly set `intradayGateSmcIct: false`, so draft merge could leave SMC on.

**Fix (this change):** persist allowlist + bot apply/persist + zod union for dayBias string modes; LIQ presets force SMC/Inst off.

## Round 2 — fix verified, and the honest result is worse than the sleeve claim

User re-ran and still saw 3 trades. Snapshot `cbbeceb6` showed the new LIQ keys **present but at
defaults** with `liq:false / smc:true` → save path was repaired, but the preset values had never
been applied to the draft before Save. Bound version `7e3b7938` (instance `07536a77`, label `test`)
was still the SMC config.

Wrote the BUYBD preset into that version as a **clean** `byStrategy.SR_INTRADAY` slice
(other slices preserved; backup `scripts/.strategy-version-backup-7e3b7938.json`).

Replay harness: `scripts/verify-saved-version-backtest.mjs` (hydrates the saved version and merges
instance-owned market/risk fields exactly as `backtestRoutes` does). Saved version now reproduces
research: Y1 n=105 tw=2.01 **+22.5%** PF 1.16.

**But on the window the user actually backtested:**

| Window | n | tw | ret | PF | DD |
|--------|---|----|-----|----|----|
| 2026-01-01 → 2026-07-24 (UI) | 41 | 1.41 | **−9.62%** | 0.777 | 16.4% |
| 2025-07-01 → 2026-07-01 (Y1) | 105 | 2.01 | +22.5% | 1.16 | 24.2% |
| 2024-07-01 → 2025-07-01 (HOLD) | 123 | 2.36 | +4.2% | 1.03 | — |
| 2025-07-01 → 2026-01-01 (2025 H2) | 66 | 2.51 | **+40.0%** | 1.46 | — |

Isolation (`scripts/verify-buybd-window-ab.mjs`): risk guards (`maxDailyLoss` / loss-streak) move
nothing — research overlay and preset agree within ~1 trade on every window.

**Finding: the sleeve is regime-concentrated, not robust.** All of Y1's +22.5% comes from 2025 H2
(+40%); the most recent 7 months are −9.6% with tw 1.41 (below the ≥2 floor). Y1 "PASS" in
`2026-07-25-liq-bnb-onesided-freq-restore.md` was a window artifact — 2026 H1 is the forward slice
and it fails both gates.

**Verdict: BUYBD is NOT deployable.** Do not run WF/MC on it as-is. Next step is an autopsy of the
2026 H1 losers (what changed in BNB regime vs 2025 H2) before any further parameter work.

## Round 3 — the UI kept saving SMC over the LIQ preset (gate-leak race, now fixed)

User re-ran → 1 trade / +2.0%, then 3 trades again. Snapshots `1a8a1323` / `8298e982`
(`instance_snapshot`, ver `7e3b7938`) showed the smoking gun: **BUYBD tuning keys present at
preset values** (`daybias:buy_breakdown`, `mit:true`, `mitFrac:0.3`, `dispV2:true`) **but
`intradayGateLiquidity:false`, `intradayGateSmcIct:true`**. i.e. the LIQ preset's tuning was
applied while the gate flags stayed on the live SMC engine → the backtest ran SMC.

Reproduced deterministically (`enginePayload` = live SMC, `clientCfgRaw` = BUYBD preset):
- Good client (draft gates win) → `liq:true, smc:false`.
- Client with gates left on SMC → `liq:false, smc:true` (exactly the DB state).

So the frontend intermittently sends the LIQ preset with the SMC gate flags still set (a
WS-tick draft-clear race in `store.ts`/`deriveViewBot` drops the gate keys from the draft while
the `intradayLiq*` tuning keys survive). Chasing the exact UI timing is fragile.

**Fix (authoritative, backend):** `enforceLiqGateCoherence()` in `strategyConfigSlices.js`.
A config with a LIQ-research signature (`intradayLiqDaySituationBias ∈
{both,buy_breakdown,sell_breakout}`, or `LIQ_CORE/LIQ_ACCEPT` playbook with
`MitigationEntry+RequireDisplacementV2`) can never coherently have the SMC/ICT or institutional-SR
gate on, so we force `intradayGateLiquidity:true` + those gates off. Wired into:
- `materializeStrategyCfgRawForSave` — every strategy Save.
- `materializeBacktestEngineSnapshot` (`backtestRoutes.js`) — every intraday backtest, so a
  `_with_live_panel` overlay from a running SMC engine can't re-leak.
Pure SMC/ICT configs (no LIQ signature) are untouched — covered by unit tests in
`strategyConfigSlices.test.mjs`.

Version `7e3b7938` rewritten through the fixed path (clean `SR_INTRADAY` slice, other slices
preserved). Replay = `n=41 tw=1.41 −9.62% pf=0.777` on 2026 YTD — the honest BUYBD result, no
longer SMC. Backend runs `node --watch`, so the fix is live.

Net: the UI now truthfully backtests BUYBD. The number it shows is negative because **the strategy
is not deployable** (Round 2), which remains the real finding.
