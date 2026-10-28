"use client";

import { useRef, type KeyboardEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { MessageIcon } from "./SidebarIcons";
import css from "./ChatViewTabs.module.css";

export type ChatView = "chat" | "trajectory";

/** 「轨迹」标签和它的面板（ChatWindow 里盖在消息列表上的那一层）互相指认用的 id。 */
export const TRAJECTORY_TAB_ID = "chat-view-tab-trajectory";
export const TRAJECTORY_PANEL_ID = "chat-view-panel-trajectory";

interface ChatViewTabsProps {
  view: ChatView;
  onChange: (view: ChatView) => void;
  /** 没有会话可看时（新会话的空白输入框），「轨迹」不可选。 */
  trajectoryDisabled: boolean;
  /** 指针移上 / 聚焦 / 触到「轨迹」标签：多半马上要点它，调用方趁这点时间把代码和数据先备好。 */
  onTrajectoryIntent?: () => void;
  /** 手机顶栏：只画图标，每个标签这么宽（px）；不给就是桌面的图标加文字。 */
  iconWidth?: number;
}

/**
 * 顶栏的「对话 | 轨迹」切换：同一个聊天区里换视图，不开新标签页。
 * 键盘行为同侧栏的「会话 | 文件」：← → Home End 切换并把焦点带过去。
 */
export function ChatViewTabs({ view, onChange, trajectoryDisabled, onTrajectoryIntent, iconWidth }: ChatViewTabsProps) {
  const { t } = useI18n();
  const chatRef = useRef<HTMLButtonElement>(null);
  const trajectoryRef = useRef<HTMLButtonElement>(null);
  const iconOnly = iconWidth !== undefined;
  const iconStyle = iconOnly ? { width: iconWidth } : undefined;
  const chatTitle = t("chatView.chat");
  const trajectoryTitle = trajectoryDisabled ? t("chatView.trajectoryUnavailable") : t("chatView.trajectory");

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight" && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next: ChatView = event.key === "Home" ? "chat"
      : event.key === "End" ? "trajectory"
      : view === "chat" ? "trajectory" : "chat";
    if (next === "trajectory" && trajectoryDisabled) return;
    onChange(next);
    (next === "chat" ? chatRef : trajectoryRef).current?.focus();
  };

  return (
    <div className={css.tabs} role="tablist" aria-label={t("chatView.tabsLabel")}>
      <button
        ref={chatRef}
        type="button"
        role="tab"
        aria-selected={view === "chat"}
        aria-label={iconOnly ? chatTitle : undefined}
        tabIndex={view === "chat" ? 0 : -1}
        title={chatTitle}
        className={css.tab}
        style={iconStyle}
        data-icon-only={iconOnly || undefined}
        data-mobile-toolbar-action={iconOnly ? "chat" : undefined}
        onClick={() => onChange("chat")}
        onKeyDown={handleKeyDown}
      >
        <MessageIcon size={12} />
        {!iconOnly && <span>{chatTitle}</span>}
      </button>
      <button
        ref={trajectoryRef}
        type="button"
        role="tab"
        id={TRAJECTORY_TAB_ID}
        aria-selected={view === "trajectory"}
        aria-controls={view === "trajectory" ? TRAJECTORY_PANEL_ID : undefined}
        aria-label={iconOnly ? trajectoryTitle : undefined}
        tabIndex={view === "trajectory" ? 0 : -1}
        disabled={trajectoryDisabled}
        title={trajectoryTitle}
        className={css.tab}
        style={iconStyle}
        data-icon-only={iconOnly || undefined}
        data-mobile-toolbar-action={iconOnly ? "trajectory" : undefined}
        onClick={() => onChange("trajectory")}
        onPointerEnter={onTrajectoryIntent}
        onFocus={onTrajectoryIntent}
        onKeyDown={handleKeyDown}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0 }}
          aria-hidden="true"
        >
          {/* 轨迹：一条连着两个点的路径（原来的「时钟回拨」是历史的意象，和「轨迹」对不上） */}
          <circle cx="6" cy="19" r="3" />
          <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
          <circle cx="18" cy="5" r="3" />
        </svg>
        {!iconOnly && <span>{t("chatView.trajectory")}</span>}
      </button>
    </div>
  );
}
