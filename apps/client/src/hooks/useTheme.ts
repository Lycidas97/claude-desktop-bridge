import { useCallback, useEffect, useState } from "react";
import { Capacitor, SystemBars, SystemBarsStyle } from "@capacitor/core";

export type Theme = "light" | "dark";

// V0.9.2: themes are family × mode. "sunstone" is the original Bridge
// baseline; "apple" is an independent Apple-HIG family. Neither family reads
// a token from the other, so they can evolve separately.
export type ThemeFamily = "sunstone" | "apple";
export const FONT_SIZES = ["small", "standard", "large", "larger"] as const;
export type FontSize = typeof FONT_SIZES[number];
export type EffectiveScale = "normal" | "large" | "xlarge";

export const FONT_SCALE_BY_SIZE: Record<FontSize, number> = {
  small: 0.9,
  standard: 1,
  large: 1.15,
  larger: 1.3,
};

export interface ThemeControl {
  theme: Theme;
  family: ThemeFamily;
  setTheme(theme: Theme): void;
  setFamily(family: ThemeFamily): void;
  toggleTheme(): void;
  fontSize?: FontSize;
  setFontSize?(fontSize: FontSize): void;
  effectiveScale?: EffectiveScale;
}

const THEME_KEY = "bridge-theme";
const FAMILY_KEY = "bridge-theme-family";
const FONT_SIZE_KEY = "bridge-font-size";

export function scaleForFontSize(fontSize: FontSize): number {
  return FONT_SCALE_BY_SIZE[fontSize];
}

export function classifyEffectiveScale(multiplier: number): EffectiveScale {
  if (multiplier >= 1.28) return "xlarge";
  if (multiplier >= 1.13) return "large";
  return "normal";
}

/**
 * Measures OS / WebView system text magnification (e.g. Android WebSettings.setTextZoom
 * or root font magnification) via a 100px offscreen probe. Defaults to 1 in non-layout
 * test environments (such as jsdom where getBoundingClientRect().height === 0).
 */
export function measureSystemTextZoom(): number {
  if (
    typeof document === "undefined"
    || !document.body
    || typeof document.createElement !== "function"
    || typeof document.body.appendChild !== "function"
  ) {
    return 1;
  }
  const probe = document.createElement("span");
  probe.textContent = "M";
  probe.setAttribute?.("aria-hidden", "true");
  if (probe.style) {
    probe.style.cssText = "position:fixed;left:-9999px;top:-9999px;font:400 100px/1 sans-serif;padding:0;margin:0;border:0;pointer-events:none;visibility:hidden;";
  }
  document.body.appendChild(probe);
  const rect = typeof probe.getBoundingClientRect === "function" ? probe.getBoundingClientRect() : undefined;
  if (typeof probe.remove === "function") probe.remove();
  else if (typeof document.body.removeChild === "function") document.body.removeChild(probe);
  const height = rect?.height ?? 0;
  if (!Number.isFinite(height) || height <= 0) return 1;
  const measured = Math.round((height / 100) * 100) / 100;
  return Math.min(2.5, Math.max(0.75, measured));
}

export function resolveTypographyScale(fontSize: FontSize, systemTextZoom: number): {
  appliedFontScale: number;
  effectiveMultiplier: number;
  effectiveScale: EffectiveScale;
} {
  const userScale = scaleForFontSize(fontSize);
  const rawCombined = systemTextZoom * userScale;
  // Soften double-compounding when OS textZoom is already enlarged and user also picks large/larger.
  const dampedCombined = systemTextZoom > 1.08 && userScale > 1 && rawCombined > 1.48
    ? Math.min(rawCombined, 1.48 + (rawCombined - 1.48) * 0.35)
    : rawCombined;
  const appliedFontScale = Math.round((dampedCombined / (systemTextZoom || 1)) * 1000) / 1000;
  return {
    appliedFontScale,
    effectiveMultiplier: dampedCombined,
    effectiveScale: classifyEffectiveScale(dampedCombined),
  };
}

function safeStorageGet(key: string): string | null {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") {
      return null;
    }
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(key: string, value: string): void {
  try {
    if (typeof localStorage === "undefined" || typeof localStorage.setItem !== "function") {
      return;
    }
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota or private-mode restrictions.
  }
}

function initialFontSize(): FontSize {
  const stored = safeStorageGet(FONT_SIZE_KEY);
  return FONT_SIZES.find(size => size === stored) ?? "standard";
}

function initialTheme(): Theme {
  const stored = safeStorageGet(THEME_KEY);
  if (stored === "light" || stored === "dark") return stored;
  // V0.8.0: dark is the flagship theme (Sunstone baseline); returning users
  // keep their stored choice, new users land on dark.
  return "dark";
}

function initialFamily(): ThemeFamily {
  const stored = safeStorageGet(FAMILY_KEY);
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
  const [systemTextZoom, setSystemTextZoom] = useState<number>(measureSystemTextZoom);
  const { appliedFontScale, effectiveScale } = resolveTypographyScale(fontSize, systemTextZoom);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.fontSize = fontSize;
    root.dataset.effectiveScale = effectiveScale;
    if (systemTextZoom !== 1) {
      root.style?.setProperty?.("--font-scale", String(appliedFontScale));
    } else {
      root.style?.removeProperty?.("--font-scale");
    }
    safeStorageSet(FONT_SIZE_KEY, fontSize);
  }, [appliedFontScale, effectiveScale, fontSize, systemTextZoom]);

  useEffect(() => {
    const refreshSystemZoom = () => {
      const measured = measureSystemTextZoom();
      setSystemTextZoom((previous) => (previous === measured ? previous : measured));
    };
    refreshSystemZoom();
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("resize", refreshSystemZoom);
    }
    if (typeof document !== "undefined" && typeof document.addEventListener === "function") {
      document.addEventListener("visibilitychange", refreshSystemZoom);
    }
    return () => {
      if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
        window.removeEventListener("resize", refreshSystemZoom);
      }
      if (typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", refreshSystemZoom);
      }
    };
  }, []);

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
    safeStorageSet(THEME_KEY, theme);
    safeStorageSet(FAMILY_KEY, family);
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
  return { theme, family, fontSize, effectiveScale, setTheme, setFamily, setFontSize, toggleTheme };
}
