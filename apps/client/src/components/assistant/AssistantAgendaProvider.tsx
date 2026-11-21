import { ASSISTANT_AGENDA_CAPABILITY, ASSISTANT_AGENDA_DAY_CAPABILITY, type AgendaDueDay, type AgendaPage, type AgendaWindow, type BridgeAgendaEvent, type BridgeAgendaSnapshot, type BridgeAgendaTodo, type BridgeHostSnapshot, type BridgeMethod, type BridgeResponse } from "@bridge/protocol";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { agendaInputTime, rereadAgendaPages } from "../../lib/assistant-agenda.js";
import type { AssistantRequest } from "./AssistantMailProvider.js";

export const agendaDeviceZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

type AgendaList = "plugin.assistant-agenda.todo.list" | "plugin.assistant-agenda.event.list";
type AgendaMutation = Exclude<Extract<BridgeMethod, `plugin.assistant-agenda.${string}`>, AgendaList>;

function agendaResult<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw new Error(response?.error?.message ?? "议程请求失败");
  return response.result as T;
}

function useAgendaPages<T>(method: AgendaList, request: AssistantRequest, online: boolean, token: string, params?: (AgendaWindow & { allDayOn?: string }) | { dueOn: AgendaDueDay }) {
  const filter = params && JSON.stringify(params);
  const [cache, setCache] = useState<(AgendaPage<T> & { pages: number; filter: string | undefined })>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const operation = useRef<AbortController | undefined>(undefined);
  const page = cache?.filter === filter ? cache : undefined;

  async function read(cursor?: string): Promise<AgendaPage<T>> {
    return agendaResult<{ agendaPage: AgendaPage<T> }>(await request(method, {
      ...params, ...(cursor ? { cursor } : {}),
    })).agendaPage;
  }

  async function run(load: () => Promise<AgendaPage<T> & { pages: number }>, signal: AbortSignal): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const result = await load();
      if (!signal.aborted) setCache({ ...result, filter });
    } catch (reason) {
      if (!signal.aborted) setError(reason instanceof Error ? reason.message : "议程读取失败");
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    if (!online) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    operation.current = controller;
    void run(() => rereadAgendaPages(read, page?.pages ?? 1, controller.signal), controller.signal);
    return () => controller.abort();
  }, [online, token, request, filter, retry]);

  return {
    records: page?.records ?? [],
    hasMore: Boolean(page?.nextCursor),
    incomplete: page?.incomplete,
    loading,
    error,
    retry: () => setRetry(value => value + 1),
    loadMore() {
      const signal = operation.current?.signal;
      if (!online || loading || !page?.nextCursor || !signal || signal.aborted) return;
      void run(async () => {
        const next = await read(page.nextCursor);
        return { ...next, ...(page.incomplete ? { incomplete: page.incomplete } : {}), pages: page.pages + 1, records: [...page.records, ...next.records] };
      }, signal);
    },
  };
}

interface AssistantAgendaState {
  snapshot: BridgeAgendaSnapshot | undefined;
  online: boolean;
  todos: ReturnType<typeof useAgendaPages<BridgeAgendaTodo>>;
  events: ReturnType<typeof useAgendaPages<BridgeAgendaEvent>>;
  date: Date;
  today: string;
  openToday(): void;
  calendarOnly: boolean;
  daySupported: boolean;
  setCalendarOnly(value: boolean): void;
  selectDate(date: Date): void;
  allTodos: ReturnType<typeof useAgendaPages<BridgeAgendaTodo>>;
  allTodosOpen: boolean;
  setAllTodosOpen(open: boolean): void;
  mutate(method: AgendaMutation, params: Record<string, unknown>): Promise<void>;
}

const AssistantAgendaContext = createContext<AssistantAgendaState | undefined>(undefined);
export function useAssistantAgenda(): AssistantAgendaState | undefined { return useContext(AssistantAgendaContext); }

/** Mounted under the host-keyed Assistant boundary. Lists are loaded on first use. */
export function AssistantAgendaProvider({ snapshot, online, request, children }: {
  snapshot: BridgeHostSnapshot | undefined;
  online: boolean;
  request: AssistantRequest;
  children: ReactNode;
}) {
  const [today, setToday] = useState(() => new Date());
  const [selectedDay, setSelectedDay] = useState<Date | "today">();
  const day = selectedDay === "today" ? today : selectedDay;
  const todayKey = agendaInputTime(today.toISOString(), agendaDeviceZone).slice(0, 10);
  const [month, setMonth] = useState<Date>();
  const [calendarOnly, setCalendarOnly] = useState(false);
  const [allTodosOpen, setAllTodosOpen] = useState(false);
  const [mutation, setMutation] = useState<{ base: string | undefined; snapshot: BridgeAgendaSnapshot }>();
  const enabled = snapshot?.host.capabilities.includes(ASSISTANT_AGENDA_CAPABILITY) === true;
  const hostAgenda = snapshot?.assistantAgenda;
  const agenda = mutation && hostAgenda?.changeToken === mutation.base ? mutation.snapshot : hostAgenda;
  const token = agenda?.recordsToken ?? agenda?.changeToken ?? "";
  const connected = enabled && online;
  const daySupported = snapshot?.host.capabilities.includes(ASSISTANT_AGENDA_DAY_CAPABILITY) === true;
  const dayKey = day && agendaInputTime(day.toISOString(), agendaDeviceZone).slice(0, 10);
  const date = calendarOnly ? month ?? day : day;
  useEffect(() => {
    function refreshToday() { if (!document.hidden) setToday(new Date()); }
    document.addEventListener("visibilitychange", refreshToday);
    return () => document.removeEventListener("visibilitychange", refreshToday);
  }, []);
  const opened = connected && date !== undefined;
  const window = date && {
    from: new Date(date.getFullYear(), date.getMonth(), calendarOnly ? 1 : date.getDate()).toISOString(),
    to: (calendarOnly ? new Date(date.getFullYear(), date.getMonth() + 1, 1)
      : new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1)).toISOString(),
  };
  const activeDay = !calendarOnly && dayKey && daySupported ? dayKey : undefined;
  const events = useAgendaPages<BridgeAgendaEvent>("plugin.assistant-agenda.event.list", request, opened, token,
    window && { ...window, ...(activeDay ? { allDayOn: activeDay } : {}) });
  const todos = useAgendaPages<BridgeAgendaTodo>("plugin.assistant-agenda.todo.list", request, opened && Boolean(activeDay), token,
    activeDay && window ? { dueOn: { ...window, date: activeDay } } : undefined);
  const allTodos = useAgendaPages<BridgeAgendaTodo>("plugin.assistant-agenda.todo.list", request,
    opened && !calendarOnly && (dayKey === todayKey || allTodosOpen || !daySupported), token);

  return <AssistantAgendaContext.Provider value={enabled ? {
    snapshot: agenda,
    online: connected,
    todos: daySupported ? todos : allTodos, events, daySupported,
    date: date ?? today, today: todayKey, calendarOnly, setCalendarOnly, allTodos, allTodosOpen, setAllTodosOpen,
    openToday() {
      setToday(new Date());
      setSelectedDay("today");
      setCalendarOnly(false);
    },
    selectDate(next) {
      if (calendarOnly) setMonth(next);
      else setSelectedDay(agendaInputTime(next.toISOString(), agendaDeviceZone).slice(0, 10) === todayKey ? "today" : next);
    },
    async mutate(method, params) {
      if (!connected) throw new Error("电脑离线，连接后再试。");
      const { assistantAgenda } = agendaResult<{ assistantAgenda: BridgeAgendaSnapshot }>(await request(method, params));
      setMutation({ base: hostAgenda?.changeToken, snapshot: assistantAgenda });
    },
  } : undefined}>{children}</AssistantAgendaContext.Provider>;
}
