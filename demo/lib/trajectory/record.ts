/**
 * 轨迹视图的数据模型。
 *
 * 类型与字段名移植自 deepseek-ai/deepseek-harness 的 ui-trajectory
 * （MIT，Copyright (c) 2026 DeepSeek），保持同名是为了让同样移植来的时间线、
 * 记录折叠和搜索模块可以几乎原样使用。
 *
 * 与上游不同的取舍（为什么）：pi 的会话文件里没有系统提示词快照、附件引用、
 * 子工具和「首 token 时间」，所以去掉了 system / subtool 两类记录和对应字段，
 * 不为拿不到的数据留空壳（YAGNI）。
 */

/** 轨迹里一条记录的种类。 */
export type TrajectoryCellKind = "user" | "context" | "compacted" | "message" | "tool";

/** 本视图的翻译函数：键不带 `trajectory.` 前缀，由页面统一补上。 */
export type TrajectoryTranslate = (key: string, params?: Record<string, string | number>) => string;

/** 一条记录的全部展示数据。 */
export interface TrajectoryCellProps {
  /** 从 1 开始的记录序号，显示为 `#N`；向前翻页后会整体后移，所以不能当身份用。 */
  index: number;
  /** 跨刷新、跨向前翻页都稳定的身份：来源条目 id，工具调用再加调用 id。 */
  recordId: string;
  kind: TrajectoryCellKind;
  /** 单行摘要，最多 200 字并以「…」收尾，太宽由 CSS 省略；全文用 derive.ts 的 fullCellText()。助手只有工具调用时为空串。 */
  text: string;
  /** 用户 / 上下文 / 压缩摘要的原文。 */
  inputDetail?: string;
  /** 助手正文，或工具输出文本。预览要用的 Markdown 在检查器里按需生成，这里不预先拼大字符串。 */
  outputDetail?: string;
  /** 助手的思考文本。 */
  thinkingDetail?: string;
  /** 「原始内容」页签的来源对象；只在选中时才序列化，避免每次轮询都 stringify 全部消息。 */
  raw?: unknown;
  toolName?: string;
  callId?: string;
  /** 失败的工具、出错或被中断的助手回复。 */
  isError?: boolean;
  /** 工具调用还没有结果，而会话仍在运行。 */
  running?: boolean;
  /** 工具调用没有结果，会话也已经停了：被中断或崩溃。 */
  interrupted?: boolean;
  /** 自身耗时（秒）；未知为 null。 */
  timeSeconds: number | null;
  /** 实际开始的 epoch 毫秒；未知时不在时间线上画时长。 */
  startedAt?: number | null;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  /** 本次请求的费用（美元）。 */
  cost?: number;
  model?: string;
  provider?: string;
  stopReason?: string;
}

/** 轮次内的一组：「消息」或「第 N 步」。 */
export interface TrajectoryGroupModel {
  title: string;
  description?: string;
  cells: readonly TrajectoryCellProps[];
}

/** 一轮（`turn` 为 null 表示轮次之间，例如两轮之间的压缩）。 */
export interface TrajectoryTurnModel {
  turn: number | null;
  groups: readonly TrajectoryGroupModel[];
}

/**
 * 耗时的人读写法：不足 1 秒用毫秒，其后用秒，再往上用分秒。
 * @param milliseconds 非负毫秒数，未知为 null
 * @returns 带单位的文本，未知时为 `—`
 */
export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) return "—";
  const ms = Math.max(0, milliseconds);
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** 秒数版本，给记录的 `timeSeconds` 用。 */
export function formatElapsedSeconds(seconds: number | null | undefined): string {
  return formatDuration(seconds === null || seconds === undefined ? null : seconds * 1000);
}
