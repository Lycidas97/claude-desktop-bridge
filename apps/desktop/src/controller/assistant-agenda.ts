import type { BridgeMethod } from "@bridge/protocol";
import { ZodError } from "zod";
import type { AssistantAgendaService } from "../../../../plugins/assistant-mail/agenda.js";
import { agendaRequests } from "../../../../plugins/assistant-mail/agenda-contract.js";
import { AgendaEditError } from "../../../../plugins/assistant-mail/agenda-store.js";
import { BridgeRequestError } from "./request-error.js";

export async function handleAssistantAgenda(service: AssistantAgendaService, method: BridgeMethod, params: unknown) {
  try {
    switch (method) {
      case "plugin.assistant-agenda.todo.list": return { agendaPage: service.listTodos(agendaRequests[method].parse(params)) };
      case "plugin.assistant-agenda.event.list": return { agendaPage: service.listEvents(agendaRequests[method].parse(params)) };
      case "plugin.assistant-agenda.todo.save": service.saveTodo(agendaRequests[method].parse(params)); break;
      case "plugin.assistant-agenda.event.save": service.saveEvent(agendaRequests[method].parse(params)); break;
      case "plugin.assistant-agenda.todo.complete": service.completeTodo(agendaRequests[method].parse(params)); break;
      case "plugin.assistant-agenda.source.add": await service.addSource(agendaRequests[method].parse(params)); break;
      case "plugin.assistant-agenda.source.credential": {
        const { id, credential } = agendaRequests[method].parse(params);
        await service.setCredential(id, credential);
        break;
      }
      case "plugin.assistant-agenda.source.enable": {
        const { id, enabled } = agendaRequests[method].parse(params);
        await service.setEnabled(id, enabled);
        break;
      }
      case "plugin.assistant-agenda.source.refresh": await service.refresh(agendaRequests[method].parse(params).id); break;
      case "plugin.assistant-agenda.source.remove": service.removeSource(agendaRequests[method].parse(params).id); break;
      default: throw new BridgeRequestError("UNSUPPORTED", "当前版本不支持此日程操作。");
    }
    return { assistantAgenda: service.snapshot() };
  } catch (error) {
    if (error instanceof ZodError) throw new BridgeRequestError("INVALID_PARAMS", "请检查日程或待办的输入。");
    if (error instanceof AgendaEditError) throw new BridgeRequestError(error.code, error.message);
    throw error;
  }
}
