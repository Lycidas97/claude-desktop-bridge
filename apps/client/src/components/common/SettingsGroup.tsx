import type { ReactNode } from "react";

export function SettingsGroup({ title, titleId, label, children }: {
  title: ReactNode;
  titleId?: string;
  label?: string;
  children: ReactNode;
}) {
  return <section className="mobile-settings-group" aria-labelledby={titleId} aria-label={label}>
    <h2 id={titleId}>{title}</h2>
    {children}
  </section>;
}
