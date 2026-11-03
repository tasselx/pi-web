"use client";

/**
 * 记录检查器：选中一条记录后，在右侧看它的概述（来源、状态、Token、请求计时、思考）、
 * 渲染后的预览和原始 JSON。
 *
 * 版式参照 deepseek-ai/deepseek-harness 的 ui-trajectory 检查器（MIT，Copyright (c) 2026
 * DeepSeek）：头部（第 N 轮 · 第 N 步）、概述 / 预览 / 原始内容三个页签、思考可折叠、
 * 「请求计时」一节。pi 不记录首 token 时间，所以没有「首 token 延迟 / 生成 / 吞吐量」，
 * 改给一行「平均输出速度」（输出 token ÷ 总时长，注明包含等待首 token 的时间），不冒充吞吐。
 */

import { useMemo, useState, type ReactNode } from "react";
import { MarkdownBody } from "@/components/MarkdownBody";
import { copyText } from "@/lib/clipboard";
import type { ToolCallContent } from "@/lib/types";
import {
  formatElapsedSeconds, type TrajectoryCellKind, type TrajectoryCellProps, type TrajectoryTranslate,
} from "@/lib/trajectory/record";
import css from "./TrajectoryInspector.module.css";

type Tab = "summary" | "preview" | "raw";

const TABS: readonly Tab[] = ["summary", "preview", "raw"];
const TAB_KEY: Record<Tab, string> = { summary: "tab.summary", preview: "tab.preview", raw: "tab.raw" };
const KIND_LABEL_KEY: Record<TrajectoryCellKind, string> = {
  user: "kind.user",
  context: "kind.context",
  compacted: "kind.compacted",
  message: "kind.assistant",
  tool: "kind.tool",
};

/** 预览里最多渲染这么多字符：Markdown 解析 + 代码高亮对几 MB 的输出太重。 */
const PREVIEW_CHAR_LIMIT = 20_000;
/** 原始内容最多显示这么多字符；复制按钮仍复制全部。 */
const RAW_CHAR_LIMIT = 200_000;

interface Clipped {
  text: string;
  total: number;
  truncated: boolean;
}

function clip(text: string, limit: number): Clipped {
  return text.length > limit
    ? { text: text.slice(0, limit), total: text.length, truncated: true }
    : { text, total: text.length, truncated: false };
}

/** 用比正文里最长反引号串更长的围栏包起来，正文里自带的 ``` 不会提前结束它。 */
function fenced(text: string, lang = ""): string {
  const longest = (text.match(/`+/g) ?? []).reduce((most, run) => Math.max(most, run.length), 0);
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}${lang}\n${text}\n${fence}`;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

function formatStarted(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  });
}

function sourceLabel(cell: TrajectoryCellProps, t: TrajectoryTranslate): string {
  switch (cell.kind) {
    case "message": return cell.provider ? `${cell.provider} / ${cell.model ?? ""}` : t("kind.assistant");
    case "tool": return cell.toolName ?? t("kind.tool");
    case "context": {
      const customType = (cell.raw as { customType?: unknown } | undefined)?.customType;
      return typeof customType === "string" ? customType : t("kind.context");
    }
    default: return t(KIND_LABEL_KEY[cell.kind]);
  }
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className={css.row}>
      <dt className={css.label} title={hint}>{label}</dt>
      <dd className={css.value}>{children}</dd>
    </div>
  );
}

function TruncationNote({ clipped, t }: { clipped: Clipped; t: TrajectoryTranslate }) {
  if (!clipped.truncated) return null;
  return (
    <p className={css.note}>
      {t("record.truncated", { shown: clipped.text.length.toLocaleString(), total: clipped.total.toLocaleString() })}
    </p>
  );
}

function Summary({ cell, t }: { cell: TrajectoryCellProps; t: TrajectoryTranslate }) {
  const [thinkingOpen, setThinkingOpen] = useState(true);
  const isAssistant = cell.kind === "message";
  const state = cell.isError ? "error" : cell.running ? "pending" : cell.interrupted ? "interrupted" : "done";
  const status = t(`status.${state}`);
  const hasUsage = isAssistant && (cell.input !== undefined || cell.output !== undefined);
  const speed = isAssistant && cell.output !== undefined && cell.timeSeconds !== null && cell.timeSeconds > 0
    ? cell.output / cell.timeSeconds
    : null;
  const tokensBefore = cell.kind === "compacted"
    ? (cell.raw as { details?: { tokensBefore?: unknown } } | undefined)?.details?.tokensBefore
    : undefined;
  const thinking = useMemo(() => clip(cell.thinkingDetail ?? "", PREVIEW_CHAR_LIMIT), [cell.thinkingDetail]);

  return (
    <div className={css.summary}>
      <dl className={css.rows}>
        <Row label={t("details.source")}>{sourceLabel(cell, t)}</Row>
        <Row label={t("details.status")}>
          <span className={css.status} data-state={state}>{status}</span>
        </Row>
        {cell.stopReason && <Row label={t("details.stopReason")}>{cell.stopReason}</Row>}
        {typeof tokensBefore === "number" && (
          <Row label={t("details.tokensBefore")}>{tokensBefore.toLocaleString()}</Row>
        )}
      </dl>

      {hasUsage && (
        <section className={css.section}>
          <h4 className={css.heading}>{t("usage.tokens")}</h4>
          <dl className={css.rows}>
            {cell.input !== undefined && <Row label={t("usage.input")}>{cell.input.toLocaleString()}</Row>}
            {cell.cacheRead !== undefined && <Row label={t("usage.cached")}>{cell.cacheRead.toLocaleString()}</Row>}
            {cell.cacheWrite !== undefined && <Row label={t("usage.cacheCreated")}>{cell.cacheWrite.toLocaleString()}</Row>}
            {cell.output !== undefined && <Row label={t("usage.output")}>{cell.output.toLocaleString()}</Row>}
            {cell.cost !== undefined && <Row label={t("usage.cost")}>{`$${cell.cost.toFixed(4)}`}</Row>}
          </dl>
        </section>
      )}

      {(typeof cell.startedAt === "number" || cell.timeSeconds !== null) && (
        <section className={css.section}>
          <h4 className={css.heading}>{t("timing.request")}</h4>
          <dl className={css.rows}>
            {typeof cell.startedAt === "number" && <Row label={t("timing.started")}>{formatStarted(cell.startedAt)}</Row>}
            {cell.timeSeconds !== null && (
              <Row label={t("timing.totalDuration")}>{formatElapsedSeconds(cell.timeSeconds)}</Row>
            )}
            {speed !== null && (
              <Row label={t("timing.avgSpeed")} hint={t("timing.avgSpeedHint")}>
                {t("unit.tokensPerSecond", { value: speed.toFixed(1) })}
              </Row>
            )}
          </dl>
        </section>
      )}

      {thinking.total > 0 && (
        <section className={css.section}>
          <button
            type="button"
            className={css.disclosure}
            aria-expanded={thinkingOpen}
            onClick={() => { setThinkingOpen((open) => !open); }}
          >
            <span aria-hidden="true">{thinkingOpen ? "▾" : "▸"}</span>
            {t("record.thinking")}
          </button>
          {thinkingOpen && (
            <div className={css.markdown}>
              <MarkdownBody>{thinking.text}</MarkdownBody>
              <TruncationNote clipped={thinking} t={t} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Preview({ cell, t }: { cell: TrajectoryCellProps; t: TrajectoryTranslate }) {
  const sections = useMemo(() => {
    const out: { title?: string; clipped: Clipped }[] = [];
    if (cell.kind === "tool") {
      const call = (cell.raw as { call?: ToolCallContent } | undefined)?.call;
      const parameters = call ? stringify(call.input) : cell.inputDetail ?? "";
      if (parameters) out.push({ title: t("record.parameters"), clipped: clip(fenced(parameters, call ? "json" : ""), PREVIEW_CHAR_LIMIT) });
      out.push({
        title: t("record.result"),
        clipped: clip(cell.outputDetail ? fenced(cell.outputDetail) : "", PREVIEW_CHAR_LIMIT),
      });
      return out;
    }
    const body = cell.kind === "message" ? cell.outputDetail ?? "" : cell.inputDetail ?? "";
    out.push({ clipped: clip(body, PREVIEW_CHAR_LIMIT) });
    return out;
  }, [cell, t]);

  return (
    <div className={css.preview}>
      {sections.map((section, index) => (
        <section key={index} className={css.section}>
          {section.title && <h4 className={css.heading}>{section.title}</h4>}
          {section.clipped.total === 0
            ? <p className={css.note}>{t(cell.kind === "tool" ? "record.noResult" : "record.noContent")}</p>
            : (
              <div className={css.markdown}>
                <MarkdownBody>{section.clipped.text}</MarkdownBody>
                <TruncationNote clipped={section.clipped} t={t} />
              </div>
            )}
        </section>
      ))}
    </div>
  );
}

function Raw({ cell, t }: { cell: TrajectoryCellProps; t: TrajectoryTranslate }) {
  const [wrap, setWrap] = useState(true);
  // 只在选中时序列化这一条：派生阶段不 stringify，否则每次轮询都要处理全部消息。
  const text = useMemo(() => stringify(cell.raw), [cell.raw]);
  const clipped = useMemo(() => clip(text, RAW_CHAR_LIMIT), [text]);
  return (
    <div className={css.rawPane}>
      <div className={css.rawBar}>
        <button type="button" className={css.smallButton} aria-pressed={wrap} onClick={() => { setWrap((on) => !on); }}>
          {t("record.wrapLines")}
        </button>
        <button type="button" className={css.smallButton} onClick={() => { void copyText(text); }}>
          {t("record.copy")}
        </button>
      </div>
      <pre className={css.raw} data-wrap={wrap || undefined}>{clipped.text}</pre>
      <TruncationNote clipped={clipped} t={t} />
    </div>
  );
}

export interface TrajectoryInspectorProps {
  t: TrajectoryTranslate;
  /** 选中的记录；没有选中时页面根本不渲染检查器。 */
  cell: TrajectoryCellProps;
  /** 头部标题，如「第 15 轮 · 第 4 步」。 */
  title: string;
  onClose: () => void;
}

/** 右侧检查器。 */
export function TrajectoryInspector({ t, cell, title, onClose }: TrajectoryInspectorProps) {
  const [tab, setTab] = useState<Tab>("summary");

  return (
    <aside className={css.root} aria-label={t("details.event")}>
      <header className={css.header}>
        <span className={css.title}>
          <span className={css.titleText}>{title}</span>
          <span className={css.kind} data-kind={cell.kind}>{t(KIND_LABEL_KEY[cell.kind])}</span>
        </span>
        <button type="button" className={css.close} aria-label={t("details.close")} title={t("details.close")} onClick={onClose}>
          ×
        </button>
      </header>
      <div className={css.tabs} role="tablist">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={css.tab}
            data-active={tab === id || undefined}
            onClick={() => { setTab(id); }}
          >
            {t(TAB_KEY[id])}
          </button>
        ))}
      </div>
      {/* key 随记录变：切换选中项时思考折叠、包装开关等局部状态回到默认。 */}
      <div className={css.body} key={cell.recordId}>
        {tab === "summary" && <Summary cell={cell} t={t} />}
        {tab === "preview" && <Preview cell={cell} t={t} />}
        {tab === "raw" && <Raw cell={cell} t={t} />}
      </div>
    </aside>
  );
}
