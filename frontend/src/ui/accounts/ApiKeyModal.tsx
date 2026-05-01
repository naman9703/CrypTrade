import { useEffect, useState, type FormEvent } from "react";
import { api } from "../../api/client";
import type { Account, CredentialsMeta } from "../../types/accounts";

function formatVerified(iso: string | null | undefined) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t);
  const diff = Date.now() - t;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return "just now";
  if (h < 48) return `${h}h ago`;
  return d.toLocaleString();
}

export function ApiKeyModal({
  open,
  account,
  onClose,
  onSaved,
}: {
  open: boolean;
  account: Account | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [meta, setMeta] = useState<CredentialsMeta | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  useEffect(() => {
    if (!open || !account) return;
    setApiKey("");
    setSecret("");
    setErr(null);
    setMeta(account.credentials ?? null);
    let cancelled = false;
    void (async () => {
      try {
        const m = await api.getCredentialsMeta(account.id);
        if (!cancelled) setMeta(m);
      } catch {
        if (!cancelled) setMeta(account.credentials ?? null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, account]);

  if (!open || !account) return null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!apiKey.trim() || !secret.trim()) {
      setErr("API key and secret are required");
      return;
    }
    setBusy(true);
    try {
      await api.saveCredentials(account.id, apiKey.trim(), secret.trim());
      setApiKey("");
      setSecret("");
      const m = await api.getCredentialsMeta(account.id);
      setMeta(m);
      onSaved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onRevoke() {
    if (!confirm("Revoke API keys for this account?")) return;
    setRevokeBusy(true);
    setErr(null);
    try {
      await api.revokeCredentials(account.id);
      setMeta(null);
      onSaved();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Revoke failed");
    } finally {
      setRevokeBusy(false);
    }
  }

  const verifiedLabel = formatVerified(meta?.lastVerifiedAt ?? null);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal>
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">API keys</h2>
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{account.label}</p>

        <form className="mt-4 space-y-3" onSubmit={onSubmit}>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            API key<span className="text-rose-500">*</span>
            <input
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-950"
              placeholder="Paste Binance API key"
            />
          </label>
          <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
            Secret key<span className="text-rose-500">*</span>
            <input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm dark:border-slate-600 dark:bg-slate-950"
              placeholder="Paste secret (shown once)"
            />
          </label>

          <p className="text-[11px] leading-relaxed text-amber-800 dark:text-amber-200/90">
            The secret is encrypted and stored securely. It cannot be retrieved after saving.
          </p>

          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-800/80">
            {meta?.isActive ? (
              <p className="text-emerald-700 dark:text-emerald-400">
                ✓ Active key set
                {verifiedLabel ? ` (last verified: ${verifiedLabel})` : ""}
              </p>
            ) : (
              <p className="text-slate-600 dark:text-slate-400">✗ No key set</p>
            )}
            {meta?.apiKey ? (
              <p className="mt-1 font-mono text-[11px] text-slate-700 dark:text-slate-300">Public: {meta.apiKey}</p>
            ) : null}
          </div>

          {meta?.isActive ? (
            <button
              type="button"
              onClick={() => void onRevoke()}
              disabled={revokeBusy}
              className="w-full rounded-lg border border-rose-300 py-2 text-sm font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-950/40"
            >
              {revokeBusy ? "Revoking…" : "Revoke keys"}
            </button>
          ) : null}

          {err ? <p className="text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm dark:border-slate-600"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-sky-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save keys"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
