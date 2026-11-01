import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildContextBreakdown,
  estimateToolDeclarationTokens,
  summarizeMessagesContext,
} from "./context-breakdown.ts";

describe("context-breakdown", () => {
  it("summarizes user, assistant, thinking, compaction, and per-tool traffic", () => {
    const messages = [
      {
        role: "custom",
        customType: "compaction",
        content: "x".repeat(400),
        display: true,
      },
      {
        role: "user",
        content: "u".repeat(200),
      },
      {
        role: "assistant",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        content: [
          { type: "thinking", thinking: "t".repeat(120) },
          { type: "text", text: "a".repeat(240) },
          {
            type: "toolCall",
            toolCallId: "tc-1",
            toolName: "read",
            input: { path: "README.md" },
          },
          {
            type: "toolCall",
            toolCallId: "tc-2",
            toolName: "bash",
            input: { command: "ls -la" },
          },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "tc-1",
        content: [{ type: "text", text: "r".repeat(800) }],
      },
      {
        role: "toolResult",
        toolCallId: "tc-2",
        toolName: "bash",
        content: [{ type: "text", text: "b".repeat(120) }],
      },
    ];

    const summary = summarizeMessagesContext(messages);
    assert.equal(summary.compactionTokens, 100);
    assert.equal(summary.userTokens, 50);
    assert.equal(summary.userCount, 1);
    assert.equal(summary.assistantThinkingTokens, 30);
    assert.equal(summary.assistantTextTokens, 60);
    assert.equal(summary.assistantCount, 1);
    assert.equal(summary.toolCallCount, 2);
    assert.equal(summary.toolResultCount, 2);
    assert.equal(summary.toolTrafficByTool.length, 2);
    assert.equal(summary.toolTrafficByTool[0].name, "read");
    assert.equal(summary.toolTrafficByTool[0].calls, 1);
    assert.equal(summary.toolTrafficByTool[1].name, "bash");
    assert.equal(summary.toolTrafficByTool[1].calls, 1);
    assert.ok(summary.toolTrafficByTool[0].tokens > summary.toolTrafficByTool[1].tokens);
  });

  it("builds breakdown and scales category tokens when provider usage is reported", () => {
    const tools = [
      {
        name: "read",
        description: "Read a file from disk",
        parameters: { type: "object", properties: { path: { type: "string" } } },
        active: true,
      },
      {
        name: "hidden_tool",
        description: "Deferred MCP tool",
        parameters: { type: "object" },
        active: true,
        declarationHidden: true,
      },
      {
        name: "inactive_tool",
        description: "Disabled tool",
        parameters: { type: "object" },
        active: false,
      },
    ];

    const messageSummary = summarizeMessagesContext([
      { role: "user", content: "u".repeat(400) },
      {
        role: "assistant",
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        content: [{ type: "text", text: "a".repeat(400) }],
      },
    ]);

    const breakdown = buildContextBreakdown({
      systemPrompt: "s".repeat(800),
      tools,
      messageSummary,
      contextUsage: {
        tokens: 1000,
        contextWindow: 10000,
        percent: 10,
      },
    });

    assert.equal(breakdown.activeToolCount, 1);
    assert.equal(breakdown.toolDeclarations.length, 1);
    assert.equal(breakdown.toolDeclarations[0].name, "read");
    assert.equal(breakdown.toolDeclarations[0].tokens, estimateToolDeclarationTokens(tools[0]));
    assert.equal(breakdown.usedTokens, 1000);
    assert.equal(breakdown.contextWindow, 10000);
    assert.equal(breakdown.freeTokens, 9000);
    assert.equal(breakdown.usedPercent, 10);

    const systemCat = breakdown.categories.find((c) => c.id === "system");
    assert.ok(systemCat);
    assert.equal(systemCat.estimatedTokens, 200);
    assert.ok(systemCat.tokens > systemCat.estimatedTokens);
  });
});
