"use client";

/**
 * 轨迹视图的数据：一个会话当前分支的消息，会话在跑时保持更新。
 *
 * 和子代理查看器（components/SubagentViewer.tsx）同一条路：轮询
 * `GET /api/sessions/[id]/context`，它读运行中 wrapper 的内存条目、停下后读文件，
 * 从不创建 wrapper，所以打开轨迹绝不会唤醒或干扰一个会话。条目一旦追加就不再变，
 * 轮询只取最新一小段并入已加载的部分（`mergeTailPage`），向前翻页用 `prependOlderPage`。
 * 会话是否在运行由调用方给（AppShell 里侧栏每 2.5 秒轮询一次的那份），这里不再重复轮询。
 *
 * 打开要「几乎没有加载」，靠三件事：
 * - 页面内存里记着最近看过的几个会话，视图一挂载就有东西可画（readCache / writeCache）；
 * - 鼠标移到「轨迹」标签上就预取第一页（prefetchTrajectory），点下去时多半已经在缓存里；
 * - 画出缓存之后照常在后台取最新的并入（stale-while-revalidate），所以视图不需要「刷新」按钮：
 *   打开时校验、运行中轮询、运行结束补取、页面离开较久回来补取。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  EMPTY_TRANSCRIPT, mergeTailPage, prependOlderPage, type SubagentTranscript,
} from "@/components/subagent-viewer-state";

const POLL_MS = 2000;
/** 路由允许的单页上限：首屏和每次向前翻页都取满，一次看到尽量多的轮次。 */
const PAGE_ENTRIES = 1000;
/** 轮询只取最新这一小段，并入已加载的部分。 */
const POLL_ENTRIES = 200;
/** 距上次成功取回超过这么久，就当页面离开过一阵（页面在后台时轮询是暂停的）。 */
const AWAY_MS = POLL_MS * 5;
/** 页面内存里最多记几个会话：再多只是在为不会回头看的会话占内存。 */
const CACHE_SESSIONS = 3;
/** 记着的轨迹放多久：太旧的就当没有，免得一打开先画出一份大幅过时的内容再整块变化。 */
const CACHE_TTL_MS = 10 * 60_000;
/** 每个会话最多留这么多条消息（与路由单页的原始窗口 tail × 6 同量级）；翻页翻出来的更早内容不留。 */
const CACHE_MAX_MESSAGES = PAGE_ENTRIES * 6;

export type TrajectoryLoadStatus = "loading" | "ready" | "notFound" | "error";

interface CachedTranscript {
  transcript: SubagentTranscript;
  /** 其中最新一段是什么时候取回来的：决定下次是补取一小段还是取满一页（见 fetchOnce 的离开规则）。 */
  fetchedAt: number;
}

// 只在页面内存里，刷新即清；不进 localStorage，也不发到别处（同 lib/session-view-cache.ts）。
// Map 的插入顺序就是最近使用的顺序，最久没用的在最前面。
const cache = new Map<string, CachedTranscript>();
/** 正在预取的会话：鼠标在标签上来回移动会反复触发，不能每次都发一个请求。 */
const prefetching = new Set<string>();

function readCache(sessionId: string): CachedTranscript | null {
  const entry = cache.get(sessionId);
  if (entry === undefined) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(sessionId);
    return null;
  }
  return entry;
}

/** 只留末尾一页多一点：从一条用户 / 助手消息起截，工具结果不能被截成没有调用的孤儿。 */
function trimForCache(transcript: SubagentTranscript): SubagentTranscript {
  let start = transcript.messages.length - CACHE_MAX_MESSAGES;
  if (start <= 0) return transcript;
  while (start < transcript.messages.length && transcript.messages[start]?.role === "toolResult") start += 1;
  return {
    messages: transcript.messages.slice(start),
    entryIds: transcript.entryIds.slice(start),
    oldestEntryId: transcript.entryIds[start] ?? null,
    hasMore: true,
  };
}

function writeCache(sessionId: string, transcript: SubagentTranscript, fetchedAt: number): void {
  cache.delete(sessionId);
  cache.set(sessionId, { transcript: trimForCache(transcript), fetchedAt });
  while (cache.size > CACHE_SESSIONS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * 取回来的和已有的一样（没有新条目）时 transcript 不换，写缓存的 effect 不会跑：
 * 这里单独把时间盖新，否则缓存的「多久没取过」只随内容变化推进，空闲会话每次打开都像过期了。
 */
function touchCache(sessionId: string, fetchedAt: number): void {
  const entry = cache.get(sessionId);
  if (entry !== undefined) entry.fetchedAt = fetchedAt;
}

function requestPage(
  sessionId: string,
  entries: number,
  options: { before?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  // 不 defer 思考：检查器要显示它；defer 图片：轨迹里用不到，也免得带回 base64。
  const params = new URLSearchParams({ deferMedia: "1", tail: String(entries) });
  if (options.before) params.set("before", options.before);
  return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/context?${params}`, {
    signal: options.signal,
    cache: "no-store",
  });
}

async function readPage(res: Response): Promise<SubagentTranscript> {
  const data = await res.json() as { context?: Partial<SubagentTranscript> };
  const page = data.context ?? {};
  return {
    messages: page.messages ?? [],
    entryIds: page.entryIds ?? [],
    oldestEntryId: page.oldestEntryId ?? null,
    hasMore: Boolean(page.hasMore),
  };
}

/** 并入之后没有任何变化：条目追加后不再改，条数和首尾 id 都一样就是同一份内容，别换对象去触发重新派生。 */
function sameTranscript(a: SubagentTranscript, b: SubagentTranscript): boolean {
  return a.entryIds.length === b.entryIds.length
    && a.entryIds.at(-1) === b.entryIds.at(-1)
    && a.oldestEntryId === b.oldestEntryId
    && a.hasMore === b.hasMore;
}

/**
 * 先把一个会话的第一页取好放进缓存：鼠标移到 / 聚焦 / 触到「轨迹」标签时调用，
 * 点下去时视图一挂载就能画。尽力而为——失败了、或刚取过，什么都不做，打开时照常取。
 */
export function prefetchTrajectory(sessionId: string): void {
  const cached = readCache(sessionId);
  if (prefetching.has(sessionId) || (cached !== null && Date.now() - cached.fetchedAt < AWAY_MS)) return;
  prefetching.add(sessionId);
  void requestPage(sessionId, PAGE_ENTRIES)
    .then(async (res) => {
      if (!res.ok) return;
      const page = await readPage(res);
      const merged = mergeTailPage(readCache(sessionId)?.transcript ?? EMPTY_TRANSCRIPT, page);
      writeCache(sessionId, merged, Date.now());
    })
    .catch(() => {})
    .finally(() => { prefetching.delete(sessionId); });
}

export interface TrajectoryTranscript {
  transcript: SubagentTranscript;
  status: TrajectoryLoadStatus;
  /** 最近一次请求的错误；已有数据时仍显示数据，只在页头提示。 */
  error: string | null;
  /** 向前翻一页；返回这次是否真的并入了更早的条目。 */
  loadEarlier: () => Promise<boolean>;
  /** 一份数据都没取到时再试一次；有数据时的更新由打开、轮询和回到前台自动完成。 */
  retry: () => void;
}

/**
 * @param sessionId 要读的会话 id
 * @param running 该会话此刻是否在运行：为真时每 2 秒取一次最新一小段，转为假时补取最后一次
 */
export function useTrajectoryTranscript(sessionId: string, running: boolean): TrajectoryTranscript {
  // 缓存里有就直接当作已加载：视图第一帧就能画，下面的 effect 再在后台取最新的补齐。
  const [cached] = useState(() => readCache(sessionId));
  const [transcript, setTranscript] = useState<SubagentTranscript>(cached?.transcript ?? EMPTY_TRANSCRIPT);
  const [status, setStatus] = useState<TrajectoryLoadStatus>(cached ? "ready" : "loading");
  const [error, setError] = useState<string | null>(null);

  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const controllerRef = useRef<AbortController | null>(null);
  const inFlightRef = useRef(false);
  const queuedRef = useRef<number | null>(null);
  const loadingEarlierRef = useRef(false);
  const lastFetchAtRef = useRef(cached?.fetchedAt ?? 0);

  // 页面卸载时中止所有请求。必须排在下面几个加载 effect 之前：它们要读到这个控制器。
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    return () => { controller.abort(); };
  }, [sessionId]);

  const loadTail = useCallback(async (entries: number): Promise<void> => {
    // 同一时刻只有一个请求：慢的回答不能落在新的之后。忙时把下一次记下，回来后补一次，
    // 这样运行结束那一刻的最后几条不会因为恰好撞上上一次轮询而漏掉。
    if (inFlightRef.current) {
      queuedRef.current = Math.max(queuedRef.current ?? 0, entries);
      return;
    }
    inFlightRef.current = true;

    const fetchOnce = async (count: number, signal: AbortSignal): Promise<void> => {
      try {
        // 离开过一阵再回来：这期间新增的条目可能超过一小段，只取最近 200 条会和已加载的部分
        // 接不上，mergeTailPage 就把已显示的历史整页换掉。这一次改取满一页，接得上就原样保留。
        // 没有缓存时 lastFetchAt 是 0，同一条规则让第一次打开取满一页。
        const asked = count === POLL_ENTRIES && Date.now() - lastFetchAtRef.current > AWAY_MS
          ? PAGE_ENTRIES
          : count;
        const res = await requestPage(sessionId, asked, { signal });
        if (res.status === 404) {
          setStatus("notFound");
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const page = await readPage(res);
        if (signal.aborted) return;
        setTranscript((current) => {
          const merged = mergeTailPage(current, page);
          return sameTranscript(current, merged) ? current : merged;
        });
        setStatus("ready");
        setError(null);
        lastFetchAtRef.current = Date.now();
        touchCache(sessionId, lastFetchAtRef.current);
      } catch (err) {
        if (signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        // 已经有数据就继续显示数据，只在页头提示；一份都没有才整页报错。
        setStatus((current) => (current === "ready" ? current : "error"));
      }
    };

    try {
      let next: number | null = entries;
      while (next !== null) {
        // 每一轮读当前控制器：开发模式下 effect 会先清理再重跑，排队的请求要用新的那个。
        const signal = controllerRef.current?.signal;
        if (signal === undefined || signal.aborted) break;
        await fetchOnce(next, signal);
        next = queuedRef.current;
        queuedRef.current = null;
      }
    } finally {
      inFlightRef.current = false;
    }
  }, [sessionId]);

  // 打开时：有缓存先画缓存，这里在后台取最新的并入；没有缓存就取满一页（离开规则见 fetchOnce）。
  useEffect(() => {
    void loadTail(cached ? POLL_ENTRIES : PAGE_ENTRIES);
  }, [cached, loadTail]);

  // 运行期间每 2 秒取一次最新一小段；页面在后台时不取，回到前台后的下一次轮询接上
  // （离开较久时取满一页，见 fetchOnce）。先打开轨迹、之后才在输入框发消息也行：
  // running 一变真就自动开始。
  useEffect(() => {
    if (!running) return;
    const tick = () => {
      if (document.visibilityState === "visible") void loadTail(POLL_ENTRIES);
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => { clearInterval(timer); };
  }, [running, loadTail]);

  // 运行刚结束那一刻再取一次：补上停止前最后追加的条目。
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !running) void loadTail(POLL_ENTRIES);
    wasRunningRef.current = running;
  }, [running, loadTail]);

  // 页面从后台回到前台：离开较久就补取一次。运行中的会话下一次轮询也会补，
  // 这里让空闲的会话（别处发起的变化、另一个窗口里的操作）也不落后。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && Date.now() - lastFetchAtRef.current > AWAY_MS) {
        void loadTail(POLL_ENTRIES);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); };
  }, [loadTail]);

  // 把画着的内容记进缓存：下次打开从这里起步。没变化的轮询不会换 transcript，不会重复写。
  useEffect(() => {
    if (status === "ready") writeCache(sessionId, transcript, lastFetchAtRef.current);
  }, [sessionId, status, transcript]);

  const loadEarlier = useCallback(async (): Promise<boolean> => {
    const cursor = transcriptRef.current.oldestEntryId;
    const signal = controllerRef.current?.signal;
    if (!cursor || loadingEarlierRef.current || signal === undefined) return false;
    loadingEarlierRef.current = true;
    try {
      const res = await requestPage(sessionId, PAGE_ENTRIES, { before: cursor, signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = await readPage(res);
      // 取的期间轮询把已加载的内容换掉了：这一页接不上，丢掉，不接在缺口后面。
      if (transcriptRef.current.oldestEntryId !== cursor) return false;
      setTranscript((current) => prependOlderPage(current, cursor, page));
      return true;
    } catch {
      return false; // 翻页尽力而为，按钮还在，可以重试
    } finally {
      loadingEarlierRef.current = false;
    }
  }, [sessionId]);

  const retry = useCallback(() => {
    setStatus("loading");
    void loadTail(PAGE_ENTRIES);
  }, [loadTail]);

  return { transcript, status, error, loadEarlier, retry };
}
