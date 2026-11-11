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

// Safari chrome / task-switcher tint per family × mode.
const META_THEME_COLOR: Record<ThemeFamily, Record<Theme, string>> = {
  sunstone: { light: "#f6f4f0", dark: "#000000" },
  apple: { light: "#f2f2f7", dark: "#000000" },
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
    localStorage.setItem(THEME_KEY, theme);
    localStorage.setItem(FAMILY_KEY, family);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", META_THEME_COLOR[family][theme]);
    if (Capacitor.getPlatform() === "android") {
      void SystemBars.setStyle({ style: theme === "dark" ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
    }
  }, [theme, family]);
  const toggleTheme = useCallback(() => setTheme((value) => (value === "dark" ? "light" : "dark")), []);
  return { theme, family, fontSize, setTheme, setFamily, setFontSize, toggleTheme };
}
