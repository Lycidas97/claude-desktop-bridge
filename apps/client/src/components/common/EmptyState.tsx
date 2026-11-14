import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className = "session-catalog-loading" }: EmptyStateProps) {
  return (
    <div className={className}>
      {icon}
      <strong>{title}</strong>
      {description && <span>{description}</span>}
      {action}
    </div>
  );
}
