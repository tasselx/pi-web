"use client";

/**
 * 轨迹工具栏：时间线用真实时长还是等宽、折叠 / 展开所有轮次、折叠 / 展开所有调用、搜索。
 *
 * 移植自 deepseek-ai/deepseek-harness 的 ui-trajectory/TrajectoryToolbar.tsx
 * （MIT，Copyright (c) 2026 DeepSeek）。上游那个默认隐藏的「实际时间」开关
 * 在它自己的界面里也不可见，不带过来（YAGNI）。
 */

import type { TrajectoryTranslate } from "@/lib/trajectory/record";
import css from "./TrajectoryToolbar.module.css";

export interface TrajectoryToolbarProps {
  /** 时间线是否按记录的真实时长画（否则每条等宽）。 */
  actualDuration: boolean;
  onActualDurationChange: (actualDuration: boolean) => void;
  /** 所有可折叠的轮次是否都已折叠。 */
  allTurnsCollapsed: boolean;
  onToggleAllTurns: () => void;
  /** 所有助手的工具调用是否都已折叠。 */
  allAssistantsCollapsed: boolean;
  onToggleAllAssistants: () => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  t: TrajectoryTranslate;
}

/**
 * 渲染工具栏。
 * @param props 各开关状态与回调
 */
export function TrajectoryToolbar({
  actualDuration,
  onActualDurationChange,
  allTurnsCollapsed,
  onToggleAllTurns,
  allAssistantsCollapsed,
  onToggleAllAssistants,
  searchQuery,
  onSearchQueryChange,
  t,
}: TrajectoryToolbarProps) {
  return (
    <div className={css.root} role="toolbar" aria-label={t("toolbar.aria")}>
      <div className={css.inner}>
        <div className={css.actions}>
          <button
            type="button"
            className={css.toggle}
            aria-label={t("toolbar.useActualDuration")}
            aria-pressed={actualDuration}
            title={actualDuration ? t("toolbar.useEqualWidth") : t("toolbar.useActualDuration")}
            onClick={() => { onActualDurationChange(!actualDuration); }}
          >
            <svg className={css.toggleIcon} viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="8" cy="8" r="5.25" />
              <path d="M8 4.75V8l2.25 1.5" />
            </svg>
            {t("toolbar.duration")}
          </button>
          <button
            type="button"
            className={css.action}
            aria-label={allTurnsCollapsed ? t("toolbar.expandTurns") : t("toolbar.collapseTurns")}
            aria-pressed={allTurnsCollapsed}
            title={allTurnsCollapsed ? t("toolbar.expandTurns") : t("toolbar.collapseTurns")}
            onClick={onToggleAllTurns}
          >
            <span className={css.actionIcon} aria-hidden="true">{allTurnsCollapsed ? "⊞" : "⊟"}</span>
            {t("toolbar.turns")}
          </button>
          <button
            type="button"
            className={css.action}
            aria-label={allAssistantsCollapsed ? t("toolbar.expandCalls") : t("toolbar.collapseCalls")}
            aria-pressed={allAssistantsCollapsed}
            title={allAssistantsCollapsed ? t("toolbar.expandCalls") : t("toolbar.collapseCalls")}
            onClick={onToggleAllAssistants}
          >
            <span className={css.actionIcon} aria-hidden="true">{allAssistantsCollapsed ? "⊞" : "⊟"}</span>
            {t("toolbar.calls")}
          </button>
        </div>
        <div className={css.search}>
          <svg className={css.searchIcon} width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className={css.searchInput}
            aria-label={t("toolbar.search")}
            placeholder={t("toolbar.searchPlaceholder")}
            value={searchQuery}
            onChange={(event) => { onSearchQueryChange(event.currentTarget.value); }}
          />
        </div>
      </div>
    </div>
  );
}
