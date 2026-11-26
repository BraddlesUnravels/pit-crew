import { isAbsolute, relative, resolve, win32 } from "node:path";

export type NameKind = "agent" | "worker" | "skill" | "script";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertName(
  kind: NameKind,
  value: unknown,
  context: string,
): asserts value is string {
  if (
    typeof value !== "string"
    || !namePattern.test(value)
    || value.includes("..")
  ) {
    throw new Error(
      `Invalid ${kind} name ${JSON.stringify(value)} in ${context}. ` +
      "Names must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ and must not contain '..'.",
    );
  }
}

export function resolveInside(root: string, relPath: string, allowedDirs: string[]): string {
  if (
    isAbsolute(relPath)
    || win32.isAbsolute(relPath)
    || relPath.split(/[\\/]/).includes("..")
  ) {
    throw new Error(`Path must be relative and cannot contain '..': ${relPath}`);
  }

  const absolutePath = resolve(root, relPath);
  const isAllowed = allowedDirs.some((allowedDir) => {
    const absoluteDir = resolve(root, allowedDir);
    const pathFromDir = relative(absoluteDir, absolutePath);
    return pathFromDir !== ""
      && pathFromDir !== ".."
      && !pathFromDir.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
      && !isAbsolute(pathFromDir);
  });
  if (!isAllowed) {
    throw new Error(`Path resolves outside the allowed folders: ${relPath}`);
  }
  return absolutePath;
}
