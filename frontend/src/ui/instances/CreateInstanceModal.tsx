import { useEffect, useMemo, useState, type FormEvent } from "react";
import { clsx } from "clsx";
import type { ApiTradingModeSlug } from "../../lib/tradingModeSlug";
import { apiModeSlugToModeLabel } from "../../lib/tradingModeSlug";
import type { Strategy } from "../../types/strategy";
import type { AllotmentHeadroom } from "../../types/instance";
import { api } from "../../api/client";
import { useAppStore } from "../../ws/store";

type Props = {
  modeSlug: ApiTradingModeSlug;
  strategies: Strategy[];
  open: boolean;
  onClose: () => void;
  onCreated: (instanceId: string) => void;
};

export function CreateInstanceModal({ modeSlug, strategies, open, onClose, onCreated }: Props) {
  const createInstanceStore = useAppStore((s) => s.createInstanceStore);
  const [label, setLabel] = useState("");
  const [versionId, setVersionId] = useState("");
  const [capitalMode, setCapitalMode] = useState<"FIXED" | "PCT">("FIXED");
  const [capitalUsdt, setCapitalUsdt] = useState("2000");
  const [capitalPct, setCapitalPct] = useState("25");
  const [headroom, setHeadroom] = useState<AllotmentHeadroom | null | undefined>(undefined);
  const [headroomError, setHeadroomError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const versionOptions = useMemo(() => {
    const out: { id: string; label: string }[] = [];
    for (const s of strategies) {
      const v = s.latestVersion;
      if (!v) continue;
      const vl = v.label ? `${s.name} — ${v.label}` : `${s.name} — v${v.versionNumber}`;
      out.push({ id: v.id, label: vl });
    }
    return out;
  }, [strategies]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSubmitting(false);
    setHeadroomError(null);
    void (async () => {
      try {
        const r = await api.getAllotmentHeadroom(modeSlug);
        setHeadroom(r.headroom ?? null);
      } catch (e) {
        setHeadroom(null);
        setHeadroomError(
          e instanceof Error && e.message
            ? `Unable to fetch wallet snapshot: ${e.message}`
            : "Unable to fetch account wallet snapshot. Check account/API connectivity.",
        );
      }
    })();
  }, [open, modeSlug]);

  useEffect(() => {
    if (!open || versionOptions.length === 0) return;
    setVersionId((prev) => (prev && versionOptions.some((o) => o.id === prev) ? prev : versionOptions[0].id));
  }, [open, versionOptions]);

  const parsedUsdt = Number(capitalUsdt);
  const parsedPct = Number(capitalPct);
  const newCap =
    capitalMode === "FIXED"
      ? Number.isFinite(parsedUsdt) && parsedUsdt > 0
        ? parsedUsdt
        : 0
      : headroom && Number.isFinite(parsedPct) && parsedPct > 0
        ? (parsedPct / 100) * headroom.availableUsdt
        : 0;
  const remainingAfter =
    headroom != null && Number.isFinite(newCap) ? headroom.headroomUsdt - newCap : null;
  const overCap = remainingAfter != null && remainingAfter < -1e-6;

  if (!open) return null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!label.trim()) {
      setError("Label is required");
      return;
    }
    if (!versionId) {
      setError("Select a strategy version");
      return;
    }
    if (overCap) {
      setError("Not enough headroom for this allotment");
      return;
    }
    setSubmitting(true);
    try {
      const inst = await createInstanceStore(modeSlug, {
        strategyVersionId: versionId,
        label: label.trim(),
        capitalMode,
        capitalUsdt: capitalMode === "FIXED" ? parsedUsdt : null,
        capitalPct: capitalMode === "PCT" ? parsedPct : null,
      });
      onCreated(inst.id);
      onClose();
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal>
      <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-700 dark:bg-slate-900">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-700">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            New instance — {apiModeSlugToModeLabel(modeSlug)}
          </h2>
          <button
            type="button"
            className="rounded p-1 text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </div>
        <form onSubmit={onSubmit} className="space-y-3 p-4 text-sm">
          <div>
            <label className="mb-1 block font-medium text-slate-700 dark:text-slate-300">Label</label>
            <input
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="BTC Scalper #1"
              maxLength={200}
            />
          </div>
          <div>
            <label className="mb-1 block font-medium text-slate-700 dark:text-slate-300">Strategy version</label>
            <select
              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
            >
              {versionOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {versionOptions.length === 0 ? (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                {strategies.length === 0
                  ? "No strategies for this trading mode. Create one in the Strategy sidebar, or run the latest DB migrations if strategies already exist but never show here."
                  : "These strategies have no saved version yet — open Strategy, select one, and save a version snapshot."}
              </p>
            ) : null}
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Account is the one currently selected for this mode (server-side).
          </p>
          <div>
            <span className="mb-1 block font-medium text-slate-700 dark:text-slate-300">Capital allotment</span>
            <div className="flex gap-3 text-xs">
              <label className="flex cursor-pointer items-center gap-1.5">
                <input
                  type="radio"
                  checked={capitalMode === "FIXED"}
                  onChange={() => setCapitalMode("FIXED")}
                />
                Fixed USDT
              </label>
              <label className="flex cursor-pointer items-center gap-1.5">
                <input type="radio" checked={capitalMode === "PCT"} onChange={() => setCapitalMode("PCT")} />% of wallet
              </label>
            </div>
            {capitalMode === "FIXED" ? (
              <input
                type="number"
                min={0}
                step="any"
                className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-600 dark:bg-slate-950"
                value={capitalUsdt}
                onChange={(e) => setCapitalUsdt(e.target.value)}
              />
            ) : (
              <input
                type="number"
                min={0}
                max={100}
                step="any"
                className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-600 dark:bg-slate-950"
                value={capitalPct}
                onChange={(e) => setCapitalPct(e.target.value)}
              />
            )}
          </div>
          {headroom != null ? (
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs dark:border-slate-700 dark:bg-slate-800/50">
              <div className="flex justify-between gap-2">
                <span className="text-slate-600 dark:text-slate-400">Wallet available (snapshot)</span>
                <span className="font-mono">${headroom.availableUsdt.toFixed(2)}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-600 dark:text-slate-400">Committed (other instances)</span>
                <span className="font-mono">${headroom.committedUsdt.toFixed(2)}</span>
              </div>
              <div className="flex justify-between gap-2 font-medium">
                <span>Headroom</span>
                <span className="font-mono">${headroom.headroomUsdt.toFixed(2)}</span>
              </div>
              {remainingAfter != null ? (
                <div
                  className={clsx(
                    "mt-1 flex justify-between gap-2 border-t border-slate-200 pt-1 dark:border-slate-600",
                    overCap && "text-rose-600 dark:text-rose-400",
                  )}
                >
                  <span>After this allotment</span>
                  <span className="font-mono">${remainingAfter.toFixed(2)}</span>
                </div>
              ) : null}
            </div>
          ) : headroom === null ? (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {headroomError || "No wallet snapshot yet — fund / connect account first."}
            </p>
          ) : null}
          <p className="text-xs text-slate-600 dark:text-slate-400">
            Capital is reserved on create. Start the bot manually when ready.
          </p>
          {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : null}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-slate-700 dark:border-slate-600 dark:text-slate-200"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || overCap || versionOptions.length === 0}
              className="rounded-lg bg-sky-600 px-3 py-1.5 font-medium text-white disabled:opacity-50"
            >
              {submitting ? "Creating…" : "Create instance"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
