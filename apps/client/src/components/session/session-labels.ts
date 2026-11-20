import type { BridgeSDKPermissionMode } from "@bridge/protocol";

// The conversation header, session settings, new chat, /permissions and approval cards share these names.
export const PERMISSION_MODE_LABELS: Record<BridgeSDKPermissionMode, string> = {
  default: "逐个确认",
  acceptEdits: "自动接受编辑",
  plan: "计划模式",
  auto: "自动模式",
  dontAsk: "仅允许已批准",
  bypassPermissions: "完全授权",
};

export const PERMISSION_MODE_OPTIONS = (Object.keys(PERMISSION_MODE_LABELS) as BridgeSDKPermissionMode[])
  .map(value => ({ value, label: PERMISSION_MODE_LABELS[value] }));

const EFFORT_LABELS: Record<string, string> = {
  none: "关闭",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "超高",
};

export function effortLabel(value: string): string {
  return Object.hasOwn(EFFORT_LABELS, value) ? EFFORT_LABELS[value]! : value;
}
