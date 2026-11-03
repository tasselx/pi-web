import type { ProjectTrustStatus, SleepInhibitStatus } from "@/lib/api-types";

/**
 * The rows a group switch would change: those not already in the requested
 * state. Switching a group off also leaves out the rows `keepOn` names, which
 * the caller reports instead; a filtered plugin package, for one, loses its
 * resource filters when disabled, so that stays a decision for its own switch.
 */
export function itemsToSwitch<T>(
  items: readonly T[],
  enabled: boolean,
  isEnabled: (item: T) => boolean,
  keepOn?: (item: T) => boolean,
): T[] {
  return items.filter((item) => isEnabled(item) !== enabled && (enabled || !keepOn?.(item)));
}

/**
 * The page's trust status for a settings panel's folder, as one string that
 * changes whenever the decision does. Settings keeps every section it has shown
 * mounted, so trusting from Settings › MCP leaves Skills, Agents and Plugins
 * describing the folder as it was; each panel whose answer depends on trust
 * loads again, in place, when this changes. Empty without a status.
 */
export function projectTrustReloadKey(trust: ProjectTrustStatus | null | undefined): string {
  if (!trust) return "";
  return JSON.stringify([trust.requiresTrust, trust.trusted, trust.decision, trust.decisionPath ?? null, trust.inherited]);
}

/**
 * The line under Settings › General's "prevent system sleep" switch, from the
 * server's own report of what it can do on its machine. It speaks only when
 * something is wrong: an unsupported machine says why it cannot, and a failed
 * attempt to take the hold says why, so the switch is never "on" for a hold
 * that does not exist without saying so. Otherwise null; the switch and its
 * description are all there is to say.
 */
export type SleepInhibitNote = { kind: "unavailable" | "failed"; reason: string };

export function sleepInhibitNote(status: SleepInhibitStatus | null): SleepInhibitNote | null {
  if (!status) return null;
  if (!status.supported) return { kind: "unavailable", reason: status.unsupportedReason ?? "" };
  if (status.enabled && status.failure) return { kind: "failed", reason: status.failure };
  return null;
}
