/**
 * Client-side Web Push subscription. Called once when the Notification
 * permission is granted; silently no-ops on unsupported browsers (e.g. iOS
 * Safari < 16.4 or non-PWA contexts) so the existing in-page notification
 * path keeps working as a fallback.
 */

let activeSubscriptionPromise: Promise<boolean> | null = null;

// 一次注册最多等这么久，超时按失败算（见 setupPushSubscription）。
const PUSH_SETUP_TIMEOUT_MS = 15_000;

// Standard base64url → Uint8Array conversion for applicationServerKey.
function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function isPushSupported(): boolean {
  return typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

/**
 * 这个页面有没有 service worker 注册：Web Push 靠它，没有就谈不上推送。
 * 开发环境不注册（components/PwaRegistration.tsx），生产里注册失败时也一样。
 */
export async function hasPushRegistration(): Promise<boolean> {
  if (!isPushSupported()) return false;
  try {
    return Boolean(await navigator.serviceWorker.getRegistration());
  } catch {
    return false;
  }
}

export async function setupPushSubscription(locale: string): Promise<boolean> {
  if (!isPushSupported() || Notification.permission !== "granted") return false;
  if (activeSubscriptionPromise) return activeSubscriptionPromise;

  const attempt = (async () => {
    try {
      // navigator.serviceWorker.ready 只在页面有注册时才会完成。没有注册（开发环境就是这样）
      // 还去等它，设置页的“注册中…”会永远转下去，缓存在 activeSubscriptionPromise 里的
      // 这次尝试也永远结束不了。
      if (!(await hasPushRegistration())) return false;
      const configResponse = await fetch("/api/push/config");
      if (!configResponse.ok) return false;
      const { publicKey } = await configResponse.json() as { publicKey?: string };
      if (!publicKey) return false;

      const registration = await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      if (!subscription) {
        subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), locale }),
      });
      return response.ok;
    } catch {
      // Retry on the next trigger (e.g. the next permission grant) rather
      // than caching a transient failure forever.
      activeSubscriptionPromise = null;
      return false;
    }
  })();

  // 等浏览器推送服务的时间有上限：Chrome 的推送服务（FCM）连不上时 subscribe() 可以一直不返回，
  // 设置页的“注册中…”就一直转，缓存在 activeSubscriptionPromise 里的这次尝试还会拦住之后每一次重试。
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PUSH_SETUP_TIMEOUT_MS);
  });
  const bounded = Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
  activeSubscriptionPromise = bounded;
  void bounded.then((ok) => {
    if (!ok && activeSubscriptionPromise === bounded) activeSubscriptionPromise = null;
  });
  return bounded;
}
