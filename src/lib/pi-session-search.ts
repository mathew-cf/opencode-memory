import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveRgBinary } from "./ripgrep";
import type { SessionSearchRequest } from "./session-fanout";

const MAX_CANDIDATES = 250;

interface PiSession {
  id: string;
  cwd: string;
  title: string;
  modified: number;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
}

function sessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_CODING_AGENT_SESSION_DIR) return env.PI_CODING_AGENT_SESSION_DIR.replace(/^~/, homedir());
  const agentDir = (env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")).replace(/^~/, homedir());
  return join(agentDir, "sessions");
}

async function sessionFiles(root: string, depth = 0): Promise<Array<{ path: string; modified: number }>> {
  if (depth > 3) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sessionFiles(path, depth + 1);
    if (!entry.name.endsWith(".jsonl")) return [];
    const metadata = await stat(path).catch(() => undefined);
    return metadata ? [{ path, modified: metadata.mtimeMs }] : [];
  }));
  return nested.flat();
}

async function candidates(root: string, terms: string[]): Promise<string[] | undefined> {
  const rg = resolveRgBinary();
  if (!rg) return undefined;
  const args = ["--files-with-matches", "--no-messages", "-i", "-F", "--glob", "*.jsonl"];
  for (const term of terms) args.push("-e", term);
  args.push(root);
  const child = Bun.spawn([rg, ...args], { stdout: "pipe", stderr: "ignore" });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode === 1) return [];
  if (exitCode !== 0) return undefined;
  return stdout.split("\n").filter(Boolean);
}

function messageText(value: unknown): { role: "user" | "assistant"; text: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const message = value as { role?: unknown; content?: unknown };
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  const text = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content.flatMap((block) => {
          if (!block || typeof block !== "object") return [];
          const typed = block as { type?: unknown; text?: unknown };
          return typed.type === "text" && typeof typed.text === "string" ? [typed.text] : [];
        }).join("\n")
      : "";
  return text.trim() ? { role: message.role, text: text.trim() } : undefined;
}

async function parseSession(path: string, fallbackModified: number): Promise<PiSession | undefined> {
  const raw = await readFile(path, "utf8").catch(() => "");
  if (!raw) return undefined;
  let id = basename(path, ".jsonl").split("_").pop() || basename(path, ".jsonl");
  let cwd = "";
  let name = "";
  let modified = fallbackModified;
  const messages: PiSession["messages"] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try { entry = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const timestamp = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    if (Number.isFinite(timestamp)) modified = Math.max(modified, timestamp);
    if (entry.type === "session") {
      if (typeof entry.id === "string") id = entry.id;
      if (typeof entry.cwd === "string") cwd = entry.cwd;
    } else if (entry.type === "session_info" && typeof entry.name === "string") {
      name = entry.name;
    } else if (entry.type === "message") {
      const message = messageText(entry.message);
      if (message) messages.push(message);
    }
  }
  const firstUser = messages.find((message) => message.role === "user")?.text.replace(/\s+/g, " ");
  const title = name || (firstUser ? `${firstUser.slice(0, 77)}${firstUser.length > 77 ? "..." : ""}` : "(untitled)");
  return { id, cwd, title, modified, messages };
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").replace(".000Z", "Z");
}

export async function searchPiSessions(request: SessionSearchRequest): Promise<string> {
  const root = sessionsRoot();
  const metadata = await stat(root).catch(() => undefined);
  if (!metadata?.isDirectory()) throw new Error("Pi is not installed or has no session history");
  const terms = request.query.trim().split(/\s+/).filter(Boolean);
  const matched = await candidates(root, terms);
  const allFiles = matched ? undefined : await sessionFiles(root);
  const files = (matched
    ? await Promise.all(matched.slice(0, MAX_CANDIDATES).map(async (path) => ({ path, modified: (await stat(path).catch(() => undefined))?.mtimeMs ?? 0 })))
    : allFiles ?? [])
    .sort((a, b) => b.modified - a.modified)
    .slice(0, MAX_CANDIDATES);
  const parsed = (await Promise.all(files.map((file) => parseSession(file.path, file.modified))))
    .filter((session): session is PiSession => Boolean(session));
  const lowered = terms.map((term) => term.toLowerCase());
  const hits = parsed.flatMap((session) => {
    if (request.directory && !session.cwd.includes(request.directory)) return [];
    const titleHits = lowered.filter((term) => session.title.toLowerCase().includes(term)).length;
    let offset = -1;
    let contentHits = 0;
    for (const [index, message] of session.messages.entries()) {
      const count = lowered.filter((term) => message.text.toLowerCase().includes(term)).length;
      if (count > contentHits) { contentHits = count; offset = index; }
    }
    if (titleHits === 0 && contentHits === 0) return [];
    return [{ session, hits: Math.max(titleHits, contentHits), titleHits, contentHits, offset }];
  }).sort((a, b) => b.hits - a.hits || b.session.modified - a.session.modified)
    .slice(0, request.limit);
  if (hits.length === 0) return `No Pi sessions found matching "${request.query}".`;
  const lines = [`${hits.length} Pi session(s) matching "${request.query}"`, ""];
  for (const [index, hit] of hits.entries()) {
    const match = hit.titleHits && hit.contentHits ? "title+content" : hit.titleHits ? "title" : "content";
    const count = terms.length > 1 ? ` (${hit.hits}/${terms.length} terms)` : "";
    lines.push(`${index + 1}. **${hit.session.title}** [${match}]${count}`);
    lines.push(`   id: ${hit.session.id}`);
    lines.push(`   dir: ${hit.session.cwd || "unknown"}`);
    lines.push(`   updated: ${formatTime(hit.session.modified)}`);
    if (hit.offset >= 0) {
      const snippet = hit.session.messages[hit.offset].text.replace(/\s+/g, " ").slice(0, 200);
      lines.push(`   snippet: ${snippet}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
