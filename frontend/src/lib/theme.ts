// Light/dark theme: a class on <html> (styles in index.css) plus the matching
// Monaco theme. The choice is remembered; the default follows the OS.
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";

const KEY = "grpcui:theme";
const listeners = new Set<() => void>();

function initial(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === "light" || saved === "dark") return saved;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

let current = initial();
apply(current);

function apply(theme: Theme) {
  document.documentElement.classList.toggle("light", theme === "light");
  document.documentElement.classList.toggle("dark", theme === "dark");
}

export function setTheme(theme: Theme) {
  current = theme;
  localStorage.setItem(KEY, theme);
  apply(theme);
  listeners.forEach((l) => l());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

export const monacoTheme = (theme: Theme) => (theme === "light" ? "grpcui-light" : "grpcui-dark");
