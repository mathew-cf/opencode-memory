/**
 * The plugin's tool registry — the single list both plugin surfaces register
 * from. Each entry carries its own effective name, so neither `index.ts` nor
 * `v2.ts` has to repeat the `memory_` / `session_` naming.
 */

import type { MemoryTool } from "../lib/tool-spec";
import * as memory from "./memory";
import * as session from "./session";

export const allTools = [
  memory.search,
  memory.read,
  memory.list,
  memory.save,
  memory.access,
  memory.setup,
  session.search,
  session.searchAll,
  session.read,
  session.list,
] as const;

/** V1 tool map: `{ memory_search: ToolDefinition, ... }`. */
export function v1ToolMap(): Record<string, MemoryTool["v1"]> {
  return Object.fromEntries(allTools.map((entry) => [entry.name, entry.v1]));
}
