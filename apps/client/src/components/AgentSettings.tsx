import type { BridgeHostSnapshot } from "@bridge/protocol";
import { AGENT_IDS, type AgentVisibilityControl } from "../hooks/useAgentVisibility.js";
import { desktopRuntimeName } from "../lib/runtime-labels.js";

export function AgentSettings({ control, snapshot }: { control: AgentVisibilityControl; snapshot?: BridgeHostSnapshot }) {
  return (
    <section className="mobile-settings-group agent-settings" aria-label="Agent 显示设置">
      <h2>Agent 显示</h2>
      <p className="detail-text">默认只显示 Claude。勾选其他 Agent 后，就绪时才会出现在会话、新建和电脑控制中。设置保存在当前设备。</p>
      {AGENT_IDS.map((id) => {
        const runtime = snapshot?.runtimes?.find((candidate) => candidate.id === id);
        return (
          <label className="mobile-settings-row" key={id}>
            <span><strong>{desktopRuntimeName(id)}</strong><small>{id === "claude-desktop" ? "始终显示" : runtime?.state === "ready" ? "已就绪" : "未连接或未就绪，主界面隐藏"}</small></span>
            <input type="checkbox" aria-label={`显示 ${desktopRuntimeName(id)}`} checked={control.enabled.includes(id)} disabled={id === "claude-desktop"} onChange={(event) => control.setEnabled(id, event.target.checked)} />
          </label>
        );
      })}
    </section>
  );
}
