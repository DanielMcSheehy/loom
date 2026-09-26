// Theme: explicit choice persisted in localStorage, otherwise follows the OS.
import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "loom.theme";

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function readTheme(): { theme: Theme; explicit: boolean } {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") return { theme: stored, explicit: true };
  } catch {
    /* storage unavailable */
  }
  return { theme: systemTheme(), explicit: false };
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(() => readTheme().theme);
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => {
      if (!readTheme().explicit) setThemeState(systemTheme());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* ignore */
    }
    setThemeState(t);
  }, []);
  const toggle = useCallback(() => setTheme(theme === "dark" ? "light" : "dark"), [theme, setTheme]);
  return { theme, setTheme, toggle };
}
