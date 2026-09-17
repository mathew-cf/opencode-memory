import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { SessionSearchRequest } from "./session-fanout";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CodexThread {
  id: string;
  preview?: string;
  name?: string | null;
  cwd?: string;
  updatedAt?: number;
}

interface SearchResponse {
  data?: Array<{ thread: CodexThread; snippet?: string }>;
  nextCursor?: string | null;
}

class CodexClient {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private stderr = "";

  constructor(command = process.env.CODEX_SESSION_TOOLS_CLI || "codex") {
    this.child = spawn(command, ["app-server", "--stdio"], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
    createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-8_000);
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.stdin.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code) => {
      if (!this.closed) {
        const detail = this.stderr.trim();
        this.rejectAll(new Error(`Codex app-server exited before responding (code ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`));
      }
    });
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "opencode-memory", title: "Unified session search", version: "1.0.0" },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: "notifications/initialized", params: {} });
  }

  request = (method: string, params: JsonObject): Promise<unknown> => {
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ id, method, params });
    return result;
  };

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.child.stdin.end();
    this.child.kill();
    this.rejectAll(new Error("Codex app-server client closed"));
  }

  private write(message: JsonObject): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: JsonObject;
    try { message = JSON.parse(line) as JsonObject; } catch { return; }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`Codex app-server error: ${JSON.stringify(message.error)}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      this.write({ id: message.id, error: { code: -32601, message: "client request unsupported" } });
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function title(thread: CodexThread): string {
  const value = (thread.name || thread.preview || "Untitled Codex session").replace(/\s+/g, " ").trim();
  return value.length > 100 ? `${value.slice(0, 97)}...` : value;
}

function formatTime(seconds?: number): string {
  return seconds ? new Date(seconds * 1000).toISOString().replace("T", " ").replace(".000Z", "Z") : "unknown";
}

export async function searchCodexSessions(request: SessionSearchRequest): Promise<string> {
  const client = new CodexClient();
  try {
    await client.initialize();
    const terms = [...new Set(request.query.trim().split(/\s+/).filter(Boolean).map((term) => term.toLowerCase()))].slice(0, 8);
    const hits = new Map<string, { thread: CodexThread; snippet: string; terms: Set<string>; archived: boolean }>();
    const searches: Promise<void>[] = [];
    for (const term of terms) {
      for (const archived of [false, true]) {
        for (const sourceKinds of [undefined, ["exec", "appServer"]]) {
          searches.push((async () => {
            let cursor: string | undefined;
            let pages = 0;
            do {
              const response = await client.request("thread/search", {
                searchTerm: term,
                limit: 100,
                sortKey: "updated_at",
                sortDirection: "desc",
                archived,
                ...(sourceKinds ? { sourceKinds } : {}),
                ...(cursor ? { cursor } : {}),
              }) as SearchResponse;
              for (const result of response.data ?? []) {
                if (!result.thread?.id) continue;
                if (request.directory && !String(result.thread.cwd ?? "").includes(request.directory)) continue;
                const existing = hits.get(result.thread.id);
                if (existing) existing.terms.add(term);
                else hits.set(result.thread.id, { thread: result.thread, snippet: result.snippet ?? "", terms: new Set([term]), archived });
              }
              cursor = response.nextCursor ?? undefined;
              pages++;
            } while (cursor && pages < 5 && hits.size < 250);
          })());
        }
      }
    }
    await Promise.all(searches);
    const shown = [...hits.values()]
      .sort((a, b) => b.terms.size - a.terms.size || Number(b.thread.updatedAt ?? 0) - Number(a.thread.updatedAt ?? 0))
      .slice(0, request.limit);
    if (shown.length === 0) return `No Codex sessions found matching "${request.query}".`;
    const lines = [`${shown.length} Codex session(s) matching "${request.query}"`, ""];
    for (const [index, hit] of shown.entries()) {
      const count = terms.length > 1 ? ` (${hit.terms.size}/${terms.length} terms)` : "";
      lines.push(`${index + 1}. **${title(hit.thread)}**${count}${hit.archived ? " [archived]" : ""}`);
      lines.push(`   id: ${hit.thread.id}`);
      lines.push(`   dir: ${hit.thread.cwd ?? "unknown"}`);
      lines.push(`   updated: ${formatTime(hit.thread.updatedAt)}`);
      if (hit.snippet) lines.push(`   snippet: ${hit.snippet.replace(/\s+/g, " ").slice(0, 240)}`);
      lines.push("");
    }
    return lines.join("\n").trimEnd();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") throw new Error("Codex is not installed or is not on PATH");
    throw error;
  } finally {
    client.close();
  }
}
