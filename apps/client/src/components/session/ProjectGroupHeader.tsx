import { ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

interface ProjectGroupHeaderProps {
  title: string;
  count: number;
  expanded: boolean;
  controlsId: string;
  onToggle(): void;
  actions?: ReactNode;
}

export function ProjectGroupHeader({ title, count, expanded, controlsId, onToggle, actions }: ProjectGroupHeaderProps) {
  return (
    <div className="project-group-header">
      <button
        type="button"
        className="project-group-open"
        aria-expanded={expanded}
        aria-controls={controlsId}
        onClick={onToggle}
      >
        <span className="project-group-toggle-copy">
          <span>
            <strong>{title}</strong>
            <b className="project-count-pill">{count}</b>
          </span>
        </span>
        <span className="project-group-chevron">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {actions && <div className="project-group-actions">{actions}</div>}
    </div>
  );
}
