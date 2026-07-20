import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useAppStore } from "../ws/store";

export type TradingPanelLiveData = {
  account: unknown;
  positions: unknown[];
  trades: unknown[];
};

const TradingPanelLiveDataContext = createContext<TradingPanelLiveData | null>(null);

/** Isolates account/position/trade WS ticks from the strategy config subtree. */
export function TradingPanelLiveDataScope({ children }: { children: ReactNode }) {
  const account = useAppStore((s) => s.account);
  const positions = useAppStore((s) => s.positions);
  const trades = useAppStore((s) => s.trades);
  const value = useMemo(
    () => ({ account, positions, trades }),
    [account, positions, trades],
  );
  return (
    <TradingPanelLiveDataContext.Provider value={value}>{children}</TradingPanelLiveDataContext.Provider>
  );
}

export function useTradingPanelLiveData(): TradingPanelLiveData {
  const ctx = useContext(TradingPanelLiveDataContext);
  if (!ctx) {
    throw new Error("useTradingPanelLiveData must be used within TradingPanelLiveDataScope");
  }
  return ctx;
}
