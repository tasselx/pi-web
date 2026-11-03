/**
 * 侧栏的置顶、归档、项目顺序与项目名：主应用存在 pi-web-session-state.json，
 * demo 只在页面存活期间放在内存里。
 *
 * 「一个请求改什么、什么时候拒绝」用的是主应用自己的客户端安全代码
 * （lib/session-ui-state-shared.ts），这里只补存储和修订号：和 lib/session-ui-state.ts
 * 一样，只有真的改了东西才把 revision 加一。
 */
import {
  MAX_PROJECT_NAMES,
  PROJECT_NAMES_MAX_BYTES,
  applySessionUiStateRequest,
  emptySessionUiState,
  parseSessionUiStateRequest,
  storedProjectName,
  type SessionUiState,
  type SessionUiStateErrorResponse,
  type SessionUiStateRefusalReason,
  type SessionUiStateResponse,
} from "@/lib/session-ui-state-shared";
import { error, json, type MockRequest } from "./http";

let state: SessionUiState = emptySessionUiState();

/** /api/agent/running 带的修订号：侧栏据此知道别处改过置顶/归档。 */
export function sessionUiStateRevision(): number {
  return state.revision;
}

function refusal(status: number, reason: SessionUiStateRefusalReason, message: string): Response {
  return json({ error: message, reason } satisfies SessionUiStateErrorResponse, status);
}

/** GET 读当前状态；POST 做一次修改并回修改后的状态。 */
export async function sessionUiStateRoute(request: MockRequest): Promise<Response> {
  if (request.method === "GET") return json({ state } satisfies SessionUiStateResponse);
  if (request.method !== "POST") return error("Method not allowed", 405);

  const parsed = parseSessionUiStateRequest(await request.json());
  if (!parsed.ok) return refusal(400, "invalid-request", parsed.error);

  const change = parsed.request;
  const applied = applySessionUiStateRequest(state, change, Date.now());
  if (applied.changed) state = { ...applied.state, revision: state.revision + 1 };
  // 名字没排上（已满）时不能回一个悄悄缺了它的状态：和主应用一样明说。
  if (change.action === "rename-project" && change.name !== null && storedProjectName(state, change.projectKey) !== change.name) {
    return refusal(409, "full", `No room for another project name (at most ${MAX_PROJECT_NAMES}, ${PROJECT_NAMES_MAX_BYTES / 1024} KiB in all)`);
  }
  return json({ state } satisfies SessionUiStateResponse);
}
