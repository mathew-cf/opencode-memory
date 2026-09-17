export type SessionSource = "OpenCode" | "Pi" | "Codex";

export interface SessionSearchRequest {
  query: string;
  limit: number;
  directory?: string;
  currentSessionId?: string;
}

export interface SessionSearchProvider {
  source: SessionSource;
  search: (request: SessionSearchRequest) => Promise<string>;
}

function unavailableReason(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message.trim();
  return "not installed or its session store is unavailable";
}

/** Start every session backend before awaiting any one of them. */
export async function searchSessionProviders(
  request: SessionSearchRequest,
  providers: SessionSearchProvider[],
): Promise<string> {
  const settled = await Promise.allSettled(
    providers.map((provider) => Promise.resolve().then(() => provider.search(request))),
  );

  const sections: string[] = [
    `## Session search across ${providers.map((provider) => provider.source).join(", ")}`,
  ];
  const unavailable: string[] = [];

  for (const [index, result] of settled.entries()) {
    const source = providers[index].source;
    if (result.status === "rejected") {
      unavailable.push(`${source}: ${unavailableReason(result.reason)}`);
      continue;
    }
    sections.push(`### ${source}\n\n${result.value.trim()}`);
  }

  if (unavailable.length > 0) {
    sections.push(`_Unavailable sources: ${unavailable.join("; ")}_`);
  }

  return sections.join("\n\n");
}
