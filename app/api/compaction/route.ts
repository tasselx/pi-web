import { NextResponse } from "next/server";
import {
  COMPACTION_KEEP_RECENT_TOKENS_DEFAULT,
  COMPACTION_RESERVE_TOKENS_DEFAULT,
} from "@/lib/compaction-settings";
import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "@/lib/global-settings-file";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// Settings › General's Context section: pi's automatic context compaction
// (`compaction.enabled` and a model's `compaction.modelOverrides[…].reserveTokens`)
// in the global settings.json. pi's default is on; a project's
// .pi/settings.json still overrides both, as in pi.

interface CompactionView {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  modelOverride: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactionObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid settings.json: compaction must be an object");
  }
  return value;
}

function modelOverridesObject(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error("Invalid settings.json: compaction.modelOverrides must be an object");
  }
  return value;
}

function modelOverrideObject(value: unknown, modelKey: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Invalid settings.json: compaction.modelOverrides["${modelKey}"] must be an object`);
  }
  return value;
}

function readTokenSetting(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid settings.json: ${label} must be a non-negative safe integer`);
  }
  return value;
}

function parseModelKey(provider: unknown, modelId: unknown): string | undefined {
  if (typeof provider !== "string" || !provider.trim()) return undefined;
  if (typeof modelId !== "string" || !modelId.trim()) return undefined;
  return `${provider.trim()}/${modelId.trim()}`;
}

function readView(settings: Record<string, unknown>, modelKey?: string): CompactionView {
  const compaction = compactionObject(settings.compaction) ?? {};
  const override = modelKey
    ? modelOverrideObject(modelOverridesObject(compaction.modelOverrides)?.[modelKey], modelKey)
    : undefined;
  const overrideLabel = modelKey ? `compaction.modelOverrides["${modelKey}"]` : "compaction";
  const overrideReserve = readTokenSetting(override?.reserveTokens, `${overrideLabel}.reserveTokens`);
  return {
    enabled: compaction.enabled !== false,
    reserveTokens: overrideReserve
      ?? readTokenSetting(compaction.reserveTokens, "compaction.reserveTokens")
      ?? COMPACTION_RESERVE_TOKENS_DEFAULT,
    keepRecentTokens: readTokenSetting(override?.keepRecentTokens, `${overrideLabel}.keepRecentTokens`)
      ?? readTokenSetting(compaction.keepRecentTokens, "compaction.keepRecentTokens")
      ?? COMPACTION_KEEP_RECENT_TOKENS_DEFAULT,
    modelOverride: overrideReserve !== undefined,
  };
}

async function readSettingsView(modelKey?: string): Promise<CompactionView> {
  return readGlobalSettings(getGlobalSettingsPath(), (settings) => readView(settings, modelKey));
}

function errorResponse(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const modelKey = parseModelKey(url.searchParams.get("provider"), url.searchParams.get("modelId"));
    return NextResponse.json(await readSettingsView(modelKey));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isRecord(body)) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const changesEnabled = "enabled" in body;
  if (changesEnabled && typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }
  const changesReserve = "reserveTokens" in body;
  let modelKey: string | undefined;
  if (changesReserve) {
    modelKey = parseModelKey(body.provider, body.modelId);
    if (!modelKey) {
      return NextResponse.json({ error: "provider and modelId are required with reserveTokens" }, { status: 400 });
    }
    if (body.reserveTokens !== null && (
      typeof body.reserveTokens !== "number"
      || !Number.isSafeInteger(body.reserveTokens)
      || body.reserveTokens < 0
    )) {
      return NextResponse.json({ error: "reserveTokens must be a non-negative integer or null" }, { status: 400 });
    }
  }
  if (!changesEnabled && !changesReserve) {
    return NextResponse.json({ error: "Nothing to change" }, { status: 400 });
  }

  try {
    await updateGlobalSettings(getGlobalSettingsPath(), (settings) => {
      const compaction = { ...(compactionObject(settings.compaction) ?? {}) };
      if (changesEnabled) compaction.enabled = body.enabled as boolean;
      if (changesReserve && modelKey) {
        const overrides = { ...(modelOverridesObject(compaction.modelOverrides) ?? {}) };
        const override = { ...(modelOverrideObject(overrides[modelKey], modelKey) ?? {}) };
        if (body.reserveTokens === null) delete override.reserveTokens;
        else override.reserveTokens = body.reserveTokens as number;
        if (Object.keys(override).length > 0) overrides[modelKey] = override;
        else delete overrides[modelKey];
        if (Object.keys(overrides).length > 0) compaction.modelOverrides = overrides;
        else delete compaction.modelOverrides;
      }
      if (Object.keys(compaction).length > 0) settings.compaction = compaction;
      else delete settings.compaction;
    });
    return NextResponse.json(await readSettingsView(modelKey));
  } catch (error) {
    return errorResponse(error);
  }
}
