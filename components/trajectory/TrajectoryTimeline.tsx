"use client";

/**
 * 概览时间线：Chrome Network 面板那样的三泳道（输入 / 模型 / 工具），
 * 水平拖动框选来过滤下面的记录列表。
 *
 * 移植自 deepseek-ai/deepseek-harness 的 ui-trajectory/TrajectoryTimeline.tsx
 * （MIT，Copyright (c) 2026 DeepSeek），拖动框选、滚轮缩放、右键平移、
 * 边缘自动平移、Esc 清除的交互原样保留。与上游不同的两处：
 * - 去掉助手条上「首 token / 解码」两段着色：pi 不记录首 token 时间，没有数据可画；
 * - 提示框用原生 title、只给悬停的那一段设置：几千个 span 每次指针移动都重渲染，
 *   不能为每个都拼一遍提示串。
 */

import {
  memo, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent,
} from "react";
import {
  deriveTrajectoryTimeline, type TrajectoryTimeRange, type TrajectoryTimelineMode,
} from "@/lib/trajectory/timeline";
import {
  formatDuration, type TrajectoryCellKind, type TrajectoryCellProps, type TrajectoryTranslate,
  type TrajectoryTurnModel,
} from "@/lib/trajectory/record";
import css from "./TrajectoryTimeline.module.css";

const MINIMUM_DRAG_PX = 3;
const MINIMUM_ZOOM_OPERATIONS = 4;
const EDGE_PAN_ZONE_FRACTION = 0.08;
const EDGE_PAN_STEP_FRACTION = 0.025;
const MAXIMUM_EDGE_PAN_PX = 32;

interface TimelineRecordDetail {
  durationMs?: number;
  startedAt?: number;
}

interface FractionRange {
  start: number;
  end: number;
}

interface HoverPoint {
  fraction: number;
  recordIndex: number | null;
}

interface PanGesture {
  anchorClientX: number;
  anchorStart: number;
  moved: boolean;
  pannable: boolean;
  pointerId: number;
}

function timelineRecordDetail(cell: TrajectoryCellProps): TimelineRecordDetail {
  const durationMs = cell.timeSeconds === null || !Number.isFinite(cell.timeSeconds)
    ? undefined
    : Math.max(0, cell.timeSeconds * 1_000);
  const startedAt = cell.startedAt === null || cell.startedAt === undefined || !Number.isFinite(cell.startedAt)
    ? undefined
    : cell.startedAt;
  return {
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

function timelineKindLabel(kind: TrajectoryCellKind, t: TrajectoryTranslate): string {
  switch (kind) {
    case "user": return t("kind.user");
    case "context": return t("kind.context");
    case "compacted": return t("kind.compacted");
    case "message": return t("kind.assistant");
    case "tool": return t("kind.tool");
  }
}

function formatRecordedTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function timelineTooltipLabel(
  kind: TrajectoryCellKind,
  detail: TimelineRecordDetail | undefined,
  t: TrajectoryTranslate,
): string {
  const heading = timelineKindLabel(kind, t);
  if (detail === undefined) return heading;
  const duration = detail.durationMs === undefined
    ? null
    : t("timeline.total", { duration: formatDuration(detail.durationMs) });
  const range = detail.startedAt === undefined
    ? null
    : detail.durationMs === undefined
      ? t("timeline.started", { time: formatRecordedTime(detail.startedAt) })
      : `${formatRecordedTime(detail.startedAt)} → ${formatRecordedTime(detail.startedAt + detail.durationMs)}`;
  return [heading, range, duration].filter((value) => value !== null && value !== "").join("\n");
}

/** 记录列表上方的整体概览。 */
export interface TrajectoryTimelineProps {
  t: TrajectoryTranslate;
  turns: readonly TrajectoryTurnModel[];
  mode: TrajectoryTimelineMode;
  range: TrajectoryTimeRange | null;
  /** 已加载的时间线前面还有更早的历史。 */
  hasEarlierRecords?: boolean;
  /** 点左侧省略号时加载更早的一页。 */
  onLoadEarlier?: () => Promise<boolean>;
  selectedIndex?: number | null;
  /** 命中当前搜索的记录序号；没有查询为 null。 */
  searchMatchIndexes?: ReadonlySet<number> | null;
  onRangeChange: (range: TrajectoryTimeRange | null) => void;
  /** 直接点中某一段时选中它。 */
  onRecordSelect?: (index: number) => void;
  /** 点在空白处时把最近的一条记录滚进视野。 */
  onRecordFocus?: (index: number) => void;
}

function orderedRange(left: number, right: number): FractionRange {
  return left <= right ? { start: left, end: right } : { start: right, end: left };
}

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function centeredRange(center: number, width: number, minimum: number, maximum: number): FractionRange {
  const clampedWidth = Math.min(maximum - minimum, Math.max(0, width));
  const start = Math.min(Math.max(center - clampedWidth / 2, minimum), maximum - clampedWidth);
  return { start, end: start + clampedWidth };
}

function rangeFraction(
  range: TrajectoryTimeRange,
  start: number,
  duration: number,
  minimum: number,
  maximum: number,
): FractionRange {
  const bounded = orderedRange(
    Math.min(maximum, Math.max(minimum, range.start)),
    Math.min(maximum, Math.max(minimum, range.end)),
  );
  return {
    start: (bounded.start - start) / duration,
    end: (bounded.end - start) / duration,
  };
}

function LaneLabels({ t }: { t: TrajectoryTranslate }) {
  return (
    <div className={css.labels} aria-hidden="true">
      <span>{t("column.input")}</span>
      <span>{t("column.model")}</span>
      <span>{t("column.tools")}</span>
    </div>
  );
}

function EarlierHistoryBoundary({
  loading,
  onHover,
  onLoad,
  t,
}: {
  loading: boolean;
  onHover: () => void;
  onLoad: (() => void) | undefined;
  t: TrajectoryTranslate;
}) {
  return (
    <button
      type="button"
      className={css.earlierHistory}
      data-earlier-history
      data-loading={loading || undefined}
      title={loading ? t("history.loadingEarlier") : t("history.clickToLoadEarlier")}
      aria-label={loading ? t("history.loadingEarlierAria") : t("history.loadEarlier")}
      aria-disabled={loading || onLoad === undefined}
      onClick={onLoad}
      onPointerEnter={(event) => {
        event.stopPropagation();
        onHover();
      }}
      onPointerMove={(event) => { event.stopPropagation(); }}
      onPointerDown={(event) => { event.stopPropagation(); }}
    >
      …
    </button>
  );
}

/** 时间线渲染：拖动框选、点击定位、滚轮缩放、右键平移、Esc 清除。 */
export const TrajectoryTimeline = memo(function TrajectoryTimeline({
  t,
  turns,
  mode,
  range,
  hasEarlierRecords = false,
  onLoadEarlier,
  selectedIndex = null,
  searchMatchIndexes = null,
  onRangeChange,
  onRecordSelect,
  onRecordFocus,
}: TrajectoryTimelineProps) {
  const model = useMemo(() => deriveTrajectoryTimeline(turns, mode), [mode, turns]);
  const detailByIndex = useMemo(
    () => new Map(turns.flatMap((turn) =>
      turn.groups.flatMap((group) => group.cells.map((cell) => [cell.index, timelineRecordDetail(cell)] as const)),
    )),
    [turns],
  );
  const dragRef = useRef<{
    pointerId: number;
    anchorTime: number;
    anchorClientX: number;
    recordIndex: number | null;
  } | null>(null);
  const panRef = useRef<PanGesture | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<TrajectoryTimeRange | null>(null);
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [panning, setPanning] = useState(false);
  const [viewport, setViewport] = useState<TrajectoryTimeRange | null>(null);
  const [animateViewport, setAnimateViewport] = useState(false);

  useEffect(() => {
    if (model !== null && range !== null && (range.end < model.start || range.start > model.end)) {
      onRangeChange(null);
    }
  }, [model, onRangeChange, range]);

  useEffect(() => {
    if (model === null) return;
    setAnimateViewport(false);
    setViewport((current) =>
      current !== null && (current.end < model.start || current.start > model.end) ? null : current);
  }, [model]);

  // 选中的记录滚出了放大后的视口时，把视口平移到它。
  useEffect(() => {
    if (model === null || selectedIndex === null) return;
    const selectedSpan = model.spans.find((span) => span.index === selectedIndex);
    if (selectedSpan === undefined) return;
    setAnimateViewport(true);
    setViewport((current) => {
      if (current === null) return current;
      if (selectedSpan.end > current.start && selectedSpan.start < current.end) return current;
      const duration = Math.max(1, current.end - current.start);
      const desiredStart = selectedSpan.end <= current.start ? selectedSpan.start : selectedSpan.end - duration;
      const nextStart = Math.min(
        Math.max(desiredStart, model.start),
        Math.max(model.start, model.end - duration),
      );
      if (nextStart === current.start) return current;
      return { start: nextStart, end: nextStart + duration };
    });
  }, [model, selectedIndex]);

  const fullDuration = Math.max(1, (model?.end ?? 0) - (model?.start ?? 0));
  const viewportDuration = Math.min(fullDuration, Math.max(1, (viewport?.end ?? 0) - (viewport?.start ?? 0)));
  const viewportStart = model === null || viewport === null
    ? model?.start ?? 0
    : Math.min(Math.max(viewport.start, model.start), model.end - viewportDuration);
  const domainDuration = viewport === null ? fullDuration : viewportDuration;
  const domainStart = viewport === null ? model?.start ?? 0 : viewportStart;
  const showsEarlierBoundary = hasEarlierRecords && model !== null && domainStart === model.start;
  const loadEarlier = onLoadEarlier === undefined || loadingEarlier
    ? undefined
    : () => {
      setLoadingEarlier(true);
      void onLoadEarlier().finally(() => { setLoadingEarlier(false); });
    };
  const projectedDomainStyle = model === null
    ? undefined
    : {
      "--trajectory-domain-left": `${-(domainStart - model.start) / domainDuration * 100}%`,
      "--trajectory-domain-width": `${fullDuration / domainDuration * 100}%`,
    } as CSSProperties;
  const committed = model === null || range === null
    ? null
    : rangeFraction(range, domainStart, domainDuration, model.start, model.end);
  const draftFraction = model === null || draft === null
    ? null
    : rangeFraction(draft, domainStart, domainDuration, model.start, model.end);
  const visibleRange = draftFraction ?? committed;
  const activeRange = draft ?? range;

  // 滚轮缩放必须是非 passive 监听：要 preventDefault 阻止页面跟着滚。
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onWheel = (event: globalThis.WheelEvent): void => {
      event.preventDefault();
      const track = trackRef.current;
      if (track === null || model === null) return;
      setAnimateViewport(false);
      const rect = track.getBoundingClientRect();
      const anchorFraction = clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
      const nextDuration = Math.min(
        fullDuration,
        Math.max(
          Math.min(mode === "sequence" ? MINIMUM_ZOOM_OPERATIONS : 20, fullDuration),
          domainDuration * Math.exp(event.deltaY * 0.0015),
        ),
      );
      if (nextDuration >= fullDuration * 0.999) {
        setViewport(null);
        return;
      }
      const anchorTime = domainStart + anchorFraction * domainDuration;
      const nextStart = Math.min(
        Math.max(anchorTime - anchorFraction * nextDuration, model.start),
        model.end - nextDuration,
      );
      setViewport({ start: nextStart, end: nextStart + nextDuration });
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => { root.removeEventListener("wheel", onWheel); };
  }, [domainDuration, domainStart, fullDuration, mode, model]);

  if (model === null) {
    return (
      <section ref={rootRef} className={css.root} aria-label={t("timeline.aria")}>
        <div className={css.plot}>
          <LaneLabels t={t} />
          <div className={css.track}>
            <span className={css.empty}>{t("timeline.noTimingData")}</span>
            {hasEarlierRecords && (
              <EarlierHistoryBoundary
                loading={loadingEarlier}
                onHover={() => { setHover(null); }}
                onLoad={loadEarlier}
                t={t}
              />
            )}
          </div>
        </div>
      </section>
    );
  }

  const minimumSelectionDuration = Math.min(domainDuration, fullDuration / model.spans.length);

  const fractionAt = (event: PointerEvent<HTMLDivElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    return clampFraction((event.clientX - rect.left) / Math.max(1, rect.width));
  };

  const recordIndexAt = (event: PointerEvent<HTMLDivElement>): number | null => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const value = target?.closest<HTMLElement>("[data-timeline-record-index]")?.dataset.timelineRecordIndex;
    if (value === undefined) return null;
    const index = Number(value);
    return Number.isFinite(index) ? index : null;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 2) {
      panRef.current = {
        anchorClientX: event.clientX,
        anchorStart: domainStart,
        moved: false,
        pannable: viewport !== null,
        pointerId: event.pointerId,
      };
      if (viewport !== null) setAnimateViewport(false);
      setPanning(true);
      if (typeof event.currentTarget.setPointerCapture === "function") {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    if (event.button !== 0) return;
    const anchor = fractionAt(event);
    const anchorTime = domainStart + anchor * domainDuration;
    const recordIndex = recordIndexAt(event);
    setHover({ fraction: anchor, recordIndex });
    dragRef.current = {
      pointerId: event.pointerId,
      anchorTime,
      anchorClientX: event.clientX,
      recordIndex,
    };
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDraft({ start: anchorTime, end: anchorTime });
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = fractionAt(event);
    setHover({ fraction, recordIndex: recordIndexAt(event) });
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      if (Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX) pan.moved = true;
      if (!pan.pannable) return;
      const delta = (event.clientX - pan.anchorClientX) / Math.max(1, rect.width);
      const nextStart = Math.min(
        Math.max(pan.anchorStart - delta * domainDuration, model.start),
        model.end - domainDuration,
      );
      setViewport({ start: nextStart, end: nextStart + domainDuration });
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    let nextDomainStart = domainStart;
    if (viewport !== null) {
      // 放大状态下把指针拖到边缘，视口自动朝那个方向平移。
      const localX = event.clientX - rect.left;
      const edgeWidth = Math.min(MAXIMUM_EDGE_PAN_PX, Math.max(1, rect.width * EDGE_PAN_ZONE_FRACTION));
      const direction = localX < edgeWidth ? -1 : localX > rect.width - edgeWidth ? 1 : 0;
      if (direction !== 0) {
        const edgeDistance = direction < 0 ? edgeWidth - localX : localX - (rect.width - edgeWidth);
        const strength = clampFraction(edgeDistance / edgeWidth);
        const desiredStart = domainStart
          + direction * domainDuration * EDGE_PAN_STEP_FRACTION * Math.max(0.2, strength);
        nextDomainStart = Math.min(Math.max(desiredStart, model.start), model.end - domainDuration);
        if (nextDomainStart !== domainStart) {
          setAnimateViewport(false);
          setViewport({ start: nextDomainStart, end: nextDomainStart + domainDuration });
        }
      }
    }
    const pointTime = nextDomainStart + fraction * domainDuration;
    setDraft(orderedRange(drag.anchorTime, pointTime));
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan !== null && pan.pointerId === event.pointerId) {
      const moved = pan.moved || Math.abs(event.clientX - pan.anchorClientX) >= MINIMUM_DRAG_PX;
      panRef.current = null;
      setPanning(false);
      if (!moved) onRangeChange(null);
      return;
    }
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const pointFraction = fractionAt(event);
    const pointTime = domainStart + pointFraction * domainDuration;
    const selected = orderedRange(drag.anchorTime, pointTime);
    setHover({ fraction: pointFraction, recordIndex: recordIndexAt(event) });
    dragRef.current = null;
    setDraft(null);
    const click = Math.abs(event.clientX - drag.anchorClientX) < MINIMUM_DRAG_PX;
    const clickedSpan = click && drag.recordIndex !== null
      ? model.spans.find((span) => span.index === drag.recordIndex)
      : undefined;
    if (clickedSpan !== undefined) {
      onRangeChange(null);
      onRecordSelect?.(clickedSpan.index);
      return;
    }
    const committedRange = selected.end - selected.start < minimumSelectionDuration
      ? centeredRange(
        click ? selected.start : (selected.start + selected.end) / 2,
        minimumSelectionDuration,
        model.start,
        model.end,
      )
      : selected;
    onRangeChange(committedRange);
    if (click) {
      const timelinePoint = selected.start;
      const nearest = model.spans.reduce((candidate, span) => {
        const candidateDistance = timelinePoint < candidate.start
          ? candidate.start - timelinePoint
          : timelinePoint > candidate.end ? timelinePoint - candidate.end : 0;
        const spanDistance = timelinePoint < span.start
          ? span.start - timelinePoint
          : timelinePoint > span.end ? timelinePoint - span.end : 0;
        return spanDistance < candidateDistance ? span : candidate;
      });
      onRecordFocus?.(nearest.index);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || range === null) return;
    event.preventDefault();
    onRangeChange(null);
  };

  const onPointerCancel = () => {
    dragRef.current = null;
    panRef.current = null;
    setDraft(null);
    setHover(null);
    setPanning(false);
  };

  return (
    <section ref={rootRef} className={css.root} aria-label={t("timeline.aria")}>
      <div className={css.plot}>
        <LaneLabels t={t} />
        <div
          ref={trackRef}
          className={css.track}
          data-panning={panning || undefined}
          aria-label={t("timeline.overviewAria")}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => {
            if (dragRef.current === null && panRef.current === null) setHover(null);
          }}
          onDoubleClick={(event) => {
            event.preventDefault();
            onRangeChange(null);
          }}
          onContextMenu={(event) => { event.preventDefault(); }}
        >
          {showsEarlierBoundary && (
            <EarlierHistoryBoundary
              loading={loadingEarlier}
              onHover={() => { setHover(null); }}
              onLoad={loadEarlier}
              t={t}
            />
          )}
          {hover !== null && hover.recordIndex === null && draft === null && (
            <div
              className={css.hoverLine}
              aria-hidden="true"
              style={{ "--trajectory-hover-left": `${hover.fraction * 100}%` } as CSSProperties}
            />
          )}
          {visibleRange !== null && (
            <>
              <div
                className={css.selection}
                data-dragging={draft === null ? undefined : "true"}
                aria-hidden="true"
                style={{
                  "--trajectory-selection-left": `${visibleRange.start * 100}%`,
                  "--trajectory-selection-width": `${(visibleRange.end - visibleRange.start) * 100}%`,
                } as CSSProperties}
              />
              <div
                className={css.selectionEdges}
                data-dragging={draft === null ? undefined : "true"}
                aria-hidden="true"
                style={{
                  "--trajectory-selection-left": `${visibleRange.start * 100}%`,
                  "--trajectory-selection-width": `${(visibleRange.end - visibleRange.start) * 100}%`,
                } as CSSProperties}
              />
            </>
          )}
          <div
            className={css.turnBoundaries}
            data-animate-viewport={animateViewport || undefined}
            aria-hidden="true"
            style={projectedDomainStyle}
          >
            {model.turnBoundaries
              .filter((boundary) =>
                boundary.time > model.start
                && boundary.time >= domainStart
                && boundary.time <= domainStart + domainDuration)
              .map((boundary) => (
                <span
                  className={css.turnBoundary}
                  key={boundary.turn}
                  style={{
                    "--trajectory-turn-left": `${(boundary.time - model.start) / fullDuration * 100}%`,
                  } as CSSProperties}
                />
              ))}
          </div>
          <div
            className={css.lanes}
            data-animate-viewport={animateViewport || undefined}
            style={projectedDomainStyle}
          >
            {model.spans
              .filter((span) =>
                span.index === selectedIndex
                || (span.end >= domainStart && span.start <= domainStart + domainDuration))
              .map((span) => {
                const left = (span.start - model.start) / fullDuration;
                const widthPercent = (span.end - span.start) / fullDuration * 100;
                const hovered = hover?.recordIndex === span.index;
                return (
                  <span
                    key={span.index}
                    aria-hidden="true"
                    className={css.span}
                    data-timeline-span={span.kind}
                    data-timeline-record-index={span.index}
                    data-error={span.isError || undefined}
                    data-equal-duration={mode === "sequence" || undefined}
                    data-current={span.index === selectedIndex || undefined}
                    data-hovered={hovered || undefined}
                    data-search-match={searchMatchIndexes === null
                      ? undefined
                      : searchMatchIndexes.has(span.index) ? "true" : "false"}
                    data-selected={activeRange === null
                      ? undefined
                      : span.start <= activeRange.end && span.end >= activeRange.start ? "true" : "false"}
                    title={hovered ? timelineTooltipLabel(span.kind, detailByIndex.get(span.index), t) : undefined}
                    style={{
                      "--trajectory-span-left": `${left * 100}%`,
                      "--trajectory-span-width": `${widthPercent}%`,
                      "--trajectory-span-gap": `min(${widthPercent * 0.08}%, 1px)`,
                      "--trajectory-span-lane": span.lane,
                    } as CSSProperties}
                  />
                );
              })}
          </div>
        </div>
      </div>
    </section>
  );
});
