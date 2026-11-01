import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  exportSessionToJsonl,
  exportSessionToMarkdown,
  normalizeExportFormat,
} = await jiti.import("./session-export.ts");

describe("session-export", () => {
  it("normalizes export format and defaults to html", () => {
    assert.equal(normalizeExportFormat("jsonl"), "jsonl");
    assert.equal(normalizeExportFormat("md"), "md");
    assert.equal(normalizeExportFormat("html"), "html");
    assert.equal(normalizeExportFormat("unknown"), "html");
    assert.equal(normalizeExportFormat(null), "html");
  });

  it("exports a session file to jsonl and markdown", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-web-export-test-"));
    try {
      const filePath = join(dir, "test-session.jsonl");
      const lines = [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "sess-123",
          timestamp: "2026-10-31T08:00:00.000Z",
          cwd: "/tmp/project",
        }),
        JSON.stringify({
          type: "session_info",
          id: "info-1",
          parentId: null,
          timestamp: "2026-10-31T08:00:01.000Z",
          name: "Export Demo",
        }),
        JSON.stringify({
          type: "message",
          id: "msg-1",
          parentId: "info-1",
          timestamp: "2026-10-31T08:00:02.000Z",
          message: {
            role: "user",
            content: "Hello world",
          },
        }),
        JSON.stringify({
          type: "message",
          id: "msg-2",
          parentId: "msg-1",
          timestamp: "2026-10-31T08:00:03.000Z",
          message: {
            role: "assistant",
            provider: "anthropic",
            model: "claude-sonnet-4-5",
            content: [
              { type: "thinking", thinking: "Let me greet the user" },
              { type: "text", text: "Hi there!" },
            ],
          },
        }),
      ];
      writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");

      const jsonl = exportSessionToJsonl(filePath);
      assert.match(jsonl, /"id":"sess-123"/);
      assert.match(jsonl, /"Hello world"/);

      const md = exportSessionToMarkdown(filePath);
      assert.match(md, /^# Export Demo/m);
      assert.match(md, /## User\n\nHello world/);
      assert.match(md, /## Assistant \(anthropic\/claude-sonnet-4-5\)/);
      assert.match(md, /Hi there!/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
