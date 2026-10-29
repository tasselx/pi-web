"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ToolEntry } from "@/lib/tool-presets";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const TABS = ["overview", "system", "tools"] as const;
type SessionInfoTab = (typeof TABS)[number];

/** 后两页的名字沿用各自面板的标题，不另起一套说法。 */
const TAB_LABEL_KEY: Record<SessionInfoTab, string> = {
  overview: "session.overview",
  system: "system.prompt",
  tools: "tools.title",
};

interface SessionInfoPanelProps {
  /** 「概览」页：会话、项目、消息、Token。AppShell 按当前统计算好；还没有统计时是一句提示。 */
  children: ReactNode;
  systemPrompt: string | null;
  tools: ToolEntry[] | null;
  systemInfoLoading: boolean;
  /** 切到「系统提示词」「工具定义」页时调用：调用方向会话取一次此刻的，免得看到旧的。 */
  onOpenSystemInfo: () => void;
  translate: Translate;
}

/**
 * 顶栏统计按钮展开的「会话信息」浮层。系统提示词、工具定义原来各占顶栏一个按钮，
 * 现在是它的两页：它们说的都是「这个会话发给模型的是什么」，和概览同属一件事。
 * 页签状态放在这里：浮层一关就卸载，下次打开总是从「概览」开始，AppShell 不用另记。
 * 浮层的外框（入场动画、背景、阴影）也在这里；类名 session-info-popover 保持不变，e2e 按它找。
 */
export function SessionInfoPanel({
  children,
  systemPrompt,
  tools,
  systemInfoLoading,
  onOpenSystemInfo,
  translate,
}: SessionInfoPanelProps) {
  const [tab, setTab] = useState<SessionInfoTab>("overview");
  const tabRefs = useRef<Partial<Record<SessionInfoTab, HTMLButtonElement | null>>>({});

  const select = (next: SessionInfoTab) => {
    setTab(next);
    if (next !== "overview") onOpenSystemInfo();
  };

  // 键盘行为同侧栏的「会话 | 文件」：← → Home End 切换并把焦点带过去。
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const at = TABS.indexOf(tab);
    const to = event.key === "ArrowRight" ? (at + 1) % TABS.length
      : event.key === "ArrowLeft" ? (at + TABS.length - 1) % TABS.length
      : event.key === "Home" ? 0
      : event.key === "End" ? TABS.length - 1
      : null;
    if (to === null) return;
    event.preventDefault();
    select(TABS[to]);
    tabRefs.current[TABS[to]]?.focus();
  };

  return (
    <div className="session-info-popover" style={{ background: "var(--bg-panel)", boxShadow: "0 10px 28px rgba(0,0,0,0.10)" }}>
      <div className="session-info-tabs" role="tablist" aria-label={translate("session.title")}>
        {TABS.map((id) => (
          <button
            key={id}
            ref={(element) => { tabRefs.current[id] = element; }}
            type="button"
            role="tab"
            id={`session-info-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="session-info-panel"
            tabIndex={tab === id ? 0 : -1}
            className="session-info-tab"
            onClick={() => select(id)}
            onKeyDown={handleKeyDown}
          >
            {translate(TAB_LABEL_KEY[id])}
          </button>
        ))}
      </div>
      <div id="session-info-panel" role="tabpanel" aria-labelledby={`session-info-tab-${tab}`}>
        {/* 另两页自带背景和下边线；概览是一块平铺的内容，边距和下边线在这里补。 */}
        {tab === "overview" && (
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>{children}</div>
        )}
        {tab === "system" && (
          <SystemPromptPanel loading={systemInfoLoading} prompt={systemPrompt} translate={translate} />
        )}
        {tab === "tools" && (
          <ToolDefinitionsPanel loading={systemInfoLoading} tools={tools} translate={translate} />
        )}
      </div>

      <style>{`
        @keyframes session-info-pop {
          0% {
            opacity: 0;
            transform: translateY(-24px);
            filter: blur(6px);
            box-shadow: 0 2px 8px rgba(0,0,0,0);
          }
          55% {
            opacity: 1;
            transform: translateY(0);
            filter: blur(0);
            background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
            box-shadow: 0 18px 44px rgba(37,99,235,0.16);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
            filter: blur(0);
            background: var(--bg-panel);
            box-shadow: 0 10px 28px rgba(0,0,0,0.10);
          }
        }
        @keyframes session-info-light-wash {
          0% {
            opacity: 0;
            transform: translateX(-110%) skewX(-16deg);
          }
          24% {
            opacity: 0.42;
          }
          100% {
            opacity: 0;
            transform: translateX(115%) skewX(-16deg);
          }
        }
        .session-info-popover {
          position: relative;
          overflow: hidden;
          transform-origin: top right;
          animation: session-info-pop 360ms ease-out both;
          will-change: transform, opacity, filter, background, box-shadow;
        }
        .session-info-popover::after {
          content: "";
          position: absolute;
          top: 0;
          bottom: 0;
          left: 0;
          width: 44%;
          pointer-events: none;
          background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
          animation: session-info-light-wash 620ms ease-out both;
        }
        @media (prefers-reduced-motion: reduce) {
          .session-info-popover,
          .session-info-popover::after {
            animation: none;
          }
        }
        /* 页签：面板自己的分区用下划线（同轨迹检查器的页签），和顶栏上顶线的「对话 | 轨迹」分出层级。 */
        .session-info-tabs {
          display: flex;
          flex: none;
          box-sizing: border-box;
          height: 34px;
          padding: 0 8px;
          gap: 1px;
          overflow-x: auto;
          overflow-y: hidden;
          border-bottom: 1px solid var(--border);
          scrollbar-width: none;
          white-space: nowrap;
        }
        .session-info-tabs::-webkit-scrollbar {
          display: none;
        }
        .session-info-tab {
          position: relative;
          flex: none;
          padding: 0 10px;
          border: 0;
          background: transparent;
          color: var(--text-muted);
          cursor: pointer;
          font: inherit;
          font-size: 12px;
        }
        @media (hover: hover) {
          .session-info-tab:hover {
            background: var(--bg-hover);
            color: var(--text);
          }
        }
        .session-info-tab[aria-selected='true'] {
          color: var(--accent);
        }
        .session-info-tab[aria-selected='true']::after {
          content: "";
          position: absolute;
          right: 10px;
          bottom: 0;
          left: 10px;
          height: 2px;
          border-radius: 1px 1px 0 0;
          background: var(--accent);
        }
        .session-info-tab:focus-visible {
          outline: 1px solid var(--accent);
          outline-offset: -1px;
        }
      `}</style>
    </div>
  );
}
