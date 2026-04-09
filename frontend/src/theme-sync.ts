import { THEME_STORAGE_KEY } from "./themeStore";

/** Apply persisted theme class before React paints (matches zustand persist key/shape). */
export function syncThemeFromStorage(): void {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const theme = parsed?.state?.theme === "light" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", theme === "dark");
  } catch {
    document.documentElement.classList.add("dark");
  }
}
