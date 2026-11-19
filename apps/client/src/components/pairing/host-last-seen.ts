export function formatHostLastSeen(lastSeenAt: number | undefined): string | undefined {
  if (!lastSeenAt) return undefined;
  const elapsed = Math.max(0, Date.now() - lastSeenAt);
  if (elapsed < 60_000) return "刚刚活跃";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(lastSeenAt);
}
