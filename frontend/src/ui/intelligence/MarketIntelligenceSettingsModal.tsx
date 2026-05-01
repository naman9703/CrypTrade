import { useEffect, useState, type FormEvent } from "react";
import { api, type MarketIntelProvidersStatus } from "../../api/client";

type Props = {
  open: boolean;
  onClose: () => void;
};

function GearHintRow({
  label,
  envOn,
  storedTail,
  effectiveOn,
}: {
  label: string;
  envOn: boolean;
  storedTail: string | null | undefined;
  effectiveOn: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-slate-500 dark:text-slate-400">
      <span className="font-semibold text-slate-600 dark:text-slate-300">{label}</span>
      <span>{effectiveOn ? <span className="text-emerald-600 dark:text-emerald-400">active</span> : "off"}</span>
      {envOn ? (
        <span className="rounded bg-slate-200 px-1 dark:bg-slate-800">env</span>
      ) : null}
      {storedTail ? (
        <span className="rounded bg-amber-500/15 px-1 text-amber-800 dark:text-amber-200">stored {storedTail}</span>
      ) : null}
    </div>
  );
}

export function MarketIntelligenceSettingsModal({ open, onClose }: Props) {
  const [status, setStatus] = useState<MarketIntelProvidersStatus | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);

  const [finnhubApiKey, setFinnhubApiKey] = useState("");
  const [cryptoquantApiKey, setCryptoquantApiKey] = useState("");
  const [whaleAlertApiKey, setWhaleAlertApiKey] = useState("");
  const [aiBaseUrl, setAiBaseUrl] = useState("");

  const [clearFinnhub, setClearFinnhub] = useState(false);
  const [clearCryptoquant, setClearCryptoquant] = useState(false);
  const [clearWhale, setClearWhale] = useState(false);
  const [clearAiUrl, setClearAiUrl] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadErr(null);
    setSaveErr(null);
    setClearFinnhub(false);
    setClearCryptoquant(false);
    setClearWhale(false);
    setClearAiUrl(false);
    setFinnhubApiKey("");
    setCryptoquantApiKey("");
    setWhaleAlertApiKey("");
    setAiBaseUrl("");
    void (async () => {
      try {
        const s = await api.getMarketIntelProviders();
        if (!cancelled) setStatus(s);
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : "load_failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!status?.encryptionConfigured || busy) return;
    setBusy(true);
    setSaveErr(null);
    try {
      const body: {
        finnhubApiKey?: string;
        cryptoquantApiKey?: string;
        whaleAlertApiKey?: string;
        aiBaseUrl?: string;
      } = {};
      if (clearFinnhub) body.finnhubApiKey = "";
      else if (finnhubApiKey.trim()) body.finnhubApiKey = finnhubApiKey.trim();

      if (clearCryptoquant) body.cryptoquantApiKey = "";
      else if (cryptoquantApiKey.trim()) body.cryptoquantApiKey = cryptoquantApiKey.trim();

      if (clearWhale) body.whaleAlertApiKey = "";
      else if (whaleAlertApiKey.trim()) body.whaleAlertApiKey = whaleAlertApiKey.trim();

      if (clearAiUrl) body.aiBaseUrl = "";
      else if (aiBaseUrl.trim()) body.aiBaseUrl = aiBaseUrl.trim();

      await api.putMarketIntelProviders(body);
      await api.getMarketIntelProviders();
      setFinnhubApiKey("");
      setCryptoquantApiKey("");
      setWhaleAlertApiKey("");
      setAiBaseUrl("");
      setClearFinnhub(false);
      setClearCryptoquant(false);
      setClearWhale(false);
      setClearAiUrl(false);
      onClose();
    } catch (err) {
      setSaveErr(err instanceof Error ? err.message : "save_failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  const enc = status?.encryptionConfigured === true;

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Market Intelligence APIs</h2>
          <button
            type="button"
            className="text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
            onClick={onClose}
            disabled={busy}
          >
            ×
          </button>
        </div>

        <div className="space-y-3 px-4 py-3 text-xs text-slate-600 dark:text-slate-400">
          {loadErr ? (
            <p className="rounded-md bg-rose-500/10 px-2 py-1 text-rose-700 dark:text-rose-300">{loadErr}</p>
          ) : null}
          {!status ? (
            <p className="animate-pulse text-slate-500">Loading…</p>
          ) : (
            <>
              <p className="leading-snug">
                Secrets are encrypted with{" "}
                <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">API_CREDENTIALS_ENCRYPTION_KEY</code> and
                stored on the server (first active user&apos;s preferences). Non-empty values override{" "}
                <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">.env</code>.
              </p>
              {!enc ? (
                <p className="rounded-md bg-amber-500/15 px-2 py-1 text-amber-900 dark:text-amber-100">
                  Encryption key is not configured — configure providers via backend environment variables only, or set{" "}
                  <code className="rounded bg-slate-900/10 px-1 dark:bg-slate-100/10">API_CREDENTIALS_ENCRYPTION_KEY</code>{" "}
                  to enable saving keys here.
                </p>
              ) : null}
              <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-slate-700 dark:bg-slate-950/50">
                <GearHintRow
                  label="Finnhub"
                  envOn={Boolean(status.envPresent?.finnhubApiKey)}
                  storedTail={status.storedPreview?.finnhubApiKey ?? null}
                  effectiveOn={Boolean(status.effectivePresent?.finnhubApiKey)}
                />
                <GearHintRow
                  label="CryptoQuant"
                  envOn={Boolean(status.envPresent?.cryptoquantApiKey)}
                  storedTail={status.storedPreview?.cryptoquantApiKey ?? null}
                  effectiveOn={Boolean(status.effectivePresent?.cryptoquantApiKey)}
                />
                <GearHintRow
                  label="Whale Alert"
                  envOn={Boolean(status.envPresent?.whaleAlertApiKey)}
                  storedTail={status.storedPreview?.whaleAlertApiKey ?? null}
                  effectiveOn={Boolean(status.effectivePresent?.whaleAlertApiKey)}
                />
                <GearHintRow
                  label="AI base URL"
                  envOn={Boolean(status.envPresent?.aiBaseUrl)}
                  storedTail={status.storedPreview?.aiBaseUrl ?? null}
                  effectiveOn={Boolean(status.effectivePresent?.aiBaseUrl)}
                />
                {status.effectiveAiBaseUrl ? (
                  <p className="text-[10px] text-slate-500">
                    Resolved AI URL:{" "}
                    <code className="break-all rounded bg-white px-1 dark:bg-slate-900">{status.effectiveAiBaseUrl}</code>
                  </p>
                ) : null}
              </div>
            </>
          )}
        </div>

        <form onSubmit={onSubmit} className="space-y-3 border-t border-slate-200 px-4 py-4 dark:border-slate-700">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Update stored overrides</p>

          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
            Finnhub API key
            <input
              type="password"
              autoComplete="off"
              disabled={!enc || busy}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={finnhubApiKey}
              onChange={(e) => setFinnhubApiKey(e.target.value)}
              placeholder="New key (optional)"
            />
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-[10px] text-slate-500">
              <input type="checkbox" checked={clearFinnhub} disabled={!enc || busy} onChange={(e) => setClearFinnhub(e.target.checked)} />
              Remove stored Finnhub key (fall back to env)
            </label>
          </label>

          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
            CryptoQuant API key
            <input
              type="password"
              autoComplete="off"
              disabled={!enc || busy}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={cryptoquantApiKey}
              onChange={(e) => setCryptoquantApiKey(e.target.value)}
              placeholder="New key (optional)"
            />
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-[10px] text-slate-500">
              <input type="checkbox" checked={clearCryptoquant} disabled={!enc || busy} onChange={(e) => setClearCryptoquant(e.target.checked)} />
              Remove stored CryptoQuant key
            </label>
          </label>

          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
            Whale Alert API key
            <input
              type="password"
              autoComplete="off"
              disabled={!enc || busy}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={whaleAlertApiKey}
              onChange={(e) => setWhaleAlertApiKey(e.target.value)}
              placeholder="New key (optional)"
            />
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-[10px] text-slate-500">
              <input type="checkbox" checked={clearWhale} disabled={!enc || busy} onChange={(e) => setClearWhale(e.target.checked)} />
              Remove stored Whale Alert key
            </label>
          </label>

          <label className="block text-[11px] font-medium text-slate-600 dark:text-slate-400">
            AI service base URL (news sentiment)
            <input
              type="text"
              autoComplete="off"
              disabled={!enc || busy}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-600 dark:bg-slate-950"
              value={aiBaseUrl}
              onChange={(e) => setAiBaseUrl(e.target.value)}
              placeholder="http://127.0.0.1:8001"
            />
            <label className="mt-1 flex cursor-pointer items-center gap-2 text-[10px] text-slate-500">
              <input type="checkbox" checked={clearAiUrl} disabled={!enc || busy} onChange={(e) => setClearAiUrl(e.target.checked)} />
              Remove stored AI URL (fall back to env / default)
            </label>
          </label>

          {saveErr ? <p className="text-[11px] text-rose-600 dark:text-rose-400">{saveErr}</p> : null}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
              onClick={onClose}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!enc || busy || !status}
              className="rounded-md bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-40 dark:bg-slate-200 dark:text-slate-900 dark:hover:bg-white"
            >
              {busy ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
