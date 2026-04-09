import { useEffect, useRef, useState } from "react";
import { clsx } from "clsx";
import { useThemeStore } from "../themeStore";

export function ThemeToggle() {
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  return (
    <div ref={rootRef} className="relative z-10 inline-flex">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Choose color theme"
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          "flex h-11 w-11 items-center justify-center rounded-full border shadow-lg transition",
          "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
          "dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700",
        )}
      >
        <span className="text-lg leading-none" aria-hidden>
          {theme === "dark" ? "☾" : "☀"}
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className={clsx(
            "absolute bottom-full right-0 mb-2 min-w-[9rem] rounded-lg border py-1 shadow-xl",
            "border-slate-200 bg-white text-slate-800",
            "dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100",
          )}
        >
          <button
            type="button"
            role="menuitem"
            className={clsx(
              "flex w-full px-3 py-2 text-left text-sm hover:bg-slate-100",
              "dark:hover:bg-slate-800",
              theme === "light" && "bg-slate-100 font-semibold dark:bg-slate-800",
            )}
            onClick={() => {
              setTheme("light");
              setOpen(false);
            }}
          >
            Light
          </button>
          <button
            type="button"
            role="menuitem"
            className={clsx(
              "flex w-full px-3 py-2 text-left text-sm hover:bg-slate-100",
              "dark:hover:bg-slate-800",
              theme === "dark" && "bg-slate-100 font-semibold dark:bg-slate-800",
            )}
            onClick={() => {
              setTheme("dark");
              setOpen(false);
            }}
          >
            Dark
          </button>
        </div>
      ) : null}
    </div>
  );
}
