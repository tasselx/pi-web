"use client";

/**
 * 轨迹视图的按需加载入口：视图的代码（几十 KB）第一次用到才取，不拖慢每个人的首屏。
 *
 * 不用 React.lazy + Suspense：lazy 第一次渲染一定会挂起，Suspense 的占位提交之后，React 把「内容就绪」
 * 的那次提交至少推迟到占位提交后 300 ms（react-dom 的 FALLBACK_THROTTLE_MS），哪怕代码早就取好了——
 * 点开「轨迹」就白白多等 0.3 秒。这里自己管加载：代码到了才渲染它，到之前什么都不画；
 * 已经加载过（例如指针移上标签时调过 loadTrajectoryView）的话，第一次渲染就直接是视图本身。
 */

import { useEffect, useState, type ComponentProps, type ComponentType } from "react";
// 只取类型：这条 import 编译后消失，不会把视图拉进主包。
import type { TrajectoryView } from "./TrajectoryView";

type TrajectoryViewProps = ComponentProps<typeof TrajectoryView>;

let loaded: ComponentType<TrajectoryViewProps> | null = null;
let loading: Promise<void> | null = null;

/** 把视图的代码取进来；重复调用共用同一次加载，失败了不留着，下一次调用重取。 */
export function loadTrajectoryView(): Promise<void> {
  loading ??= import("./TrajectoryView").then(
    (module) => { loaded = module.TrajectoryView; },
    (error: unknown) => { loading = null; throw error; },
  );
  return loading;
}

export function LazyTrajectoryView(props: TrajectoryViewProps) {
  // 函数当初始值要包一层，否则 React 会把组件当初始化函数去调用。
  const [View, setView] = useState<ComponentType<TrajectoryViewProps> | null>(() => loaded);
  useEffect(() => {
    if (View !== null) return;
    let cancelled = false;
    // 取不到（断网等）就保持空白，不抛出：回到「对话」再点开会重新取。
    loadTrajectoryView().then(() => { if (!cancelled) setView(() => loaded); }, () => {});
    return () => { cancelled = true; };
  }, [View]);
  return View === null ? null : <View {...props} />;
}
