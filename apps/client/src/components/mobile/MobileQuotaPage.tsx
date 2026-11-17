import { useEffect, useRef } from "react";
import { MagpieQuotaDashboard, useOptionalMagpieQuota } from "../../../../../plugins/magpie-quota/client.js";
import { registerMobileBackHandler } from "../../lib/mobile-back-navigation.js";
import { MobilePageHeader } from "./MobilePageHeader.js";

const initialRefreshedQuotaHosts = new Set<string>();

export function clearInitialRefreshedQuotaHost(hostId: string): void {
  initialRefreshedQuotaHosts.delete(hostId);
}

export function resetInitialRefreshedQuotaHostsForTest(): void {
  initialRefreshedQuotaHosts.clear();
}

export function shouldFallbackAutoQuotaRefresh(errorMessage: string): boolean {
  return /只读|不支持.*刷新|read-?only|refresh.*not.*supported/iu.test(errorMessage);
}

/** Settings → Magpie 额度: the plugin's dashboard for the active computer. */
export function MobileQuotaPage({
  hostId,
  desktopName,
  onBeforeAutoRefresh,
  onBack,
}: {
  hostId?: string | undefined;
  desktopName: string;
  onBeforeAutoRefresh?: (() => void) | undefined;
  onBack(): void;
}) {
  const quota = useOptionalMagpieQuota(false);
  const attemptedOpenRefreshRef = useRef(false);
  const previousHostRef = useRef(hostId);
  if (previousHostRef.current !== hostId) {
    previousHostRef.current = hostId;
    attemptedOpenRefreshRef.current = false;
  }

  useEffect(() => registerMobileBackHandler(() => {
    onBack();
    return true;
  }, 50), [onBack]);

  useEffect(() => {
    if (!quota?.enabled || attemptedOpenRefreshRef.current) return;
    const hostKey = hostId ?? "__fallback_host__";
    const needsFirstHostRefresh = !initialRefreshedQuotaHosts.has(hostKey);
    const needsUnsupportedRetry = quota.snapshot?.status === "unsupported";
    if (!needsFirstHostRefresh && !needsUnsupportedRetry) return;
    attemptedOpenRefreshRef.current = true;
    initialRefreshedQuotaHosts.add(hostKey);
    onBeforeAutoRefresh?.();
    quota.refresh();
  }, [hostId, onBeforeAutoRefresh, quota?.enabled, quota?.refresh, quota?.snapshot?.status]);

  return (
    <main className="mobile-workspace mobile-settings-page">
      <MobilePageHeader title="Magpie 额度" subtitle={desktopName} onBack={onBack} backLabel="返回设置" />
      <div className="mobile-settings-content">
        <MagpieQuotaDashboard />
      </div>
    </main>
  );
}
