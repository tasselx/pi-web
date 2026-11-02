"use client";

import { useEffect } from "react";

/**
 * 清掉遗留的 Service Worker 和它的缓存，返回当前页面是不是由它接管加载的。
 * 同一来源（端口）上跑过正式版就会留下它：它对 /_next/static/* 缓存优先，而开发时
 * Turbopack chunk 的文件名改动后不变，于是旧代码被一直返回，普通刷新也不会更新。
 * 缓存名前缀与 public/sw.js 的 CACHE_PREFIX 一致。
 */
async function clearLeftoverServiceWorker(): Promise<boolean> {
  const wasControlled = Boolean(navigator.serviceWorker.controller);
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((registration) => registration.unregister()));
  const cacheNames = (await caches.keys()).filter((name) => name.startsWith("pi-web-"));
  await Promise.all(cacheNames.map((name) => caches.delete(name)));
  return wasControlled;
}

export function PwaRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") {
      // 开发模式不注册 Service Worker，只清遗留的。仅当本页确实由它接管加载（可能是旧代码）
      // 才刷新一次；清掉后不再接管，所以不会循环刷新。
      void clearLeftoverServiceWorker()
        .then((wasControlled) => {
          if (wasControlled) window.location.reload();
        })
        .catch((error: unknown) => {
          console.warn("Failed to clear a leftover Pi Web service worker:", error);
        });
      return;
    }

    const register = () => {
      const appVersion = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
      const scriptUrl = `/sw.js?v=${encodeURIComponent(appVersion)}`;

      void navigator.serviceWorker.register(scriptUrl, {
        scope: "/",
        updateViaCache: "none",
      }).catch((error: unknown) => {
        console.error("Failed to register the Pi Web service worker:", error);
      });
    };

    if (document.readyState === "complete") {
      register();
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
