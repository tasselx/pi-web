"use client";

import { useMemo } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  buildContextBreakdown,
  EMPTY_MESSAGE_CONTEXT_SUMMARY,
  type ContextCategoryId,
  type ContextUsageInfo,
  type MessageContextSummary,
} from "@/lib/context-breakdown";
import type { ToolEntry } from "@/lib/tool-presets";

interface Props {
  systemPrompt: string | null;
  tools: ToolEntry[] | null;
  loading: boolean;
  messageSummary?: MessageContextSummary | null;
  contextUsage?: ContextUsageInfo | null;
  onSelectTab?: (tab: "system" | "tools") => void;
}

export function ContextBreakdownPanel({
  systemPrompt,
  tools,
  loading,
  messageSummary,
  contextUsage,
  onSelectTab,
}: Props) {
  const { t } = useI18n();
  const summary = messageSummary ?? EMPTY_MESSAGE_CONTEXT_SUMMARY;

  const breakdown = useMemo(
    () =>
      buildContextBreakdown({
        systemPrompt,
        tools,
        messageSummary: summary,
        contextUsage,
      }),
    [systemPrompt, tools, summary, contextUsage],
  );

  const getCategoryLabel = (id: ContextCategoryId): string => {
    switch (id) {
      case "system":
        return t("context.category.system");
      case "tools":
        return t("context.category.tools", { count: breakdown.activeToolCount });
      case "compaction":
        return t("context.category.compaction");
      case "user":
        return t("context.category.user", { count: summary.userCount });
      case "assistant":
        return t("context.category.assistant", { count: summary.assistantCount });
      case "thinking":
        return t("context.category.thinking");
      case "toolTraffic":
        return t("context.category.toolTraffic", { count: summary.toolCallCount });
    }
  };

  const hasWindow = breakdown.contextWindow !== null && breakdown.contextWindow > 0;
  const isScaled = breakdown.reportedTokens !== null && breakdown.estimatedTokens > 0;

  return (
    <div style={{ padding: "10px 14px 14px", fontSize: 12 }}>
      {/* Top summary row */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 15,
              fontWeight: 600,
              color: "var(--text)",
            }}
          >
            {breakdown.usedTokens.toLocaleString()}
          </span>
          {hasWindow && (
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              / {breakdown.contextWindow!.toLocaleString()} tokens
              {breakdown.usedPercent !== null && (
                <span style={{ marginLeft: 6, color: "var(--text-dim)" }}>
                  ({breakdown.usedPercent.toFixed(1)}%)
                </span>
              )}
            </span>
          )}
          {!hasWindow && (
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              tokens
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {breakdown.freeTokens !== null && (
            <span style={{ color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              {t("context.free")}: {breakdown.freeTokens.toLocaleString()}
            </span>
          )}
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 4,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              color: "var(--text-dim)",
            }}
          >
            {isScaled ? t("context.scaledBadge") : t("context.estimatedBadge")}
          </span>
        </div>
      </div>

      {/* Stacked visual progress bar */}
      <div
        role="img"
        aria-label={t("context.title")}
        style={{
          display: "flex",
          height: 12,
          borderRadius: 6,
          overflow: "hidden",
          background: "var(--bg)",
          border: "1px solid var(--border)",
          marginBottom: 12,
        }}
      >
        {breakdown.categories.map((cat) => {
          const widthPct = hasWindow
            ? Math.max(0, Math.min(100, cat.percentOfWindow ?? 0))
            : Math.max(0, Math.min(100, cat.shareOfUsed * 100));
          if (widthPct <= 0) return null;
          return (
            <div
              key={cat.id}
              title={`${getCategoryLabel(cat.id)}: ${cat.tokens.toLocaleString()} tokens`}
              style={{
                width: `${widthPct}%`,
                minWidth: cat.tokens > 0 ? 3 : 0,
                background: cat.color,
                transition: "width 0.2s ease",
              }}
            />
          );
        })}
      </div>

      {/* Category breakdown rows */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          paddingBottom: 10,
          borderBottom: "1px solid var(--border)",
        }}
      >
        {breakdown.categories.map((cat) => {
          const pct = hasWindow ? cat.percentOfWindow : cat.shareOfUsed * 100;
          const isClickable =
            onSelectTab && (cat.id === "system" || cat.id === "tools");
          return (
            <div
              key={cat.id}
              onClick={
                isClickable
                  ? () => onSelectTab(cat.id as "system" | "tools")
                  : undefined
              }
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
                padding: "3px 6px",
                borderRadius: 4,
                cursor: isClickable ? "pointer" : "default",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: cat.color,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    color: "var(--text)",
                    textDecoration: isClickable ? "underline" : "none",
                    textDecorationColor: "var(--border)",
                    textUnderlineOffset: 3,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {getCategoryLabel(cat.id)}
                </span>
                {loading && (cat.id === "system" || cat.id === "tools") && cat.tokens === 0 && (
                  <span style={{ color: "var(--text-dim)", fontSize: 11 }}>…</span>
                )}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 8,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  flexShrink: 0,
                }}
              >
                <span style={{ color: "var(--text)" }}>
                  {cat.tokens.toLocaleString()}
                </span>
                {pct !== null && (
                  <span
                    style={{
                      color: "var(--text-dim)",
                      minWidth: 44,
                      textAlign: "right",
                    }}
                  >
                    {pct < 0.1 && pct > 0 ? "<0.1%" : `${pct.toFixed(1)}%`}
                  </span>
                )}
              </div>
            </div>
          );
        })}

        {breakdown.freeTokens !== null && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "3px 6px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  border: "1px solid var(--border)",
                  background: "var(--bg)",
                  flexShrink: 0,
                }}
              />
              <span style={{ color: "var(--text-muted)" }}>{t("context.free")}</span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "baseline",
                gap: 8,
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                flexShrink: 0,
              }}
            >
              <span style={{ color: "var(--text-muted)" }}>
                {breakdown.freeTokens.toLocaleString()}
              </span>
              {breakdown.usedPercent !== null && (
                <span
                  style={{
                    color: "var(--text-dim)",
                    minWidth: 44,
                    textAlign: "right",
                  }}
                >
                  {Math.max(0, 100 - breakdown.usedPercent).toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Top tool definitions & Top tool traffic in conversation */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          gap: 12,
          marginTop: 10,
        }}
      >
        {/* Top Tool Definitions */}
        <div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--text-dim)",
              marginBottom: 6,
            }}
          >
            {t("context.topToolDefs")}
          </div>
          {breakdown.toolDeclarations.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
              {loading ? t("tools.loading") : t("tools.noTools")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {breakdown.toolDeclarations.slice(0, 6).map((item) => (
                <div
                  key={item.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span
                    style={{
                      color: "var(--text-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={item.name}
                  >
                    {item.name}
                  </span>
                  <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                    ~{item.tokens.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top Tool Outputs in Conversation */}
        <div>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              color: "var(--text-dim)",
              marginBottom: 6,
            }}
          >
            {t("context.topToolTraffic")}
          </div>
          {breakdown.toolTrafficByTool.length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: 11 }}>
              {t("context.noToolTraffic")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {breakdown.toolTrafficByTool.slice(0, 6).map((item) => (
                <div
                  key={item.name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 8,
                    fontSize: 11,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  <span
                    style={{
                      color: "var(--text-muted)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={item.name}
                  >
                    {item.name}{" "}
                    <span style={{ color: "var(--text-dim)" }}>
                      ({t("context.toolCallsCount", { count: item.calls })})
                    </span>
                  </span>
                  <span style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                    ~{item.tokens.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
