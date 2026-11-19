export const ASSISTANT_AGENDA_CAPABILITY = "plugin.assistant-agenda.v1";

export interface BridgeAgendaSource {
  id: string;
  label: string;
  enabled: boolean;
  writable: boolean;
  configurable: boolean;
  status: "ready" | "pending" | "disabled" | "error";
  errorCode?: "credentials" | "connection" | "response";
  refreshedAt?: string | undefined;
}

export interface BridgeAgendaSnapshot {
  changeToken: string;
  credentialsSupported: boolean;
  sources: BridgeAgendaSource[];
}

export interface AgendaTodoInput {
  title: string;
  notes?: string | undefined;
  priority?: number | undefined;
  dueAt?: string | undefined;
  remindAt?: string | undefined;
  status: "pending" | "in-progress" | "completed" | "cancelled";
  mailRefId?: string | undefined;
}

export interface AgendaEventInput {
  title: string;
  notes?: string | undefined;
  startAt: string;
  endAt: string;
  timeZone: string;
  allDay: boolean;
  location?: string | undefined;
}

export interface AgendaRecordIdentity {
  id: string;
  sourceId: string;
  collection: string;
  revision: number;
  uid: string;
  resourceHref?: string | undefined;
  etag?: string | undefined;
  recurrenceId?: string | undefined;
  origin: "user_local" | "untrusted_external";
}

export interface BridgeAgendaTodo extends AgendaTodoInput, AgendaRecordIdentity {}
export interface BridgeAgendaEvent extends AgendaEventInput, AgendaRecordIdentity {
  attendees?: string[];
  busy: boolean;
}

export interface AgendaPageQuery {
  cursor?: string | undefined;
  limit?: number | undefined;
}

export interface AgendaWindow {
  from: string;
  to: string;
}

export interface AgendaPage<T> {
  records: T[];
  nextCursor?: string | undefined;
}
