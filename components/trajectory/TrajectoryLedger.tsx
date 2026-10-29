"use client";

/**
 * 轨迹记录列表：按「第 N 轮」分组，每行 `#序号 · 类型标签 · 摘要 · 输入/输出/缓存 · 耗时`。
 *
 * 版式参照 deepseek-ai/deepseek-harness 的 ui-trajectory（MIT，Copyright (c) 2026
 * DeepSeek）里的 TrajectoryTable / TrajectoryTurnHeader / TrajectoryGroupHeader：
 * 粘性的轮次表头、分组小标题、折叠后的摘要行、选中轨与轮次轨。
 * 上游为超长列表引入了 @tanstack/react-virtual；这里不加运行时依赖——行高固定，记录又都已在内存里，
 * 所以只挂载末尾一段（窗口，见 lib/trajectory/ledger.ts 的 LedgerWindow），更早的往上滚时再露出：
 * 打开的代价不再随会话长短变化。
 */

import {
  Fragment, memo, useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent,
} from "react";
import { fullCellText } from "@/lib/trajectory/derive";
import {
  INITIAL_LEDGER_WINDOW, recordRowKey, resolveLedgerWindow, type LedgerWindow, type TableRecord,
} from "@/lib/trajectory/ledger";
import {
  formatElapsedSeconds, type TrajectoryCellKind, type TrajectoryTranslate,
} from "@/lib/trajectory/record";
import css from "./TrajectoryLedger.module.css";

/** 滚动到离底部这么近仍算「在跟随末尾」。 */
const FOLLOW_TAIL_PX = 48;
/** 首屏只挂载末尾这么多行：一次挂几千行（两万多个节点）会让打开卡上大半秒。 */
const INITIAL_ROWS = 120;
/** 往上滚到顶、或点「加载更早」时，每次再露出这么多行。 */
const REVEAL_ROWS = 200;
/** 往上滚到离顶部这么近，就自动露出下一批已在内存里的更早行。 */
const REVEAL_NEAR_PX = 400;

const KIND_LABEL_KEY: Record<TrajectoryCellKind, string> = {
  user: "kind.user",
  context: "kind.context",
  compacted: "kind.compacted",
  message: "kind.assistant",
  tool: "kind.tool",
};

/** 1234 → 1.2k：列很窄，只给量级。 */
function formatTokens(value: number | undefined): string {
  if (value === undefined) return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return String(value);
}

interface RowProps {
  t: TrajectoryTranslate;
  record: TableRecord;
  selected: boolean;
  dimmed: boolean;
  hasCalls: boolean;
  callsCollapsed: boolean;
  onSelect: (recordId: string) => void;
  onToggleTurn: (turn: number) => void;
  onToggleAssistant: (recordId: string) => void;
}

const LedgerRow = memo(function LedgerRow({
  t, record, selected, dimmed, hasCalls, callsCollapsed, onSelect, onToggleTurn, onToggleAssistant,
}: RowProps) {
  const { cell } = record;

  if (record.collapsedSummary !== undefined) {
    // 折叠后的摘要行：点一下展开；不能冒泡到列表，否则会顺带清掉当前选中。
    const isTurn = record.collapsedSummaryKind === "turn" && record.turn !== null;
    const toggle = (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (isTurn && record.turn !== null) onToggleTurn(record.turn);
      else onToggleAssistant(cell.recordId);
    };
    return (
      <button
        type="button"
        className={css.summaryRow}
        data-summary-kind={record.collapsedSummaryKind}
        onClick={toggle}
        title={t(isTurn ? "ledger.expandTurn" : "ledger.expandCalls")}
      >
        <span className={css.summaryChevron} aria-hidden="true">▸</span>
        <span className={css.summaryText}>{record.collapsedSummary}</span>
      </button>
    );
  }

  const onRowClick = (event: MouseEvent<HTMLDivElement>) => {
    // 在行内选中文字时不要当成「选中这一行」。
    if (window.getSelection()?.toString()) return;
    event.stopPropagation();
    onSelect(cell.recordId);
  };

  const showMetrics = cell.kind === "message";
  const placeholder = cell.kind === "message" && cell.text === ""
    ? t(hasCalls ? "record.toolCallOnly" : "record.noContent")
    : null;

  return (
    <div
      role="option"
      aria-selected={selected}
      className={css.row}
      data-kind={cell.kind}
      data-selected={selected || undefined}
      data-error={cell.isError || undefined}
      data-dimmed={dimmed || undefined}
      data-record-index={cell.index}
      data-record-id={cell.recordId}
      onClick={onRowClick}
    >
      <span className={css.index}>#{cell.index}</span>
      <span className={css.tagSlot}>
        <span className={css.tag} data-kind={cell.kind}>{t(KIND_LABEL_KEY[cell.kind] ?? "kind.tool")}</span>
      </span>
      {/* 悬停提示给全文：行内摘要只有开头 200 字并以「…」收尾，提示不该再省略。 */}
      <span className={css.text} title={fullCellText(cell) || undefined}>
        {hasCalls && (
          <button
            type="button"
            className={css.callsToggle}
            aria-expanded={!callsCollapsed}
            aria-label={callsCollapsed ? t("ledger.expandCalls") : t("ledger.collapseCalls")}
            title={callsCollapsed ? t("ledger.expandCalls") : t("ledger.collapseCalls")}
            onClick={(event) => {
              event.stopPropagation();
              onToggleAssistant(cell.recordId);
            }}
          >
            {callsCollapsed ? "▸" : "▾"}
          </button>
        )}
        {placeholder === null ? cell.text : <span className={css.placeholder}>{placeholder}</span>}
      </span>
      <span className={css.metric}>{showMetrics ? formatTokens(cell.input) : ""}</span>
      <span className={css.metric}>{showMetrics ? formatTokens(cell.output) : ""}</span>
      <span className={css.metric}>{showMetrics ? formatTokens(cell.cacheRead) : ""}</span>
      <span className={css.time}>
        {/* 运行中还没拿到结果的调用：一个脉动的点，实时看轨迹时一眼就能看出此刻在执行哪一步 */}
        {cell.running
          ? <span className={css.pending} role="img" aria-label={t("status.pending")} title={t("status.pending")} />
          : cell.timeSeconds === null ? "" : formatElapsedSeconds(cell.timeSeconds)}
      </span>
    </div>
  );
});

export interface TrajectoryLedgerProps {
  t: TrajectoryTranslate;
  /** 已按搜索 / 折叠处理好的行。 */
  records: readonly TableRecord[];
  selectedId: string | null;
  /** 时间线框选命中的记录序号；不在其中的行变暗。没有框选为 null。 */
  focusIndexes: ReadonlySet<number> | null;
  collapsedAssistants: ReadonlySet<string>;
  /** 后面紧跟着工具调用、因此可折叠的助手记录。 */
  collapsibleAssistants: ReadonlySet<string>;
  hasEarlier: boolean;
  /** 加载更早的一页；返回是否加载到了东西。 */
  onLoadEarlier: () => Promise<boolean>;
  /** 外部（时间线）要求把某条记录滚进视野；换一个新对象就是再来一次。 */
  scrollRequest: { readonly index: number } | null;
  onSelect: (recordId: string | null) => void;
  onToggleTurn: (turn: number) => void;
  onToggleAssistant: (recordId: string) => void;
  sectionLabel: (turn: number | null) => string;
}

/** 记录列表。 */
export function TrajectoryLedger({
  t, records, selectedId, focusIndexes, collapsedAssistants, collapsibleAssistants, hasEarlier,
  onLoadEarlier, scrollRequest, onSelect, onToggleTurn, onToggleAssistant, sectionLabel,
}: TrajectoryLedgerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 用户停在末尾附近时，新记录进来要跟着滚；往上翻了就不再打扰。 */
  const followTailRef = useRef(true);
  /** 向前翻页前量下的「距底部」，翻完据此还原位置，避免内容被顶下去。 */
  const olderAnchorRef = useRef<number | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** 要滚到、但还没挂载的记录：窗口往上扩出它之后再滚。 */
  const pendingScrollRef = useRef<{ index: number; block: ScrollLogicalPosition } | null>(null);
  // 挂载前就有的请求算处理过：账本会因搜索开关重挂（见 TrajectoryView 的 key），旧请求不该再滚一次。
  const handledScrollRequestRef = useRef<typeof scrollRequest>(scrollRequest);

  const [windowState, setWindowState] = useState<LedgerWindow>(INITIAL_LEDGER_WINDOW);
  const resolved = resolveLedgerWindow(records, windowState, INITIAL_ROWS);
  // 渲染期校正：第一次、或窗口起点那一行被搜索 / 折叠过滤掉了，就把窗口钉到新的起点。
  // React 会在提交前立刻重渲一次；没变化时 resolved.window 就是 windowState，不会循环。
  if (resolved.window !== windowState) setWindowState(resolved.window);
  const { start, pinIndex } = resolved;

  /** 把窗口往上扩到至少 `extendUp` 行（相对窗口起点那一行）；只增不减，同一个值重复来也无妨。 */
  const extendWindow = useCallback((extendUp: number) => {
    setWindowState((current) => (extendUp > current.extendUp ? { ...current, extendUp } : current));
  }, []);

  /** 再露出一批已在内存里的更早行，并记下距底部的距离，露出之后据此还原，读者正看着的行不会被顶下去。 */
  const revealEarlier = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    olderAnchorRef.current = el.scrollHeight - el.scrollTop;
    extendWindow(windowState.extendUp + REVEAL_ROWS);
  }, [extendWindow, windowState.extendUp]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    followTailRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_TAIL_PX;
    // 往上滚到快顶了：自动露出下一批，读者不用点按钮。
    if (start > 0 && el.scrollTop < REVEAL_NEAR_PX) revealEarlier();
  }, [revealEarlier, start]);

  // 记录变了、或窗口往上扩了：先处理向前翻页 / 露出更早行后的位置还原，否则按「跟随末尾」滚到底。
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (olderAnchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - olderAnchorRef.current;
      olderAnchorRef.current = null;
    } else if (followTailRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [records, start]);

  /** 把某条记录滚进视野；它在窗口之上、还没挂载时，先把窗口扩到它（再多露一些上文），挂载后由下面的 effect 滚过去。 */
  const scrollToRecord = useCallback((index: number, block: ScrollLogicalPosition) => {
    const el = scrollRef.current;
    if (el === null) return;
    const row = el.querySelector<HTMLElement>(`[data-record-index="${index}"]`);
    if (row !== null) {
      row.scrollIntoView({ block });
      return;
    }
    const position = records.findIndex((record) => record.collapsedSummary === undefined && record.cell.index === index);
    if (position < 0 || position >= start) return; // 不在列表里（被搜索过滤掉了）
    pendingScrollRef.current = { index, block };
    extendWindow(pinIndex - position + REVEAL_ROWS / 2);
  }, [extendWindow, pinIndex, records, start]);

  // 外部要求滚动到某条记录（时间线点击 / 框选）。scrollToRecord 随记录变化换身份，
  // 所以用 handled 标记保证同一个请求只处理一次，实时更新不会反复把读者拉回去。
  useLayoutEffect(() => {
    if (scrollRequest === null || handledScrollRequestRef.current === scrollRequest) return;
    handledScrollRequestRef.current = scrollRequest;
    scrollToRecord(scrollRequest.index, "center");
  }, [scrollRequest, scrollToRecord]);

  // 窗口往上扩出来之后，把刚才要找的那一行滚进视野（排在还原 / 跟随末尾的 effect 之后，以它为准）。
  useLayoutEffect(() => {
    const pending = pendingScrollRef.current;
    if (pending === null) return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-record-index="${pending.index}"]`);
    if (!row) return;
    pendingScrollRef.current = null;
    row.scrollIntoView({ block: pending.block });
  }, [start]);

  const loadEarlier = useCallback(() => {
    const el = scrollRef.current;
    if (el === null || loadingEarlier) return;
    // 先露出已经在内存里的更早记录；它们都露完了才去取下一页。
    if (start > 0) {
      revealEarlier();
      return;
    }
    olderAnchorRef.current = el.scrollHeight - el.scrollTop;
    // 取到的一页并入后，让紧挨着当前起点的这一段跟着露出来，否则点了按钮却什么都没出现。
    extendWindow(pinIndex + REVEAL_ROWS);
    setLoadingEarlier(true);
    void onLoadEarlier().then((loaded) => {
      // 没加载到东西就不会有 records 变化，锚点要自己撤掉。
      if (!loaded) olderAnchorRef.current = null;
    }).finally(() => { setLoadingEarlier(false); });
  }, [extendWindow, loadingEarlier, onLoadEarlier, pinIndex, revealEarlier, start]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      // 嵌在聊天区里，全局 Esc 会停止运行中的 agent（hooks/useKeyboardShortcuts.ts）：
      // 只有真的关掉了检查器才吃掉这次按键；没有选中项时放行，行为和聊天区其余部分一致。
      if (selectedId === null) return;
      event.preventDefault();
      onSelect(null);
      return;
    }
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const visible = records.filter((record) => record.collapsedSummary === undefined);
    if (visible.length === 0) return;
    const at = visible.findIndex((record) => record.cell.recordId === selectedId);
    const next = event.key === "Home" ? 0
      : event.key === "End" ? visible.length - 1
        : event.key === "ArrowDown" ? Math.min(visible.length - 1, at + 1)
          : Math.max(0, at === -1 ? visible.length - 1 : at - 1);
    const target = visible[next];
    if (target === undefined) return;
    onSelect(target.cell.recordId);
    // 目标可能在窗口之上（还没挂载）：scrollToRecord 会先把窗口扩到它。
    scrollToRecord(target.cell.index, "nearest");
  };

  return (
    <div
      ref={scrollRef}
      className={css.ledger}
      role="listbox"
      aria-label={t("ledger.aria")}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      onClick={() => { onSelect(null); }}
    >
      {/* 窗口之上还有已在内存里的行，或服务端还有更早的一页：都从这里往上走。 */}
      {(start > 0 || hasEarlier) && (
        <div className={css.historyRow}>
          <button type="button" className={css.historyButton} disabled={loadingEarlier} onClick={loadEarlier}>
            {loadingEarlier ? t("history.loadingEarlier") : t("history.loadEarlier")}
          </button>
        </div>
      )}
      {/* 列表只在有记录时才挂载，所以走到这里为空只会是搜索没有命中。 */}
      {records.length === 0 && <p className={css.empty}>{t("ledger.noMatches")}</p>}
      {records.slice(start).map((record, offset) => {
        const { cell } = record;
        // 窗口起点落在一轮中间时，这一轮的表头在窗口之上、没有挂载：给起点这一行补一个，
        // 粘性表头才有东西可吸，读者也看得出这几行属于哪一轮。
        const windowTop = start > 0 && offset === 0;
        // 用 Fragment 而不是包一层 div：粘性的轮次表头必须是滚动容器的直接子元素，
        // 才能在整轮的所有行经过时一直吸在顶部。
        return (
          <Fragment key={recordRowKey(record)}>
            {(record.turnStart || windowTop) && (
              <div className={css.turnHeader}>
                <button
                  type="button"
                  className={css.turnTitle}
                  disabled={record.turn === null}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (record.turn !== null) onToggleTurn(record.turn);
                  }}
                >
                  {sectionLabel(record.turn)}
                </button>
                <span className={css.turnColumns} aria-hidden="true">
                  <span>{t("column.input")}</span>
                  <span>{t("column.output")}</span>
                  <span>{t("column.cache")}</span>
                  <span>{t("column.time")}</span>
                </span>
              </div>
            )}
            {record.groupStart && (cell.kind === "message" || cell.kind === "compacted") && record.collapsedSummary === undefined && (
              <div className={css.groupHeader}>
                <span className={css.groupTitle}>{record.group}</span>
                {record.groupDescription && <span className={css.groupDescription}>{record.groupDescription}</span>}
              </div>
            )}
            <LedgerRow
              t={t}
              record={record}
              selected={cell.recordId === selectedId && record.collapsedSummary === undefined}
              dimmed={focusIndexes !== null && !focusIndexes.has(cell.index)}
              hasCalls={cell.kind === "message" && collapsibleAssistants.has(cell.recordId)}
              callsCollapsed={collapsedAssistants.has(cell.recordId)}
              onSelect={onSelect}
              onToggleTurn={onToggleTurn}
              onToggleAssistant={onToggleAssistant}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
