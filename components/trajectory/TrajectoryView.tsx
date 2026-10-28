"use client";

/**
 * 「轨迹」视图：一个会话的轨迹，盖在聊天区的消息列表上（顶栏「对话 | 轨迹」切换，
 * 输入框保留在下面），会话运行时随之实时更新。
 *
 * 结构与状态机移植自 deepseek-ai/deepseek-harness 的 ui-trajectory（MIT，Copyright (c) 2026
 * DeepSeek）的 TrajectoryView：工具栏 → 时间线 → 记录列表 | 检查器；折叠、搜索、时间线框选、
 * 列表选中之间的联动同上游。数据来自 pi 自己的会话（hooks/useTrajectoryTranscript.ts），
 * 在 lib/trajectory/derive.ts 里派生成同样的「轮次 → 分组 → 记录」。
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useTrajectoryTranscript } from "@/hooks/useTrajectoryTranscript";
import { deriveTrajectoryLayout } from "@/lib/trajectory/derive";
import {
  collapseAssistantRecords, collapseTurnRecords, collapsibleAssistantIds, collapsibleTurnIds,
  filterRecords, flattenRecords,
} from "@/lib/trajectory/ledger";
import { formatDuration, type TrajectoryTranslate } from "@/lib/trajectory/record";
import { TrajectorySearchIndex } from "@/lib/trajectory/search-index";
import {
  trajectoryTimelineFocusIndexes, type TrajectoryTimelineMode, type TrajectoryTimeRange,
} from "@/lib/trajectory/timeline";
import { TrajectoryInspector } from "./TrajectoryInspector";
import { TrajectoryLedger } from "./TrajectoryLedger";
import { TrajectoryTimeline } from "./TrajectoryTimeline";
import { TrajectoryToolbar } from "./TrajectoryToolbar";
import css from "./TrajectoryView.module.css";

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * 只收两个原始值的 props 并 memo：AppShell 随流式输出、输入等频繁重渲染，
 * 不该每次都带着整个轨迹（成百上千条记录）重新派生。
 * @param sessionId 要看的会话 id
 * @param running 该会话此刻是否在运行（AppShell 已有的运行状态，决定是否实时更新）
 */
export const TrajectoryView = memo(function TrajectoryView({ sessionId, running }: {
  sessionId: string;
  running: boolean;
}) {
  const { t } = useI18n();
  // 移植来的模块调用不带前缀的键（如 toolbar.duration）；这里统一加上 trajectory. 前缀。
  const tt = useMemo<TrajectoryTranslate>(() => (key, params) => t(`trajectory.${key}`, params), [t]);
  const data = useTrajectoryTranscript(sessionId, running);
  const { transcript, status, loadEarlier } = data;

  const [actualDuration, setActualDuration] = useState(false);
  const [timelineRange, setTimelineRange] = useState<TrajectoryTimeRange | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(() => new Set());
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(() => new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollRequest, setScrollRequest] = useState<{ readonly index: number } | null>(null);

  const turns = useMemo(
    () => deriveTrajectoryLayout(transcript.messages, transcript.entryIds, tt, running),
    [transcript.messages, transcript.entryIds, tt, running],
  );
  const allRecords = useMemo(() => flattenRecords(turns), [turns]);
  const mode: TrajectoryTimelineMode = actualDuration ? "duration" : "sequence";

  const searchIndex = useMemo(() => new TrajectorySearchIndex(), []);
  const searchMatchIndexes = useMemo(() => {
    if (searchQuery.trim() === "") return null;
    searchIndex.update(turns);
    const ids = searchIndex.search(searchQuery);
    if (ids === null) return null;
    const indexes = new Set<number>();
    for (const record of allRecords) {
      if (ids.has(record.cell.recordId)) indexes.add(record.cell.index);
    }
    return indexes;
  }, [allRecords, searchIndex, searchQuery, turns]);

  const timelineFocusIndexes = useMemo(
    () => timelineRange === null ? null : trajectoryTimelineFocusIndexes(turns, timelineRange, mode),
    [mode, timelineRange, turns],
  );

  const visibleRecords = useMemo(() => {
    // 搜索时只过滤、不折叠：命中的记录不能被折叠藏起来（同上游）。
    if (searchMatchIndexes !== null) return filterRecords(allRecords, searchMatchIndexes);
    const byTurn = collapsedTurns.size === 0 ? allRecords : collapseTurnRecords(allRecords, collapsedTurns, tt);
    return collapsedAssistants.size === 0 ? byTurn : collapseAssistantRecords(byTurn, collapsedAssistants, tt);
  }, [allRecords, collapsedAssistants, collapsedTurns, searchMatchIndexes, tt]);

  const turnIds = useMemo(() => collapsibleTurnIds(turns), [turns]);
  const assistantIds = useMemo(() => collapsibleAssistantIds(turns), [turns]);
  const collapsibleAssistants = useMemo<ReadonlySet<string>>(() => new Set(assistantIds), [assistantIds]);
  const allTurnsCollapsed = turnIds.length > 0 && turnIds.every((turn) => collapsedTurns.has(turn));
  const allAssistantsCollapsed = assistantIds.length > 0 && assistantIds.every((id) => collapsedAssistants.has(id));

  const selected = useMemo(
    () => selectedId === null ? null : allRecords.find((record) => record.cell.recordId === selectedId) ?? null,
    [allRecords, selectedId],
  );

  const sectionLabel = useCallback(
    (turn: number | null) => turn === null ? tt("section.betweenTurns") : tt("turn.label", { turn }),
    [tt],
  );

  // 框选出区间后，把区间内第一条记录滚进视野。只在区间变化时触发，不随实时更新重复滚动。
  const visibleRecordsRef = useRef(visibleRecords);
  visibleRecordsRef.current = visibleRecords;
  useEffect(() => {
    if (timelineFocusIndexes === null || timelineFocusIndexes.size === 0) return;
    const first = visibleRecordsRef.current.find(
      (record) => record.collapsedSummary === undefined && timelineFocusIndexes.has(record.cell.index),
    );
    if (first) setScrollRequest({ index: first.cell.index });
  }, [timelineFocusIndexes]);

  const handleSelect = useCallback((recordId: string | null) => {
    setSelectedId(recordId);
    // 选了区间外的行：区间不再有意义，清掉（同上游）。
    if (recordId === null || timelineFocusIndexes === null) return;
    const record = allRecords.find((candidate) => candidate.cell.recordId === recordId);
    if (record && !timelineFocusIndexes.has(record.cell.index)) setTimelineRange(null);
  }, [allRecords, timelineFocusIndexes]);

  const handleTimelineSelect = useCallback((index: number) => {
    setTimelineRange(null);
    const record = allRecords.find((candidate) => candidate.cell.index === index);
    if (record) {
      setSelectedId(record.cell.recordId);
      // 它可能躲在折叠的一轮或折叠的工具调用里：展开，否则滚动请求找不到那一行。
      const { turn } = record;
      if (turn !== null) {
        setCollapsedTurns((current) => {
          if (!current.has(turn)) return current;
          const next = new Set(current);
          next.delete(turn);
          return next;
        });
      }
      // 工具调用的 recordId 是「助手条目 id:调用 id」，据此找到折叠着它的那条助手记录。
      setCollapsedAssistants((current) => {
        const owner = [...current].find((id) => record.cell.recordId.startsWith(`${id}:`));
        if (owner === undefined) return current;
        const next = new Set(current);
        next.delete(owner);
        return next;
      });
    }
    setScrollRequest({ index });
  }, [allRecords]);

  const handleTimelineFocus = useCallback((index: number) => {
    setScrollRequest({ index });
  }, []);

  const toggleTurn = useCallback((turn: number) => {
    setCollapsedTurns((current) => toggled(current, turn));
  }, []);
  const toggleAssistant = useCallback((recordId: string) => {
    setCollapsedAssistants((current) => toggled(current, recordId));
  }, []);
  const toggleAllTurns = useCallback(() => {
    setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(turnIds));
  }, [allTurnsCollapsed, turnIds]);
  const toggleAllAssistants = useCallback(() => {
    setCollapsedAssistants(allAssistantsCollapsed ? new Set() : new Set(assistantIds));
  }, [allAssistantsCollapsed, assistantIds]);
  const handleActualDurationChange = useCallback((next: boolean) => {
    setActualDuration(next);
    setTimelineRange(null); // 区间是投影坐标里的值，换投影后不再对应
  }, []);

  // 页头的汇总：只算已加载的这一段。
  const stats = useMemo(() => {
    let calls = 0;
    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    for (const record of allRecords) {
      const { cell } = record;
      if (cell.kind === "tool") calls += 1;
      if (typeof cell.startedAt !== "number") continue;
      first = Math.min(first, cell.startedAt);
      last = Math.max(last, cell.startedAt + (cell.timeSeconds ?? 0) * 1000);
    }
    return {
      calls,
      turns: turns.filter((turn) => turn.turn !== null).length,
      duration: last > first ? formatDuration(last - first) : null,
    };
  }, [allRecords, turns]);

  let body: ReactNode;
  if (status === "loading") {
    body = <p className={css.state}>{tt("state.loading")}</p>;
  } else if (status === "notFound") {
    body = <p className={css.state}>{tt("state.notFound")}</p>;
  } else if (status === "error") {
    body = (
      <div className={css.state}>
        <p>{tt("state.error", { message: data.error ?? "" })}</p>
        <button type="button" className={css.button} onClick={data.retry}>{tt("state.retry")}</button>
      </div>
    );
  } else if (allRecords.length === 0) {
    body = <p className={css.state}>{tt("state.empty")}</p>;
  } else {
    body = (
      <>
        <TrajectoryToolbar
          t={tt}
          actualDuration={actualDuration}
          onActualDurationChange={handleActualDurationChange}
          allTurnsCollapsed={allTurnsCollapsed}
          onToggleAllTurns={toggleAllTurns}
          allAssistantsCollapsed={allAssistantsCollapsed}
          onToggleAllAssistants={toggleAllAssistants}
          searchQuery={searchQuery}
          onSearchQueryChange={setSearchQuery}
        />
        <TrajectoryTimeline
          t={tt}
          turns={turns}
          mode={mode}
          range={timelineRange}
          hasEarlierRecords={transcript.hasMore}
          onLoadEarlier={loadEarlier}
          selectedIndex={selected?.cell.index ?? null}
          searchMatchIndexes={searchMatchIndexes}
          onRangeChange={setTimelineRange}
          onRecordSelect={handleTimelineSelect}
          onRecordFocus={handleTimelineFocus}
        />
        <div className={css.split}>
          {/* 搜索开关各换一份列表：key 让账本窗口从头算。否则搜到一条早期记录后清空搜索，
              窗口还钉在那条记录上，会把它之后的几千行一次全挂出来。 */}
          <TrajectoryLedger
            key={searchMatchIndexes === null ? "all" : "matches"}
            t={tt}
            records={visibleRecords}
            selectedId={selected?.cell.recordId ?? null}
            focusIndexes={timelineFocusIndexes}
            collapsedAssistants={collapsedAssistants}
            collapsibleAssistants={collapsibleAssistants}
            hasEarlier={transcript.hasMore}
            onLoadEarlier={loadEarlier}
            scrollRequest={scrollRequest}
            onSelect={handleSelect}
            onToggleTurn={toggleTurn}
            onToggleAssistant={toggleAssistant}
            sectionLabel={sectionLabel}
          />
          {selected && (
            <TrajectoryInspector
              t={tt}
              cell={selected.cell}
              title={`${sectionLabel(selected.turn)} · ${selected.group}`}
              onClose={() => { setSelectedId(null); }}
            />
          )}
        </div>
      </>
    );
  }

  return (
    <div className={css.view}>
      <header className={css.header}>
        {running && <span className={css.live}>{tt("header.running")}</span>}
        {status === "ready" && allRecords.length > 0 && (
          <span className={css.stats} title={transcript.hasMore ? tt("stats.loadedOnly") : undefined}>
            {stats.duration && <span>{tt("stats.duration")} {stats.duration}</span>}
            <span>{tt("stats.turns")} {stats.turns}</span>
            <span>{tt("stats.calls")} {stats.calls}</span>
          </span>
        )}
        {/* 左边是状态，右边是后台更新失败的警告；会话标题侧栏里已有，这里不再重复。
            没有「刷新」按钮：打开时、运行中、回到前台时都会自动并入最新的（hooks/useTrajectoryTranscript.ts）。 */}
        <span className={css.spacer} />
        {data.error && status === "ready" && (
          <span className={css.warn} title={data.error}>{tt("state.refreshFailed")}</span>
        )}
      </header>
      {body}
    </div>
  );
});
