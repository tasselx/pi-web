/**
 * 轨迹列表的增量全文索引。
 *
 * 移植自 deepseek-ai/deepseek-harness 的 ui-trajectory/trajectory-search-index.ts
 * （MIT，Copyright (c) 2026 DeepSeek），索引字段换成 pi 记录有的那些。
 * 实时轮询每次都会重新派生布局：只有某条记录的来源文本真的变了才重新小写化，
 * 否则复用上一次的条目，避免几 MB 的工具输出被反复处理。
 */

import type { TrajectoryCellProps, TrajectoryTurnModel } from "./record";

interface SearchEntry {
  readonly sources: readonly string[];
  readonly text: string;
}

function sameSources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordSources(turn: number | null, group: string, cell: TrajectoryCellProps): readonly string[] {
  return [
    turn === null ? "between turns" : `turn ${turn}`,
    group,
    cell.kind,
    cell.kind === "message" ? "assistant" : "",
    cell.text,
    cell.inputDetail ?? "",
    cell.outputDetail ?? "",
    cell.thinkingDetail ?? "",
    cell.toolName ?? "",
    cell.callId ?? "",
    cell.model ?? "",
  ];
}

/** 与一个视图同生命周期的索引。 */
export class TrajectorySearchIndex {
  private readonly entries = new Map<string, SearchEntry>();
  private turns: readonly TrajectoryTurnModel[] | undefined;

  /**
   * 把索引同步到当前布局。
   * @param turns 当前轨迹布局
   * @returns 索引内容是否可能变了
   */
  update(turns: readonly TrajectoryTurnModel[]): boolean {
    if (this.turns === turns) return false;
    this.turns = turns;
    const seen = new Set<string>();
    for (const turn of turns) {
      for (const group of turn.groups) {
        for (const cell of group.cells) {
          const sources = recordSources(turn.turn, group.title, cell);
          const previous = this.entries.get(cell.recordId);
          const entry = previous !== undefined && sameSources(previous.sources, sources)
            ? previous
            : { sources, text: sources.join("\n").toLocaleLowerCase() };
          this.entries.set(cell.recordId, entry);
          seen.add(cell.recordId);
        }
      }
    }
    for (const id of this.entries.keys()) {
      if (!seen.has(id)) this.entries.delete(id);
    }
    return true;
  }

  /**
   * 用最近一次同步的索引做匹配。
   * @param query 以空白分隔、不区分大小写的多个词，必须全部命中
   * @returns 命中的记录 id；查询为空时为 null（表示不过滤）
   */
  search(query: string): ReadonlySet<string> | null {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    const matches = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (terms.every((term) => entry.text.includes(term))) matches.add(id);
    }
    return matches;
  }
}
