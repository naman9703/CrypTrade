import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api/client";
import { AuthActionsContext } from "../authContext";
import { forceDisconnectWebSocket, useAppStore } from "../ws/store";
import { AiTradeMotionVisual } from "./AiTradeMotionVisual";
import { LoginTypingIntro } from "./LoginTypingIntro";
import { App } from "./App";

const LOGIN_VISUAL_MS = 120_000;

export function AuthShell() {
  const [phase, setPhase] = useState<"loading" | "app" | "login">("loading");
  const [authEnabled, setAuthEnabled] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await api.authMe();
      const enabled = Boolean(r?.enabled);
      setAuthEnabled(enabled);
      if (!enabled) {
        setPhase("app");
        return;
      }
      setPhase(r?.authenticated ? "app" : "login");
    } catch {
      setPhase("login");
      setAuthEnabled(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* still clear UI */
    }
    forceDisconnectWebSocket();
    setPhase("login");
  }, []);

  if (phase === "loading") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-200">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-sky-500 dark:border-slate-700 dark:border-t-sky-400" />
        <p className="text-sm">Loading…</p>
      </div>
    );
  }

  if (phase === "login") {
    return (
      <LoginScreen
        onSuccess={() => {
          void refresh().then(() => {
            queueMicrotask(() => useAppStore.getState().connect());
          });
        }}
      />
    );
  }

  return (
    <AuthActionsContext.Provider
      value={authEnabled ? { gated: true, logout } : { gated: false, logout: async () => {} }}
    >
      <App />
    </AuthActionsContext.Provider>
  );
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await api.login(email.trim(), password);
      setPassword("");
      onSuccess();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Login failed";
      setErr(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative isolate flex min-h-screen flex-col overflow-hidden bg-slate-100 dark:bg-slate-950">
      <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
        <div
          className="absolute inset-0 scale-105 bg-cover bg-center bg-no-repeat opacity-80 blur-[4px]"
          style={{ backgroundImage: "url('/graph.webp')" }}
        />
        <div className="absolute inset-0 bg-black/50" />
      </div>
      <header className="relative z-10 flex shrink-0 justify-center px-4 pt-8 pb-2 sm:pt-10 sm:pb-4">
        <div className="flex items-center justify-center gap-3">
          <img
            src="/logo-light.webp"
            alt="AI Trading"
            width={240}
            height={48}
            className="h-10 w-auto max-h-10 object-contain dark:hidden sm:h-12 sm:max-h-12"
            decoding="async"
          />
          <img
            src="/logo-dark.webp"
            alt="AI Trading"
            width={240}
            height={48}
            className="hidden h-10 w-auto max-h-10 object-contain dark:block sm:h-12 sm:max-h-12"
            decoding="async"
          />
        </div>
      </header>

      <div className="relative z-10 flex flex-1 flex-col justify-center px-4 py-8 pb-12 sm:py-10 sm:pb-16">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-10 lg:flex-row lg:items-center lg:justify-center lg:gap-14 xl:gap-20">
          <div className="flex w-full max-w-md flex-col items-center gap-6 text-center lg:max-w-lg">
            <LoginTypingIntro />
            <div className="flex w-full justify-center">
              <AiTradeMotionVisual continuousPlayMs={LOGIN_VISUAL_MS} />
            </div>
          </div>

          <div className="w-full max-w-md shrink-0 lg:w-[420px]">
            <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-lg dark:border-slate-800 dark:bg-slate-900 sm:p-8">
              <h1 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Sign in</h1>
              <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Authorized users only</p>
              <form className="mt-6 space-y-4" onSubmit={onSubmit}>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Email
                  <input
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                  />
                </label>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Password
                  <input
                    type="password"
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100"
                  />
                </label>
                {err ? <p className="text-xs text-rose-600 dark:text-rose-400">{err}</p> : null}
                <button
                  type="submit"
                  disabled={busy}
                  className="w-full rounded-lg bg-sky-600 py-2.5 text-sm font-semibold text-white hover:bg-sky-500 disabled:opacity-60"
                >
                  {busy ? "Signing in…" : "Sign in"}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
