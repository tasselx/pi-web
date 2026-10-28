/**
 * 把 pi 的会话消息派生成「轮次 → 步骤 → 记录」的轨迹布局。
 *
 * 取代上游 layout.ts 的 deriveTrajectoryLayout：上游吃的是 dsh 自己的会话节点
 * （AssistantMessageNode、RequestView……），pi 没有这些，所以输入侧自己写，
 * 输出的 TrajectoryTurnModel 与上游同形，下游的时间线 / 折叠 / 搜索原样可用。
 *
 * 约定：
 * - 一条用户消息开一轮；每条助手消息是该轮的一步，它的工具调用跟在后面，
 *   工具结果合并进各自的调用记录，不单独成行。
 * - 工具的起止时间取结果自带的 `timestamp`（结束）与 `durationMs`，所以是精确的，
 *   并行调用也不会被画成串行。
 * - 重活（大段输出的拼接、围栏、JSON 序列化）一律不在这里做：每次轮询都会重新
 *   派生全部已加载消息，这里只做 O(记录数) 的轻量工作。
 */

import type {
  AgentMessage, AssistantMessage, BashExecutionMessage, CustomMessage, ToolCallContent,
  ToolResultMessage, UserMessage,
} from "@/lib/types";
import {
  formatDuration,
  type TrajectoryCellProps, type TrajectoryGroupModel, type TrajectoryTranslate,
  type TrajectoryTurnModel,
} from "./record";

type NewCell = Omit<TrajectoryCellProps, "index">;
interface FoundResult { message: ToolResultMessage; entryId: string }
interface MutableGroup { title: string; cells: TrajectoryCellProps[] }
interface MutableTurn { turn: number | null; groups: MutableGroup[] }

/** 摘要里优先展示的工具参数，按「最能说明这次调用在做什么」排序。 */
const PRIMARY_ARGUMENTS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "description", "prompt", "task", "name"];
/** 摘要只看正文开头这么多字符：整段输出可能有几 MB，摘要不需要扫完。 */
const SUMMARY_SCAN_CHARS = 2000;
const SUMMARY_MAX_CHARS = 200;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 消息内容里的文本；图片用占位符，其余块忽略。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as { type?: string; text?: string }[]) {
    if (block?.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block?.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

/** 助手消息里某一类块（text / thinking）拼起来的文本。 */
function joinBlocks(message: AssistantMessage, type: "text" | "thinking"): string {
  const parts: string[] = [];
  for (const block of message.content ?? []) {
    if (block.type === "text" && type === "text") parts.push(block.text);
    else if (block.type === "thinking" && type === "thinking") parts.push(block.thinking);
  }
  return parts.join("\n\n").trim();
}

/** 第一段非空文字压成一行；只扫开头，长文本不会拖慢派生。 */
function oneLine(text: string): string {
  const head = text.slice(0, SUMMARY_SCAN_CHARS).trim();
  const line = head.replace(/\s+/g, " ");
  return line.length > SUMMARY_MAX_CHARS || text.length > SUMMARY_SCAN_CHARS
    ? `${line.slice(0, SUMMARY_MAX_CHARS)}…`
    : line;
}

function argumentSummary(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of PRIMARY_ARGUMENTS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim()) return oneLine(value);
  }
  return Object.keys(input).length > 0 ? oneLine(JSON.stringify(input)) : "";
}

function userCell(message: UserMessage, entryId: string): NewCell {
  const text = textOf(message.content);
  return {
    recordId: entryId, kind: "user", text: oneLine(text), inputDetail: text, raw: message,
    timeSeconds: null, startedAt: finiteNumber(message.timestamp),
  };
}

function assistantCell(message: AssistantMessage, entryId: string): NewCell {
  const text = joinBlocks(message, "text");
  const thinking = joinBlocks(message, "thinking");
  const interrupted = message.stopReason === "error" || message.stopReason === "aborted";
  const durationMs = finiteNumber(message.durationMs);
  const usage = message.usage;
  return {
    recordId: entryId, kind: "message",
    text: oneLine(text || (interrupted ? message.errorMessage ?? "" : "")),
    ...(text ? { outputDetail: text } : {}),
    ...(thinking ? { thinkingDetail: thinking } : {}),
    raw: message,
    ...(interrupted ? { isError: true } : {}),
    timeSeconds: durationMs === null ? null : durationMs / 1000,
    startedAt: finiteNumber(message.timestamp),
    ...(usage ? {
      input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite,
      ...(finiteNumber(usage.cost?.total) === null ? {} : { cost: usage.cost.total }),
    } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.provider ? { provider: message.provider } : {}),
    ...(message.stopReason ? { stopReason: message.stopReason } : {}),
  };
}

function toolCell(call: ToolCallContent, found: FoundResult | undefined, assistantEntryId: string, live: boolean): NewCell {
  const result = found?.message;
  const durationMs = finiteNumber(result?.durationMs);
  const end = finiteNumber(result?.timestamp);
  const args = argumentSummary(call.input);
  return {
    recordId: `${assistantEntryId}:${call.toolCallId}`, kind: "tool",
    text: args ? `${call.toolName} · ${args}` : call.toolName,
    toolName: call.toolName, callId: call.toolCallId,
    // 还没有结果：会话在跑才算「进行中」；已经停了就是中断或崩溃，不能永远转圈。
    ...(result ? { outputDetail: textOf(result.content) } : live ? { running: true } : { interrupted: true }),
    raw: { call, result },
    ...(result?.isError ? { isError: true } : {}),
    timeSeconds: durationMs === null ? null : durationMs / 1000,
    // 结束时间减自身耗时才是真正的开始：工具默认并行执行，不能假设它们接着助手结束。
    startedAt: durationMs !== null && end !== null ? end - durationMs : null,
  };
}

/** 它的调用在更早、尚未加载的那一页里，只剩结果：单独成一条，不丢。 */
function orphanToolCell(message: ToolResultMessage, entryId: string): NewCell {
  const durationMs = finiteNumber(message.durationMs);
  const end = finiteNumber(message.timestamp);
  return {
    recordId: entryId, kind: "tool", text: message.toolName ?? "tool",
    ...(message.toolName ? { toolName: message.toolName } : {}), callId: message.toolCallId,
    outputDetail: textOf(message.content), raw: { result: message },
    ...(message.isError ? { isError: true } : {}),
    timeSeconds: durationMs === null ? null : durationMs / 1000,
    startedAt: durationMs !== null && end !== null ? end - durationMs : null,
  };
}

function bashCell(message: BashExecutionMessage, entryId: string): NewCell {
  const failed = message.cancelled === true || (message.exitCode !== undefined && message.exitCode !== 0);
  return {
    recordId: entryId, kind: "tool", text: `bash · ${oneLine(message.command)}`, toolName: "bash",
    inputDetail: message.command, outputDetail: message.output, raw: message,
    ...(failed ? { isError: true } : {}),
    timeSeconds: null, startedAt: finiteNumber(message.timestamp),
  };
}

function summaryCell(message: CustomMessage, entryId: string): NewCell {
  const text = textOf(message.content);
  return {
    recordId: entryId, kind: "compacted", text: oneLine(text), inputDetail: text, raw: message,
    timeSeconds: null, startedAt: finiteNumber(message.timestamp),
  };
}

function contextCell(message: CustomMessage, entryId: string): NewCell {
  const text = textOf(message.content);
  return {
    recordId: entryId, kind: "context", text: `${message.customType} · ${oneLine(text)}`, inputDetail: text,
    raw: message, timeSeconds: null, startedAt: finiteNumber(message.timestamp),
  };
}

/** 一组的说明：墙钟跨度 + 工具直方图，如 `1.5 s bash×6`（同上游）。 */
function describeGroup(cells: readonly TrajectoryCellProps[]): string | undefined {
  let first = Number.POSITIVE_INFINITY;
  let last = Number.NEGATIVE_INFINITY;
  let timed = 0;
  const tools = new Map<string, number>();
  for (const cell of cells) {
    if (cell.kind === "tool" && cell.toolName) tools.set(cell.toolName, (tools.get(cell.toolName) ?? 0) + 1);
    if (typeof cell.startedAt !== "number") continue;
    timed += 1;
    first = Math.min(first, cell.startedAt);
    last = Math.max(last, cell.startedAt + (cell.timeSeconds ?? 0) * 1000);
  }
  const parts: string[] = [];
  if (timed > 0 && last > first) parts.push(formatDuration(last - first));
  for (const [name, count] of tools) parts.push(count > 1 ? `${name}×${count}` : name);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * 派生轨迹布局。
 * @param messages `GET /api/sessions/[id]/context` 返回的消息，按时间先后
 * @param entryIds 与 `messages` 一一对应的会话条目 id
 * @param t 本视图翻译函数
 * @param live 会话此刻是否在运行：决定没有结果的工具调用是「进行中」还是「未返回结果」
 * @returns 轮次列表；记录序号 `index` 在整个返回值里从 1 连续递增
 */
export function deriveTrajectoryLayout(
  messages: readonly AgentMessage[],
  entryIds: readonly string[],
  t: TrajectoryTranslate,
  live: boolean,
): TrajectoryTurnModel[] {
  const callIds = new Set<string>();
  const results = new Map<string, FoundResult>();
  messages.forEach((message, i) => {
    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type === "toolCall") callIds.add(block.toolCallId);
      }
    } else if (message.role === "toolResult") {
      results.set(message.toolCallId, { message, entryId: entryIds[i] ?? `#${i}` });
    }
  });

  const messageTitle = t("group.message");
  const turns: MutableTurn[] = [];
  // current：下一条消息要接在它后面的那一轮；轮次之间的压缩后置空，免得后来的记录排到压缩前面。
  const state: { current: MutableTurn | null } = { current: null };
  let turnNo = 0;
  let stepNo = 0;
  let compactionNo = 0;
  let index = 0;
  const cell = (partial: NewCell): TrajectoryCellProps => ({ ...partial, index: ++index });

  const openTurn = (): MutableTurn => {
    turnNo += 1;
    stepNo = 0;
    const turn: MutableTurn = { turn: turnNo, groups: [] };
    turns.push(turn);
    state.current = turn;
    return turn;
  };

  /** 上下文、用户自己跑的命令这类「不属于某一步」的记录：进当前轮最后的「消息」组。 */
  const placeInMessageGroup = (record: TrajectoryCellProps): void => {
    let target: MutableTurn | null = state.current;
    if (target === null) {
      // 没有当前轮：接在上一个「轮次之间」的桶里，让连续的这类记录合并成一个区段。
      const lastBucket = turns.at(-1);
      if (lastBucket && lastBucket.turn === null) target = lastBucket;
    }
    if (target === null) {
      turns.push({ turn: null, groups: [{ title: messageTitle, cells: [record] }] });
      return;
    }
    const last = target.groups.at(-1);
    if (last && last.title === messageTitle) last.cells.push(record);
    else target.groups.push({ title: messageTitle, cells: [record] });
  };

  messages.forEach((message, i) => {
    const entryId = entryIds[i] ?? `#${i}`;
    switch (message.role) {
      case "user": {
        openTurn().groups.push({ title: messageTitle, cells: [cell(userCell(message, entryId))] });
        break;
      }
      case "custom": {
        if (message.customType !== "compaction") {
          placeInMessageGroup(cell(contextCell(message, entryId)));
          break;
        }
        compactionNo += 1;
        const group: MutableGroup = {
          title: t("group.compaction", { seq: compactionNo }),
          cells: [cell(summaryCell(message, entryId))],
        };
        // 后面紧跟助手或工具结果：压缩发生在这一轮中途（自动压缩后接着干活），留在这一轮里。
        const next = messages[i + 1];
        if (state.current && (next?.role === "assistant" || next?.role === "toolResult")) {
          state.current.groups.push(group);
        } else {
          turns.push({ turn: null, groups: [group] });
          state.current = null;
        }
        break;
      }
      case "bashExecution": {
        placeInMessageGroup(cell(bashCell(message, entryId)));
        break;
      }
      case "assistant": {
        const turn = state.current ?? openTurn();
        stepNo += 1;
        const cells = [cell(assistantCell(message, entryId))];
        for (const block of message.content ?? []) {
          if (block.type === "toolCall") cells.push(cell(toolCell(block, results.get(block.toolCallId), entryId, live)));
        }
        turn.groups.push({ title: t("group.step", { step: stepNo }), cells });
        break;
      }
      case "toolResult": {
        if (callIds.has(message.toolCallId)) break; // 已并进它的调用记录
        placeInMessageGroup(cell(orphanToolCell(message, entryId)));
        break;
      }
    }
  });

  return turns.map((turn): TrajectoryTurnModel => ({
    turn: turn.turn,
    groups: turn.groups.map((group): TrajectoryGroupModel => {
      const description = describeGroup(group.cells);
      return { title: group.title, ...(description ? { description } : {}), cells: group.cells };
    }),
  }));
}
