import { useEffect } from "react";
import { MagpieQuotaDashboard } from "../../../../../plugins/magpie-quota/client.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { MobilePageHeader } from "./MobilePageHeader.js";

/** Settings → Magpie 额度: the plugin's dashboard for the active computer. */
export function MobileQuotaPage({ desktopName, onBack }: { desktopName: string; onBack(): void }) {
  useEffect(() => registerMobileBackHandler(() => {
    onBack();
    return true;
  }, 50), [onBack]);
  return (
    <main className="mobile-workspace mobile-settings-page">
      <MobilePageHeader title="Magpie 额度" subtitle={desktopName} onBack={onBack} backLabel="返回设置" />
      <div className="mobile-settings-content">
        <MagpieQuotaDashboard />
      </div>
    </main>
  );
}
