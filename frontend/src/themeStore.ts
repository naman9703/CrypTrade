import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export const THEME_STORAGE_KEY = "trading-ui-theme";

export type UiTheme = "light" | "dark";

function applyDomTheme(theme: UiTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export const useThemeStore = create(
  persist<{ theme: UiTheme; setTheme: (t: UiTheme) => void }>(
    (set) => ({
      theme: "dark",
      setTheme: (t) => {
        applyDomTheme(t);
        set({ theme: t });
      },
    }),
    {
      name: THEME_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ theme: s.theme }),
      onRehydrateStorage: () => (state) => {
        if (state) applyDomTheme(state.theme);
      },
    },
  ),
);
