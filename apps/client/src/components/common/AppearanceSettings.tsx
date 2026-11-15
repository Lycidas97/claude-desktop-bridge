import { Moon, Sun } from "lucide-react";
import { FONT_SIZES, type ThemeControl } from "../../hooks/useTheme.js";
import { SettingsGroup } from "./SettingsGroup.js";

export function AppearanceSettings({ themeControl }: { themeControl: ThemeControl }) {
  return <SettingsGroup title="外观" titleId="appearance-title">
    <div className="mobile-settings-row"><span>显示模式</span><div className="segmented" role="group" aria-label="显示模式">
      <button type="button" className={themeControl.theme === "light" ? "active" : ""} aria-pressed={themeControl.theme === "light"} onClick={() => themeControl.setTheme("light")}><Sun size={16} /><span>浅色</span></button>
      <button type="button" className={themeControl.theme === "dark" ? "active" : ""} aria-pressed={themeControl.theme === "dark"} onClick={() => themeControl.setTheme("dark")}><Moon size={16} /><span>深色</span></button>
    </div></div>
    <div className="mobile-settings-row"><span>风格</span><div className="segmented" role="group" aria-label="主题风格">
      <button type="button" className={themeControl.family === "sunstone" ? "active" : ""} aria-pressed={themeControl.family === "sunstone"} onClick={() => themeControl.setFamily("sunstone")}>Sunstone</button>
      <button type="button" className={themeControl.family === "apple" ? "active" : ""} aria-pressed={themeControl.family === "apple"} onClick={() => themeControl.setFamily("apple")}>Apple</button>
    </div></div>
    <div className="mobile-settings-row font-size-settings-row"><span>字号</span><div className="segmented" role="group" aria-label="字号">
      {FONT_SIZES.map(size => <button type="button" key={size} className={(themeControl.fontSize ?? "standard") === size ? "active" : ""} aria-pressed={(themeControl.fontSize ?? "standard") === size} onClick={() => themeControl.setFontSize?.(size)}>{({ small: "小", standard: "标准", large: "大", larger: "更大" })[size]}</button>)}
    </div></div>
  </SettingsGroup>;
}
