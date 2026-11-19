import { ASSISTANT_AGENDA_CAPABILITY, type AgendaPage, type BridgeAgendaEvent, type BridgeAgendaSnapshot, type BridgeAgendaTodo, type BridgeHostSnapshot, type BridgeMethod, type BridgeResponse } from "@bridge/protocol";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { rereadAgendaPages } from "../../lib/assistant-agenda.js";
import type { AssistantRequest } from "./AssistantMailProvider.js";

type AgendaList = "plugin.assistant-agenda.todo.list" | "plugin.assistant-agenda.event.list";
type AgendaMutation = Exclude<Extract<BridgeMethod, `plugin.assistant-agenda.${string}`>, AgendaList>;

function agendaResult<T>(response: BridgeResponse | undefined): T {
  if (!response?.ok) throw new Error(response?.error?.message ?? "议程请求失败");
  return response.result as T;
}

function useAgendaPages<T>(method: AgendaList, request: AssistantRequest, online: boolean, token: string, from?: string, to?: string) {
  const [cache, setCache] = useState<(AgendaPage<T> & { pages: number; from: string | undefined })>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const operation = useRef<AbortController | undefined>(undefined);
  const page = cache?.from === from ? cache : undefined;

  async function read(cursor?: string): Promise<AgendaPage<T>> {
    return agendaResult<{ agendaPage: AgendaPage<T> }>(await request(method, {
      ...(cursor ? { cursor } : {}),
      ...(from ? { from, to } : {}),
    })).agendaPage;
  }

  async function run(load: () => Promise<AgendaPage<T> & { pages: number }>, signal: AbortSignal): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const result = await load();
      if (!signal.aborted) setCache({ ...result, from });
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
  }, [online, token, request, from, to, retry]);

  return {
    records: page?.records ?? [],
    hasMore: Boolean(page?.nextCursor),
    loading,
    error,
    retry: () => setRetry(value => value + 1),
    loadMore() {
      const signal = operation.current?.signal;
      if (!online || loading || !page?.nextCursor || !signal || signal.aborted) return;
      void run(async () => {
        const next = await read(page.nextCursor);
        return { ...next, pages: page.pages + 1, records: [...page.records, ...next.records] };
      }, signal);
    },
  };
}

interface AssistantAgendaState {
  snapshot: BridgeAgendaSnapshot | undefined;
  online: boolean;
  todos: ReturnType<typeof useAgendaPages<BridgeAgendaTodo>>;
  events: ReturnType<typeof useAgendaPages<BridgeAgendaEvent>>;
  month: Date;
  openTodos(): void;
  openCalendar(month?: Date): void;
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
  const [todosOpened, setTodosOpened] = useState(false);
  const [month, setMonth] = useState<Date>();
  const [mutation, setMutation] = useState<{ base: string | undefined; snapshot: BridgeAgendaSnapshot }>();
  const enabled = snapshot?.host.capabilities.includes(ASSISTANT_AGENDA_CAPABILITY) === true;
  const hostAgenda = snapshot?.assistantAgenda;
  const agenda = mutation && hostAgenda?.changeToken === mutation.base ? mutation.snapshot : hostAgenda;
  const token = agenda?.changeToken ?? "";
  const connected = enabled && online;
  const from = month?.toISOString();
  const to = month && new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString();
  const todos = useAgendaPages<BridgeAgendaTodo>("plugin.assistant-agenda.todo.list", request, connected && todosOpened, token);
  const events = useAgendaPages<BridgeAgendaEvent>("plugin.assistant-agenda.event.list", request, connected && Boolean(month), token, from, to);

  return <AssistantAgendaContext.Provider value={enabled ? {
    snapshot: agenda,
    online: connected,
    todos, events,
    month: month ?? new Date(),
    openTodos: () => setTodosOpened(true),
    openCalendar(date) {
      setMonth(current => {
        if (!date && current) return current;
        const selected = date ?? new Date();
        const next = new Date(selected.getFullYear(), selected.getMonth(), 1);
        return current?.getTime() === next.getTime() ? current : next;
      });
    },
    async mutate(method, params) {
      if (!connected) throw new Error("电脑离线，连接后再试。");
      const { assistantAgenda } = agendaResult<{ assistantAgenda: BridgeAgendaSnapshot }>(await request(method, params));
      setMutation({ base: hostAgenda?.changeToken, snapshot: assistantAgenda });
    },
  } : undefined}>{children}</AssistantAgendaContext.Provider>;
}
