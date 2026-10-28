/**
 * 概览时间线的投影：把每条记录放到「操作序号」或「记录的时间」这条横轴上。
 *
 * 移植自 deepseek-ai/deepseek-harness 的 ui-trajectory/timeline.ts
 * （MIT，Copyright (c) 2026 DeepSeek）。只保留界面里真正能切到的两种模式：
 * - sequence：每条记录等宽，看操作先后；
 * - duration：用记录的真实时长，并把「没有任何记录在跑」的空闲间隙压掉，
 *   否则用户隔了一晚上才回复的会话，时间线几乎全是空白。
 * 上游另外两种（time / actual）在它自己的工具栏里也是隐藏开关，不带过来（YAGNI）。
 */

import type { TrajectoryCellKind, TrajectoryCellProps, TrajectoryTurnModel } from "./record";

/** 时间线的横轴投影。 */
export type TrajectoryTimelineMode = "sequence" | "duration";

/** 当前投影坐标系里的闭区间。 */
export interface TrajectoryTimeRange {
  start: number;
  end: number;
}

/** 一条记录在当前坐标系里的位置。 */
export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
  index: number;
  isError: boolean;
  kind: TrajectoryCellKind;
  label: string;
  lane: number;
}

/** 一轮开始的位置，时间线上画成竖线。 */
export interface TrajectoryTimelineTurnBoundary {
  turn: number;
  time: number;
}

/** 概览用的完整模型。 */
export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
  spans: readonly TrajectoryTimelineSpan[];
  turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
}

/** 三条泳道：0 输入（用户 / 上下文），1 模型（助手 / 压缩），2 工具。 */
function laneFor(kind: TrajectoryCellKind): number {
  if (kind === "tool") return 2;
  if (kind === "message" || kind === "compacted") return 1;
  return 0;
}

function cellRange(cell: TrajectoryCellProps): TrajectoryTimeRange | null {
  const startedAt = cell.startedAt;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  const durationMs = typeof cell.timeSeconds === "number" && Number.isFinite(cell.timeSeconds)
    ? Math.max(0, cell.timeSeconds * 1000)
    : 0;
  return { start: startedAt, end: startedAt + durationMs };
}

function spanFor(cell: TrajectoryCellProps, range: TrajectoryTimeRange): TrajectoryTimelineSpan {
  return {
    ...range, index: cell.index, isError: cell.isError === true, kind: cell.kind, label: cell.text,
    lane: laneFor(cell.kind),
  };
}

function minOf(values: readonly number[]): number {
  return values.reduce((least, value) => Math.min(least, value), Number.POSITIVE_INFINITY);
}

function maxOf(values: readonly number[]): number {
  return values.reduce((most, value) => Math.max(most, value), Number.NEGATIVE_INFINITY);
}

/**
 * 把所有记录投影成稳定的三泳道时间线。
 * @param turns 未过滤的轨迹布局
 * @param mode 等宽或真实时长
 * @returns 时间线模型；没有任何可画的记录时为 null
 */
export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurnModel[],
  mode: TrajectoryTimelineMode = "sequence",
): TrajectoryTimelineModel | null {
  return mode === "duration" ? deriveDurationTimeline(turns) : deriveSequenceTimeline(turns);
}

function deriveSequenceTimeline(turns: readonly TrajectoryTurnModel[]): TrajectoryTimelineModel | null {
  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  for (const turn of turns) {
    const cells = turn.groups.flatMap((group) => group.cells);
    if (cells.length === 0) continue;
    if (turn.turn !== null) turnBoundaries.push({ turn: turn.turn, time: spans.length });
    for (const cell of cells) {
      const at = spans.length;
      spans.push(spanFor(cell, { start: at, end: at + 1 }));
    }
  }
  return spans.length === 0 ? null : { start: 0, end: spans.length, spans, turnBoundaries };
}

function deriveDurationTimeline(turns: readonly TrajectoryTurnModel[]): TrajectoryTimelineModel | null {
  const timedTurns = turns.flatMap((turn) => {
    const rawSpans = turn.groups.flatMap((group) => group.cells.flatMap((cell): TrajectoryTimelineSpan[] => {
      const range = cellRange(cell);
      return range === null ? [] : [spanFor(cell, range)];
    }));
    return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }];
  });
  const allSpans = timedTurns.flatMap((turn) => turn.rawSpans);
  if (allSpans.length === 0) return null;

  // 按开始时间扫一遍，累计「此刻没有任何记录在跑」的间隙，从其后所有 span 的坐标里扣掉。
  const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of [...allSpans].sort((left, right) => left.start - right.start || left.end - right.end)) {
    if (coveredUntil !== null && span.start > coveredUntil) removedIdle += span.start - coveredUntil;
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  for (const turn of timedTurns) {
    const projected = turn.rawSpans.map((span): TrajectoryTimelineSpan => {
      const offset = removedIdleBySpan.get(span) ?? 0;
      return { ...span, start: span.start - offset, end: span.end - offset };
    });
    spans.push(...projected);
    if (turn.turn !== null) turnBoundaries.push({ turn: turn.turn, time: minOf(projected.map((span) => span.start)) });
  }
  return {
    start: minOf(spans.map((span) => span.start)),
    end: maxOf(spans.map((span) => span.end)),
    spans,
    turnBoundaries,
  };
}

/**
 * 在选中区间内「活动过」的记录序号（框选时间线时列表据此强调区间内的行、淡化其余，不过滤）。
 * @param turns 未过滤的轨迹布局
 * @param range 当前投影坐标系里的选中区间
 * @param mode 与时间线一致的投影
 */
export function trajectoryTimelineFocusIndexes(
  turns: readonly TrajectoryTurnModel[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = "sequence",
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(turns, mode);
  return new Set(
    model?.spans.filter((span) => span.start <= range.end && span.end >= range.start).map((span) => span.index),
  );
}
