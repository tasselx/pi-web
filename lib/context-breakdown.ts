import type {
  AgentMessage,
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  ImageContent,
  TextContent,
  ToolResultMessage,
  UserMessage,
} from "./types";
import type { ToolEntry } from "./tool-presets";

export interface ContextUsageInfo {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

/**
 * Matches pi-coding-agent's `compaction.js` token estimation heuristic:
 * chars / 4, with ~4800 chars (1200 tokens) per image block.
 */
export const ESTIMATED_IMAGE_CHARS = 4800;

export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function estimateContentChars(
  content: string | readonly (TextContent | ImageContent)[] | undefined | null,
): number {
  if (!content) return 0;
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      chars += block.text.length;
    } else if (block.type === "image") {
      chars += ESTIMATED_IMAGE_CHARS;
    }
  }
  return chars;
}

export interface ToolTrafficItem {
  name: string;
  calls: number;
  tokens: number;
}

export interface MessageContextSummary {
  compactionTokens: number;
  userTokens: number;
  userCount: number;
  assistantTextTokens: number;
  assistantThinkingTokens: number;
  assistantCount: number;
  toolTrafficTokens: number;
  toolCallCount: number;
  toolResultCount: number;
  toolTrafficByTool: ToolTrafficItem[];
}

export const EMPTY_MESSAGE_CONTEXT_SUMMARY: MessageContextSummary = {
  compactionTokens: 0,
  userTokens: 0,
  userCount: 0,
  assistantTextTokens: 0,
  assistantThinkingTokens: 0,
  assistantCount: 0,
  toolTrafficTokens: 0,
  toolCallCount: 0,
  toolResultCount: 0,
  toolTrafficByTool: [],
};

export function summarizeMessagesContext(
  messages: readonly AgentMessage[],
): MessageContextSummary {
  if (!messages || messages.length === 0) {
    return EMPTY_MESSAGE_CONTEXT_SUMMARY;
  }

  let compactionChars = 0;
  let userChars = 0;
  let userCount = 0;
  let assistantTextChars = 0;
  let assistantThinkingChars = 0;
  let assistantCount = 0;
  let toolTrafficChars = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;

  const toolCharsByName = new Map<string, { calls: number; chars: number }>();
  const toolNameByCallId = new Map<string, string>();

  const addToolTraffic = (name: string, chars: number, isCall: boolean) => {
    const key = name.trim() || "unknown";
    const existing = toolCharsByName.get(key) ?? { calls: 0, chars: 0 };
    if (isCall) existing.calls += 1;
    existing.chars += Math.max(0, chars);
    toolCharsByName.set(key, existing);
  };

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const rawRole = (msg as { role?: string }).role;

    if (rawRole === "compactionSummary") {
      const summary = (msg as unknown as { summary?: string }).summary;
      if (typeof summary === "string") {
        compactionChars += summary.length;
      }
      continue;
    }

    if (msg.role === "custom") {
      const custom = msg as CustomMessage;
      const chars = estimateContentChars(custom.content);
      if (custom.customType === "compaction") {
        compactionChars += chars;
      } else {
        userChars += chars;
      }
      continue;
    }

    if (msg.role === "user") {
      const user = msg as UserMessage;
      userCount += 1;
      userChars += estimateContentChars(user.content);
      continue;
    }

    if (msg.role === "assistant") {
      const assistant = msg as AssistantMessage;
      assistantCount += 1;
      for (const block of assistant.content ?? []) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text") {
          assistantTextChars += (block.text ?? "").length;
        } else if (block.type === "thinking") {
          assistantThinkingChars += (block.thinking ?? "").length;
        } else if (block.type === "image") {
          assistantTextChars += ESTIMATED_IMAGE_CHARS;
        } else if (block.type === "toolCall") {
          toolCallCount += 1;
          const toolName = block.toolName || "unknown";
          if (block.toolCallId) {
            toolNameByCallId.set(block.toolCallId, toolName);
          }
          let inputChars = toolName.length;
          if (typeof block.rawInput === "string") {
            inputChars += block.rawInput.length;
          } else if (block.input !== undefined) {
            try {
              inputChars += JSON.stringify(block.input).length;
            } catch {
              // ignore non-serializable input
            }
          }
          toolTrafficChars += inputChars;
          addToolTraffic(toolName, inputChars, true);
        }
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const result = msg as ToolResultMessage;
      toolResultCount += 1;
      const chars = estimateContentChars(result.content);
      toolTrafficChars += chars;
      const toolName =
        result.toolName ||
        (result.toolCallId ? toolNameByCallId.get(result.toolCallId) : undefined) ||
        "unknown";
      addToolTraffic(toolName, chars, false);
      continue;
    }

    if (msg.role === "bashExecution") {
      const bash = msg as BashExecutionMessage;
      if (!bash.excludeFromContext) {
        const chars = (bash.command?.length ?? 0) + (bash.output?.length ?? 0);
        toolCallCount += 1;
        toolResultCount += 1;
        toolTrafficChars += chars;
        addToolTraffic("bash", chars, true);
      }
      continue;
    }
  }

  const toolTrafficByTool: ToolTrafficItem[] = Array.from(toolCharsByName.entries())
    .map(([name, entry]) => ({
      name,
      calls: entry.calls,
      tokens: Math.ceil(entry.chars / 4),
    }))
    .filter((item) => item.tokens > 0 || item.calls > 0)
    .sort((a, b) => b.tokens - a.tokens || b.calls - a.calls || a.name.localeCompare(b.name));

  return {
    compactionTokens: Math.ceil(compactionChars / 4),
    userTokens: Math.ceil(userChars / 4),
    userCount,
    assistantTextTokens: Math.ceil(assistantTextChars / 4),
    assistantThinkingTokens: Math.ceil(assistantThinkingChars / 4),
    assistantCount,
    toolTrafficTokens: Math.ceil(toolTrafficChars / 4),
    toolCallCount,
    toolResultCount,
    toolTrafficByTool,
  };
}

export type ContextCategoryId =
  | "system"
  | "tools"
  | "compaction"
  | "user"
  | "assistant"
  | "thinking"
  | "toolTraffic";

export interface ContextCategoryItem {
  id: ContextCategoryId;
  color: string;
  estimatedTokens: number;
  /** Scaled token count when provider-reported tokens are available; otherwise equals estimatedTokens. */
  tokens: number;
  /** Fraction of usedTokens (0..1). */
  shareOfUsed: number;
  /** Percentage of total contextWindow (0..100), or null when contextWindow is unknown. */
  percentOfWindow: number | null;
}

export interface ToolDeclarationTokenItem {
  name: string;
  tokens: number;
}

export interface ContextBreakdown {
  categories: ContextCategoryItem[];
  estimatedTokens: number;
  reportedTokens: number | null;
  usedTokens: number;
  contextWindow: number | null;
  freeTokens: number | null;
  usedPercent: number | null;
  systemPromptTokens: number;
  toolsTokens: number;
  activeToolCount: number;
  toolDeclarations: ToolDeclarationTokenItem[];
  toolTrafficByTool: ToolTrafficItem[];
}

export function estimateToolDeclarationTokens(tool: ToolEntry): number {
  let chars = (tool.name?.length ?? 0) + (tool.description?.length ?? 0);
  if (tool.parameters !== undefined) {
    try {
      chars += JSON.stringify(tool.parameters).length;
    } catch {
      // ignore
    }
  }
  return Math.ceil(chars / 4);
}

export function buildContextBreakdown(params: {
  systemPrompt: string | null;
  tools: readonly ToolEntry[] | null;
  messageSummary?: MessageContextSummary | null;
  contextUsage?: ContextUsageInfo | null;
}): ContextBreakdown {
  const { systemPrompt, tools, messageSummary, contextUsage } = params;
  const summary = messageSummary ?? EMPTY_MESSAGE_CONTEXT_SUMMARY;

  const systemPromptTokens = estimateTextTokens(systemPrompt);

  const activeDeclaredTools = (tools ?? []).filter(
    (tool) => tool.active && !tool.declarationHidden,
  );
  const toolDeclarations: ToolDeclarationTokenItem[] = activeDeclaredTools
    .map((tool) => ({
      name: tool.name,
      tokens: estimateToolDeclarationTokens(tool),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name));

  const toolsTokens = toolDeclarations.reduce((sum, item) => sum + item.tokens, 0);

  const rawCategories: Array<{
    id: ContextCategoryId;
    color: string;
    estimatedTokens: number;
    alwaysShow: boolean;
  }> = [
    { id: "system", color: "#3b82f6", estimatedTokens: systemPromptTokens, alwaysShow: true },
    { id: "tools", color: "#8b5cf6", estimatedTokens: toolsTokens, alwaysShow: true },
    { id: "compaction", color: "#14b8a6", estimatedTokens: summary.compactionTokens, alwaysShow: false },
    { id: "user", color: "#10b981", estimatedTokens: summary.userTokens, alwaysShow: true },
    { id: "assistant", color: "#f59e0b", estimatedTokens: summary.assistantTextTokens, alwaysShow: true },
    { id: "thinking", color: "#ec4899", estimatedTokens: summary.assistantThinkingTokens, alwaysShow: false },
    { id: "toolTraffic", color: "#f97316", estimatedTokens: summary.toolTrafficTokens, alwaysShow: true },
  ];

  const visibleRaw = rawCategories.filter(
    (cat) => cat.alwaysShow || cat.estimatedTokens > 0,
  );

  const estimatedTokens = visibleRaw.reduce((sum, cat) => sum + cat.estimatedTokens, 0);
  const reportedTokens =
    contextUsage?.tokens !== null &&
    contextUsage?.tokens !== undefined &&
    Number.isFinite(contextUsage.tokens) &&
    contextUsage.tokens > 0
      ? Math.round(contextUsage.tokens)
      : null;

  const usedTokens = reportedTokens ?? estimatedTokens;
  const contextWindow =
    contextUsage?.contextWindow !== null &&
    contextUsage?.contextWindow !== undefined &&
    Number.isFinite(contextUsage.contextWindow) &&
    contextUsage.contextWindow > 0
      ? Math.round(contextUsage.contextWindow)
      : null;

  const freeTokens =
    contextWindow !== null ? Math.max(0, contextWindow - usedTokens) : null;
  const usedPercent =
    contextWindow !== null && contextWindow > 0
      ? Math.min(100, (usedTokens / contextWindow) * 100)
      : null;

  const scale =
    reportedTokens !== null && estimatedTokens > 0
      ? reportedTokens / estimatedTokens
      : 1;

  const categories: ContextCategoryItem[] = visibleRaw.map((cat) => {
    const tokens =
      reportedTokens !== null && estimatedTokens > 0
        ? Math.round(cat.estimatedTokens * scale)
        : cat.estimatedTokens;
    const shareOfUsed =
      estimatedTokens > 0 ? cat.estimatedTokens / estimatedTokens : 0;
    const percentOfWindow =
      contextWindow !== null && contextWindow > 0
        ? (tokens / contextWindow) * 100
        : null;
    return {
      id: cat.id,
      color: cat.color,
      estimatedTokens: cat.estimatedTokens,
      tokens,
      shareOfUsed,
      percentOfWindow,
    };
  });

  return {
    categories,
    estimatedTokens,
    reportedTokens,
    usedTokens,
    contextWindow,
    freeTokens,
    usedPercent,
    systemPromptTokens,
    toolsTokens,
    activeToolCount: activeDeclaredTools.length,
    toolDeclarations,
    toolTrafficByTool: summary.toolTrafficByTool,
  };
}
