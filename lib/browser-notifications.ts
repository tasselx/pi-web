import { isBlockingExtensionUiRequest } from "./extension-ui-queue";
import type { BlockingExtensionUiRequest, ExtensionUiRequest } from "./types";

interface WindowNotificationLike {
  onclick: Notification["onclick"];
  close: () => void;
}

interface ServiceWorkerRegistrationLike {
  showNotification: (title: string, options?: NotificationOptions) => Promise<void>;
}

export interface BrowserNotificationEnvironment {
  createWindowNotification: (title: string, options?: NotificationOptions) => WindowNotificationLike;
  getServiceWorkerRegistration: (() => Promise<ServiceWorkerRegistrationLike | undefined>) | null;
}

export interface BrowserNotificationOptions {
  title: string;
  body: string;
  sessionUrl: string;
  onClick: () => void;
  tag?: string;
}

export type NotificationDelivery = "service-worker" | "window" | null;

type DocumentAttentionState = Pick<Document, "visibilityState" | "hasFocus">;

export function shouldShowBrowserNotification(
  attentionState: DocumentAttentionState = document,
): boolean {
  return attentionState.visibilityState !== "visible" || !attentionState.hasFocus();
}

/** 浏览器通知的现状；`unsupported` 是这个页面根本用不了通知 API。 */
export type NotificationState = NotificationPermission | "unsupported";

export function getNotificationState(): NotificationState {
  // 非安全上下文（http://局域网地址）里 Chrome 一律拒绝、Firefox 干脆没有 Notification；
  // iOS 的普通网页标签页也没有它。对用户都是“这里用不了”，不是“被屏蔽”。
  if (typeof window === "undefined" || !window.isSecureContext || !("Notification" in window)) {
    return "unsupported";
  }
  return Notification.permission;
}

// The classification lives with the request queues (lib/extension-ui-queue.ts),
// where the server's awaiting-input snapshot shares it.
export { isBlockingExtensionUiRequest };

export function claimExtensionAttentionNotification(
  request: ExtensionUiRequest,
  notifiedRequestIds: Set<string>,
): request is BlockingExtensionUiRequest {
  if (!isBlockingExtensionUiRequest(request) || notifiedRequestIds.has(request.id)) return false;
  notifiedRequestIds.add(request.id);
  return true;
}

function getBrowserEnvironment(): BrowserNotificationEnvironment {
  return {
    createWindowNotification: (title, options) => new Notification(title, options),
    getServiceWorkerRegistration: "serviceWorker" in navigator
      ? () => navigator.serviceWorker.getRegistration()
      : null,
  };
}

export async function showBrowserNotification(
  options: BrowserNotificationOptions,
  environment: BrowserNotificationEnvironment = getBrowserEnvironment(),
): Promise<NotificationDelivery> {
  const notificationOptions: NotificationOptions = {
    body: options.body,
    ...(options.tag ? { tag: options.tag, renotify: true } : {}),
  };

  if (environment.getServiceWorkerRegistration) {
    try {
      const registration = await environment.getServiceWorkerRegistration();
      if (registration) {
        await registration.showNotification(options.title, {
          ...notificationOptions,
          data: { url: options.sessionUrl },
        });
        return "service-worker";
      }
    } catch {
      // Fall back to a page notification where the constructor is supported.
    }
  }

  try {
    const notification = environment.createWindowNotification(options.title, notificationOptions);
    notification.onclick = () => {
      notification.close();
      options.onClick();
    };
    return "window";
  } catch {
    // Most mobile browsers expose Notification but require service-worker delivery.
    return null;
  }
}
