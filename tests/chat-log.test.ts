import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFs } from "../src/index.js";
import type { ClipfirstFs } from "../src/index.js";
import {
  formatHistoryForPrompt,
  getRecentHistory,
  logUserTurn,
  logAssistantTurn,
} from "../src/chat-log.js";
import type { ChatLogEntry } from "../src/chat-log.js";

describe("formatHistoryForPrompt", () => {
  it("returns empty string for empty array", () => {
    expect(formatHistoryForPrompt([])).toBe("");
  });

  it("formats user lines with 'User:' prefix", () => {
    const lines: ChatLogEntry[] = [
      { role: "user", text: "hello world", ts: Date.now() },
    ];
    const result = formatHistoryForPrompt(lines);
    expect(result).toContain("User: hello world");
  });

  it("formats assistant lines with tool tag and message", () => {
    const lines: ChatLogEntry[] = [
      {
        role: "assistant",
        tool: "trim_video",
        message: "Trimmed successfully",
        ts: Date.now(),
      },
    ];
    const result = formatHistoryForPrompt(lines);
    expect(result).toContain("Assistant: [trim_video] Trimmed successfully");
  });

  it("formats assistant lines without a tool", () => {
    const lines: ChatLogEntry[] = [
      {
        role: "assistant",
        message: "Done",
        ts: Date.now(),
      },
    ];
    const result = formatHistoryForPrompt(lines);
    expect(result).toContain("Assistant: Done");
    expect(result).not.toContain("[");
  });

  it("formats mixed user and assistant lines", () => {
    const lines: ChatLogEntry[] = [
      { role: "user", text: "trim this video", ts: Date.now() },
      {
        role: "assistant",
        tool: "trim_video",
        message: "Trimming video.",
        ts: Date.now(),
      },
    ];
    const result = formatHistoryForPrompt(lines);
    expect(result).toContain("Recent conversation:");
    expect(result).toContain("User: trim this video");
    expect(result).toContain("Assistant: [trim_video] Trimming video.");
  });

  it("handles entries with missing text/message gracefully", () => {
    const lines: ChatLogEntry[] = [
      { role: "user", ts: Date.now() },
      { role: "assistant", ts: Date.now() },
    ];
    const result = formatHistoryForPrompt(lines);
    expect(result).toContain("User: ");
    expect(result).toContain("Assistant: ");
  });
});

describe("chat log round-trip (real fs)", () => {
  let tempDir: string;
  let fs: ClipfirstFs;
  const slug = "test-proj";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clipfirst-chatlog-"));
    fs = createFs({ projectsDir: tempDir });
    await fs.createProject(slug);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("logs a user turn and retrieves it", async () => {
    logUserTurn(fs, slug, "hello");
    // Give the async fire-and-forget a moment to flush
    await new Promise((r) => setTimeout(r, 100));

    const history = await getRecentHistory(fs, slug);
    expect(history.length).toBe(1);
    expect(history[0].role).toBe("user");
    expect(history[0].text).toBe("hello");
  });

  it("logs an assistant turn and retrieves it", async () => {
    logAssistantTurn(fs, slug, "trim_video", { asset_id: "vid-abc" }, "Trimming video.", false);
    await new Promise((r) => setTimeout(r, 100));

    const history = await getRecentHistory(fs, slug);
    expect(history.length).toBe(1);
    expect(history[0].role).toBe("assistant");
    expect(history[0].tool).toBe("trim_video");
    expect(history[0].message).toBe("Trimming video.");
    expect(history[0].error).toBe(false);
  });

  it("round-trips multiple turns and respects limit", async () => {
    logUserTurn(fs, slug, "first");
    await new Promise((r) => setTimeout(r, 500));
    logAssistantTurn(fs, slug, "list_assets", {}, "Listing.", false);
    await new Promise((r) => setTimeout(r, 500));
    logUserTurn(fs, slug, "second");
    await new Promise((r) => setTimeout(r, 500));

    const all = await getRecentHistory(fs, slug, 10);
    expect(all.length).toBe(3);

    const limited = await getRecentHistory(fs, slug, 2);
    expect(limited.length).toBe(2);
  });

  it("returns empty array when no chat log exists", async () => {
    const history = await getRecentHistory(fs, slug);
    expect(history).toEqual([]);
  });
});
