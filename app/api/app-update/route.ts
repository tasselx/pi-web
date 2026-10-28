import { NextResponse } from "next/server";
import type { AppUpdateResponse } from "@/lib/api-types";
import { getPiWebReleaseUrl, isNewerStableVersion } from "@/lib/app-update";

export const dynamic = "force-dynamic";

const CURRENT_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";
// 与 bin/pi-web-update.js 同步：查询本 fork 自己的 npm 包，而不是上游的。
const NPM_LATEST_URL = "https://registry.npmjs.org/@tasselx%2Fpi-web/latest";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;
const SKIP_VERSION_CHECK = process.env.PI_WEB_SKIP_VERSION_CHECK === "1";

interface AppUpdateCache {
  value?: AppUpdateResponse;
  expiresAt: number;
  inFlight?: Promise<AppUpdateResponse>;
}

declare global {
  var __piWebAppUpdateCache: AppUpdateCache | undefined;
}

function getCache(): AppUpdateCache {
  return globalThis.__piWebAppUpdateCache ??= { expiresAt: 0 };
}

async function fetchLatestVersion(): Promise<AppUpdateResponse> {
  const response = await fetch(NPM_LATEST_URL, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);

  const body = await response.json() as { version?: unknown };
  const latestVersion = typeof body.version === "string" ? body.version : "";
  const releaseUrl = getPiWebReleaseUrl(latestVersion);
  if (!releaseUrl) throw new Error("npm registry returned an invalid version");

  return {
    currentVersion: CURRENT_VERSION,
    latestVersion,
    updateAvailable: isNewerStableVersion(latestVersion, CURRENT_VERSION),
    releaseUrl,
  };
}

// refresh：设置页里用户主动点「检查更新」时，绕过 12h 缓存实时查询，并且失败时如实报错、
// 不再回退旧缓存——否则刚发布的新版会被旧缓存挡住，失败也会被旧的成功结果掩盖。
// 页眉的被动检查不带 refresh，行为不变。
async function loadUpdateStatus(refresh: boolean): Promise<AppUpdateResponse> {
  const cache = getCache();
  if (!refresh && cache.value && cache.expiresAt > Date.now()) return cache.value;
  if (!cache.inFlight) {
    cache.inFlight = fetchLatestVersion().then((value) => {
      cache.value = value;
      cache.expiresAt = Date.now() + CACHE_TTL_MS;
      return value;
    }).finally(() => {
      cache.inFlight = undefined;
    });
  }

  try {
    return await cache.inFlight;
  } catch (error) {
    if (!refresh && cache.value) return cache.value;
    throw error;
  }
}

export async function GET(req: Request) {
  if (SKIP_VERSION_CHECK) {
    return NextResponse.json({
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
      updateAvailable: false,
      releaseUrl: "",
      // 明确告诉设置页「检查已被关闭」，避免把这份占位当成「已是最新」。
      disabled: true,
    } satisfies AppUpdateResponse);
  }
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  try {
    return NextResponse.json(await loadUpdateStatus(refresh));
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
