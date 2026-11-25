import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

/** Returns the sha256 of a regular file, or null when the path is missing or not a regular file. */
export async function regularFileSha256(path: string): Promise<string | null> {
  try {
    const stats = await lstat(path);
    if (!stats.isFile()) {
      return null;
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return null;
    }
    throw error;
  }
  return sha256(await readFile(path));
}
