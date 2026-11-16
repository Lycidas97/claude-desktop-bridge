import { useCallback, useEffect, useState } from "react";
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";

export type Theme = "light" | "dark";

// V0.9.2: themes are family × mode. "sunstone" is the original Bridge
// baseline; "apple" is an independent Apple-HIG family. Neither family reads
// a token from the other, so they can evolve separately.
export type ThemeFamily = "sunstone" | "apple";
export const FONT_SIZES = ["small", "standard", "large", "larger"] as const;
export type FontSize = typeof FONT_SIZES[number];

export interface ThemeControl {
  theme: Theme;
  family: ThemeFamily;
  setTheme(theme: Theme): void;
  setFamily(family: ThemeFamily): void;
  toggleTheme(): void;
  fontSize?: FontSize;
  setFontSize?(fontSize: FontSize): void;
}

const THEME_KEY = "bridge-theme";
const FAMILY_KEY = "bridge-theme-family";
const FONT_SIZE_KEY = "bridge-font-size";

function initialFontSize(): FontSize {
  const stored = localStorage.getItem(FONT_SIZE_KEY);
  return FONT_SIZES.find(size => size === stored) ?? "standard";
}

function initialTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // V0.8.0: dark is the flagship theme (Sunstone baseline); returning users
  // keep their stored choice, new users land on dark.
  return "dark";
}

function initialFamily(): ThemeFamily {
  const stored = localStorage.getItem(FAMILY_KEY);
  if (stored === "sunstone" || stored === "apple") return stored;
  return "sunstone";
}

// Exact canvas --bg hex per family × mode so Electron's did-change-theme-color
// and mobile system chrome match the active workspace background seamlessly.
export const META_THEME_COLOR: Record<ThemeFamily, Record<Theme, string>> = {
  sunstone: { light: "#faf9f5", dark: "#191816" },
  apple: { light: "#ffffff", dark: "#1c1c1e" },
};

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [family, setFamily] = useState<ThemeFamily>(initialFamily);
  const [fontSize, setFontSize] = useState<FontSize>(initialFontSize);
  useEffect(() => {
    document.documentElement.dataset.fontSize = fontSize;
    localStorage.setItem(FONT_SIZE_KEY, fontSize);
  }, [fontSize]);
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.themeFamily = family;
    if (
      typeof window !== "undefined"
      && Boolean((window as Window & { bridgeDesktop?: unknown }).bridgeDesktop)
      && typeof navigator !== "undefined"
      && /Mac/i.test(navigator.platform || navigator.userAgent || "")
    ) {
      root.dataset.macDesktop = "true";
    }
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(FAMILY_KEY, family);
    const color = META_THEME_COLOR[family][theme];
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta && document.head) {
      meta = document.createElement("meta");
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    meta?.setAttribute("content", color);
    if (Capacitor.getPlatform() === "android") {
      void SystemBars.setStyle({ style: theme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
    }
  }, [theme, family]);
  const toggleTheme = useCallback(() => setTheme((value) => (value === "dark" ? "light" : "dark")), []);
  return { theme, family, fontSize, setTheme, setFamily, setFontSize, toggleTheme };
}
