import type { ClipfirstFs } from "./index.js";

type ChatLogEntry = {
  role: "user" | "assistant";
  text?: string;
  tool?: string;
  params?: Record<string, unknown>;
  message?: string;
  error?: boolean;
  ts: number;
};

function logUserTurn(fs: ClipfirstFs, slug: string, prompt: string): void {
  fs.appendLog("chat", { role: "user", text: prompt, ts: Date.now() }, slug).catch(() => {});
}

function logAssistantTurn(
  fs: ClipfirstFs,
  slug: string,
  tool: string,
  params: Record<string, unknown>,
  message: string,
  isError: boolean,
): void {
  fs.appendLog("chat", { role: "assistant", tool, params, message, error: isError, ts: Date.now() }, slug).catch(() => {});
}

async function getRecentHistory(
  fs: ClipfirstFs,
  slug: string,
  limit = 10,
): Promise<ChatLogEntry[]> {
  const raw = await fs.readLog("chat", slug, { limit });
  return raw as ChatLogEntry[];
}

function formatHistoryForPrompt(lines: ChatLogEntry[]): string {
  if (lines.length === 0) return "";

  const formatted = lines.map((line) => {
    if (line.role === "user") {
      return `User: ${line.text ?? ""}`;
    }
    const toolTag = line.tool ? `[${line.tool}] ` : "";
    return `Assistant: ${toolTag}${line.message ?? ""}`;
  });

  return `Recent conversation:\n${formatted.join("\n")}`;
}

export { logUserTurn, logAssistantTurn, getRecentHistory, formatHistoryForPrompt };
export type { ChatLogEntry };
