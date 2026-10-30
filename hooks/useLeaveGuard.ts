"use client";

import { useEffect } from "react";

/**
 * 有会话还在跑时，关闭标签页、刷新或跳走前，让浏览器弹出它自带的“离开此网站？”确认。
 *
 * 为什么不自绘弹窗：页面卸载时 JS 来不及再画界面，浏览器只认 beforeunload 里的取消信号，
 * 文案由浏览器给、改不了。浏览器也要求页面此前有过点击或按键，否则直接放行。
 * 只在 active 为真时挂监听：没有会话在跑，页面上就没有 beforeunload 监听。
 */
export function useLeaveGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      // preventDefault 是规范写法；returnValue 留给旧版 Chrome/Edge（119 之前）和 Safari。
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}
