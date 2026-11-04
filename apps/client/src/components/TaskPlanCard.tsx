import type { BridgeTaskPlan } from "@bridge/protocol";
import { CheckCircle2, ChevronDown, Circle, ListChecks, LoaderCircle } from "lucide-react";

export function TaskPlanCard({ plan }: { plan: BridgeTaskPlan }) {
  const completed = plan.items.filter((item) => item.status === "completed").length;
  const complete = plan.items.length > 0 && completed === plan.items.length;
  return (
    <details className={`task-plan-card${complete ? " is-complete" : ""}`} open={!complete}>
      <summary>
        <ListChecks size={16} aria-hidden="true" />
        <strong>任务计划</strong>
        <span className="task-plan-progress">{completed}/{plan.items.length} 已完成</span>
        <ChevronDown size={14} className="task-plan-chevron" aria-hidden="true" />
      </summary>
      <ol className="task-plan-items">
        {plan.items.map((item, index) => (
          <li className={`task-plan-row ${item.status}`} key={index}>
            <span className="task-plan-status" role="img" aria-label={
              item.status === "completed" ? "已完成" : item.status === "in_progress" ? "进行中" : "待处理"
            }>
              {item.status === "completed" ? <CheckCircle2 size={16} aria-hidden="true" />
                : item.status === "in_progress" ? <LoaderCircle size={16} className="is-spinning" aria-hidden="true" />
                  : <Circle size={16} aria-hidden="true" />}
            </span>
            <span className="task-plan-content">{item.content}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
