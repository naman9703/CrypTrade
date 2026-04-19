/**
 * True "income ledger" closes: exchange REALIZED_PNL rows we could not tie to a local bracket.
 * Bracket-matched rows still come from fapi income sync but must count as strategy closes for PnL / winrate.
 */
export function isIncomeLedgerClose(t: Record<string, unknown> | null | undefined): boolean {
  if (!t) return false;
  const meta = t.meta as Record<string, unknown> | undefined;
  if (meta?.localEnforcement === true) return false;

  // Income-sync CLOSE rows keyed to a local OPEN are still the round-trip exit leg for that
  // position; classify as non-ledger so Src "Strategy" / closed-only views show OPEN + CLOSE.
  const openRefId = meta?.openRefId;
  if (openRefId != null && String(openRefId).trim() !== "") return false;

  if (t.ledgerEvent === true || meta?.ledgerEvent === true) return true;
  if (String(t.strategy ?? "").toUpperCase() === "INCOME_LEDGER") return true;
  if (String(t.strategy ?? "") === "FUTURES_DEMO") return true;
  if (meta?.note === "realized_pnl_ledger_row") return true;
  if (meta?.source === "fapi_income") return true;
  return false;
}
