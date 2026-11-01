import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": new URL("..", import.meta.url).pathname.replace(/\/$/, "") },
});

const {
  SessionShareError,
  extractRadiusToken,
  getShareViewerUrl,
  serializeSessionBranchForShare,
  shareSessionBranch,
} = await jiti.import("./session-share.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");

function makeTempSessionFile(tempDir) {
  const filePath = join(tempDir, "2026-10-31T00-00-00-000Z_test-session.jsonl");
  const lines = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "test-session",
      timestamp: "2026-10-31T00:00:00.000Z",
      cwd: tempDir,
    }),
    JSON.stringify({
      type: "message",
      id: "msg1",
      parentId: null,
      timestamp: "2026-10-31T00:00:01.000Z",
      message: { role: "user", content: "Hello" },
    }),
    JSON.stringify({
      type: "message",
      id: "msg2",
      parentId: "msg1",
      timestamp: "2026-10-31T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hi there" }],
      },
    }),
  ];
  writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

test("extractRadiusToken reads apiKey or Authorization Bearer header", () => {
  assert.equal(extractRadiusToken({ auth: { apiKey: "rad_123" } }), "rad_123");
  assert.equal(
    extractRadiusToken({ auth: { headers: { Authorization: "Bearer tok_abc" } } }),
    "tok_abc",
  );
  assert.equal(extractRadiusToken(undefined), undefined);
});

test("serializeSessionBranchForShare appends trailing pi.share entry", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-share-test-"));
  try {
    const filePath = makeTempSessionFile(tempDir);
    const sm = SessionManager.open(filePath, tempDir);
    const jsonl = serializeSessionBranchForShare(sm, {
      systemPrompt: "You are pi",
      tools: [{ name: "read", description: "Read file" }],
      timestamp: "2026-10-31T01:00:00.000Z",
      shareEntryId: "share123",
    });
    const parsed = jsonl.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(parsed.length, 4);
    assert.equal(parsed[0].type, "session");
    assert.equal(parsed[3].type, "custom");
    assert.equal(parsed[3].customType, "pi.share");
    assert.equal(parsed[3].parentId, "msg2");
    assert.deepEqual(parsed[3].data, {
      systemPrompt: "You are pi",
      tools: [{ name: "read", description: "Read file" }],
    });
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("shareSessionBranch uploads to Radius when configured and falls back to gist", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-share-test-"));
  try {
    const filePath = makeTempSessionFile(tempDir);

    const radiusResult = await shareSessionBranch(
      { sessionPath: filePath, systemPrompt: "sys" },
      {
        getDestination: () => undefined,
        getRadiusToken: async () => "rad_tok",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({ artifact: { canonical_url: "https://radius.pi.dev/a/123" } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      },
    );
    assert.deepEqual(radiusResult, {
      destination: "radius",
      shareUrl: "https://radius.pi.dev/a/123",
    });

    const gistResult = await shareSessionBranch(
      { sessionPath: filePath },
      {
        getDestination: () => "gist",
        checkGhAuth: async () => "ok",
        exportHtml: async (_jsonl, htmlPath) => {
          writeFileSync(htmlPath, "<html></html>", "utf8");
        },
        createGist: async () => "https://gist.github.com/tasselx/abcdef123456",
      },
    );
    assert.deepEqual(gistResult, {
      destination: "gist",
      shareUrl: getShareViewerUrl("abcdef123456"),
      gistUrl: "https://gist.github.com/tasselx/abcdef123456",
    });

    await assert.rejects(
      () =>
        shareSessionBranch(
          { sessionPath: filePath },
          {
            getDestination: () => "radius",
            getRadiusToken: async () => undefined,
          },
        ),
      (err) => err instanceof SessionShareError && err.code === "radius_unconfigured",
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
