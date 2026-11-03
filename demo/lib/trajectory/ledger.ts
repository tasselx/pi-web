/**
 * 记录列表（ledger）的纯逻辑：展平、搜索过滤、折叠一轮、折叠一次助手的工具调用。
 *
 * 移植自 deepseek-ai/deepseek-harness 的 ui-trajectory/TrajectoryTable.tsx
 * （MIT，Copyright (c) 2026 DeepSeek）里同名的纯函数，去掉 pi 没有的
 * system / requestOnly 分支。放在 lib 里不依赖 React，便于单独推理。
 */

import type { TrajectoryCellProps, TrajectoryTranslate, TrajectoryTurnModel } from "./record";

/** 展平后的一行，带上它在轮次 / 分组里的位置，渲染时据此画分隔和表头。 */
export interface TableRecord {
  turn: number | null;
  /** 所在区段在 `turns` 里的序号：「轮次之间」可能有好几段，不能只靠 turn 区分。 */
  section: number;
  group: string;
  groupDescription?: string;
  groupStart: boolean;
  turnStart: boolean;
  turnEnd: boolean;
  cell: TrajectoryCellProps;
  /** 折叠后代替被折起记录的那一行摘要。 */
  collapsedSummary?: string;
  collapsedSummaryKind?: "turn" | "assistant";
}

/** 一行在列表里的身份：折叠后的摘要行和它所属的记录共用 recordId，靠摘要种类区分。 */
export function recordRowKey(record: TableRecord): string {
  return `${record.cell.recordId}|${record.collapsedSummaryKind ?? ""}`;
}

/**
 * 列表窗口：只挂载末尾一段行，其余留在内存里、露出时再挂载（一次挂几千行要两万多个节点，
 * 打开会卡上大半秒）。`pin` 是窗口起点所在的行，按行的身份而不是下标记——列表在末尾追加、
 * 或更早的一页并入时，起点不会跟着动；`extendUp` 是在它之上再多露出的行数，往上滚时一批批加大。
 */
export interface LedgerWindow {
  pin: string | null;
  extendUp: number;
}

export const INITIAL_LEDGER_WINDOW: LedgerWindow = { pin: null, extendUp: 0 };

/**
 * 算出窗口从哪一行起挂载。pin 还在列表里就以它为准；不在了（第一次，或搜索 / 折叠把它过滤掉了）
 * 就退回只看末尾 `initialRows` 行，并把窗口钉在这个新起点上。
 * @param records 要显示的全部行
 * @param window 当前的窗口
 * @param initialRows 没有 pin 时挂载的末尾行数
 * @returns start 挂载从 `records` 的哪个下标起；pinIndex 是 pin 所在的下标；
 *   window 是校正后的窗口（不需要校正时就是传入的那个对象）
 */
export function resolveLedgerWindow(
  records: readonly TableRecord[],
  window: LedgerWindow,
  initialRows: number,
): { start: number; pinIndex: number; window: LedgerWindow } {
  if (window.pin !== null) {
    // pin 多半离末尾不远：从后往前找
    const pinIndex = records.findLastIndex((record) => recordRowKey(record) === window.pin);
    if (pinIndex >= 0) return { start: Math.max(0, pinIndex - window.extendUp), pinIndex, window };
  }
  const start = Math.max(0, records.length - initialRows);
  const first = records[start];
  if (first === undefined) return { start, pinIndex: start, window };
  return { start, pinIndex: start, window: { pin: recordRowKey(first), extendUp: 0 } };
}

/**
 * 把「轮次 → 分组 → 记录」展平成按显示顺序排列的行。
 * @param turns 轨迹布局
 */
export function flattenRecords(turns: readonly TrajectoryTurnModel[]): TableRecord[] {
  return turns.flatMap((turn, section) => {
    let firstInSection = true;
    const records = turn.groups.flatMap((group) => group.cells.map((cell, index): TableRecord => {
      // 轮次中途的压缩不开新的一轮表头；轮次之间的压缩自己就是一段。
      const turnStart = firstInSection && (cell.kind !== "compacted" || turn.turn === null);
      if (turnStart) firstInSection = false;
      return {
        turn: turn.turn, section, group: group.title,
        ...(group.description ? { groupDescription: group.description } : {}),
        groupStart: index === 0, turnStart, turnEnd: false, cell,
      };
    }));
    const last = records.at(-1);
    if (last) last.turnEnd = true;
    return records;
  });
}

/**
 * 只留命中的记录（搜索、时间线框选），并按过滤后的相邻关系重算分组 / 轮次边界。
 * @param records 展平后的全部行
 * @param matches 命中的记录序号
 */
export function filterRecords(records: readonly TableRecord[], matches: ReadonlySet<number>): TableRecord[] {
  const filtered = records
    .filter((record) => matches.has(record.cell.index))
    .map((record): TableRecord => ({ ...record, groupStart: false, turnStart: false, turnEnd: false }));
  const startedSections = new Set<number>();
  filtered.forEach((record, index) => {
    const previous = filtered[index - 1];
    const next = filtered[index + 1];
    record.groupStart = previous === undefined || previous.section !== record.section || previous.group !== record.group;
    record.turnStart = !startedSections.has(record.section) && (record.cell.kind !== "compacted" || record.turn === null);
    if (record.turnStart) startedSections.add(record.section);
    record.turnEnd = next === undefined || next.section !== record.section;
  });
  return filtered;
}

function countLabel(t: TrajectoryTranslate, key: "steps" | "toolCalls", count: number): string {
  return t(`summary.${key}.${count === 1 ? "one" : "other"}`, { count });
}

/** 折叠一轮后那行摘要：「3 个步骤 · 7 个工具调用」。 */
function summarizeTurn(records: readonly TableRecord[], t: TrajectoryTranslate): string {
  const steps = new Set(records.filter((record) => record.cell.kind === "message").map((record) => record.group)).size;
  const toolCalls = records.filter((record) => record.cell.kind === "tool").length;
  return [countLabel(t, "steps", steps), countLabel(t, "toolCalls", toolCalls)].join(" · ");
}

/**
 * 折叠选中的轮次：只留第一条记录（通常是用户消息），其余换成一行摘要。
 * @param records 展平后的行
 * @param collapsedTurns 被折叠的轮次编号
 */
export function collapseTurnRecords(
  records: readonly TableRecord[],
  collapsedTurns: ReadonlySet<number>,
  t: TrajectoryTranslate,
): TableRecord[] {
  const recordsByTurn = new Map<number, TableRecord[]>();
  for (const record of records) {
    if (record.turn === null) continue;
    const list = recordsByTurn.get(record.turn) ?? [];
    list.push(record);
    recordsByTurn.set(record.turn, list);
  }
  return records.flatMap((record): TableRecord[] => {
    if (record.turn === null || !collapsedTurns.has(record.turn)) return [record];
    const turnRecords = recordsByTurn.get(record.turn) ?? [record];
    if (turnRecords.length <= 1) return [record];
    if (record.cell.index !== turnRecords[0]?.cell.index) return [];
    return [
      { ...record, turnEnd: false },
      {
        ...record, groupStart: false, turnStart: false, turnEnd: true,
        collapsedSummary: summarizeTurn(turnRecords.slice(1), t), collapsedSummaryKind: "turn",
      },
    ];
  });
}

/** 折叠一次助手的工具调用后那行摘要：「2 个工具调用 · bash, read」。 */
function summarizeAssistantTools(records: readonly TableRecord[], t: TrajectoryTranslate): string {
  const names = [...new Set(records.map((record) => record.cell.toolName ?? "").filter(Boolean))];
  const summary = countLabel(t, "toolCalls", records.length);
  return names.length > 0 ? `${summary} · ${names.join(", ")}` : summary;
}

/**
 * 折叠选中的助手记录之后紧跟的那串工具调用。
 * @param records 展平（可能已折叠轮次）后的行
 * @param collapsedAssistants 被折叠的助手记录 id
 */
export function collapseAssistantRecords(
  records: readonly TableRecord[],
  collapsedAssistants: ReadonlySet<string>,
  t: TrajectoryTranslate,
): TableRecord[] {
  const out: TableRecord[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record === undefined) continue;
    out.push(record);
    if (record.cell.kind !== "message" || !collapsedAssistants.has(record.cell.recordId)) continue;
    const calls: TableRecord[] = [];
    for (let j = i + 1; j < records.length; j++) {
      const candidate = records[j];
      if (candidate === undefined || candidate.collapsedSummary !== undefined || candidate.cell.kind !== "tool") break;
      calls.push(candidate);
    }
    if (calls.length === 0) continue;
    out[out.length - 1] = { ...record, turnEnd: false };
    out.push({
      ...record, groupStart: false, turnStart: false, turnEnd: calls.at(-1)?.turnEnd ?? false,
      collapsedSummary: summarizeAssistantTools(calls, t), collapsedSummaryKind: "assistant",
    });
    i += calls.length;
  }
  return out;
}

/** 值得折叠的轮次（记录多于一条）；「全部折叠 / 展开」按钮据此判断状态。 */
export function collapsibleTurnIds(turns: readonly TrajectoryTurnModel[]): number[] {
  return turns.flatMap((turn) => {
    if (turn.turn === null) return [];
    const count = turn.groups.reduce((sum, group) => sum + group.cells.length, 0);
    return count > 1 ? [turn.turn] : [];
  });
}

/** 值得折叠的助手记录（后面紧跟着工具调用）。 */
export function collapsibleAssistantIds(turns: readonly TrajectoryTurnModel[]): string[] {
  const ids: string[] = [];
  for (const turn of turns) {
    for (const group of turn.groups) {
      group.cells.forEach((cell, index) => {
        if (cell.kind === "message" && group.cells[index + 1]?.kind === "tool") ids.push(cell.recordId);
      });
    }
  }
  return ids;
}
