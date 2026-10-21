/** Shared filesystem containment for memory and indexed knowledge reads. */
import { realpath } from "node:fs/promises";
import { containedRelativePath, resolveContainedPath } from "../lib/paths";

export async function resolveFileContained(root: string, source: string): Promise<string> {
  const file = resolveContainedPath(root, source);
  const [realRoot, realFile] = await Promise.all([realpath(root), realpath(file)]);
  try {
    containedRelativePath(realRoot, realFile);
  } catch {
    throw new Error("source escapes its configured root");
  }
  return realFile;
}
