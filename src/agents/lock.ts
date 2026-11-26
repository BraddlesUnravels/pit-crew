import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AgentManifest } from "./manifest";
import type { RemoteRepo } from "./remote";

export interface LockedFile {
  readonly path: string;
  readonly sha256: string;
}

export type EntryStatus = "installing" | "installed" | "removing";

export interface AgentsLock {
  version: 1;
  source: { repo: string; commit: string };
  agents: Record<string, {
    status: EntryStatus;
    commit: string;
    manifest: AgentManifest;
    files: LockedFile[];
  }>;
  skills: Record<string, {
    status: EntryStatus;
    explicit: boolean;
    requiredBy: string[];
    commit: string;
    files: LockedFile[];
  }>;
}

const lockRelativePath = ".github/pit-agents.lock.json";

export function emptyLock(repo: Pick<RemoteRepo, "url" | "commit">): AgentsLock {
  return {
    version: 1,
    source: { repo: repo.url, commit: repo.commit },
    agents: {},
    skills: {},
  };
}

function lockError(detail: string): Error {
  return new Error(
    `Invalid ${lockRelativePath}: ${detail}. Fix or delete ${lockRelativePath}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isManifest(value: unknown): value is AgentManifest {
  return isRecord(value)
    && typeof value.agent === "string"
    && (value.workers === undefined || isStringArray(value.workers))
    && (value.skills === undefined || isStringArray(value.skills))
    && (value.scripts === undefined || isStringArray(value.scripts))
    && (
      value.uses === undefined
      || (Array.isArray(value.uses) && value.uses.every((use) =>
        isRecord(use) && typeof use.agent === "string" && typeof use.worker === "string"))
    );
}

function isLockedFiles(value: unknown): value is LockedFile[] {
  return Array.isArray(value) && value.every((file) =>
    isRecord(file) && typeof file.path === "string" && typeof file.sha256 === "string");
}

function isEntryStatus(value: unknown): value is EntryStatus {
  return value === "installing" || value === "installed" || value === "removing";
}

function isAgentsLock(value: unknown): value is AgentsLock {
  return isRecord(value)
    && isRecord(value.source)
    && typeof value.source.repo === "string"
    && typeof value.source.commit === "string"
    && isRecord(value.agents)
    && Object.values(value.agents).every((entry) =>
      isRecord(entry)
      && isEntryStatus(entry.status)
      && typeof entry.commit === "string"
      && isManifest(entry.manifest)
      && isLockedFiles(entry.files))
    && isRecord(value.skills)
    && Object.values(value.skills).every((entry) =>
      isRecord(entry)
      && isEntryStatus(entry.status)
      && typeof entry.explicit === "boolean"
      && isStringArray(entry.requiredBy)
      && typeof entry.commit === "string"
      && isLockedFiles(entry.files));
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sorted);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sorted(value[key])]),
  );
}

export async function readLock(root: string): Promise<AgentsLock> {
  const path = resolve(root, lockRelativePath);
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyLock({ url: "", commit: "" });
    }
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (error) {
    throw lockError(`could not parse JSON (${(error as Error).message})`);
  }
  if (!isRecord(value) || value.version !== 1) {
    throw lockError("unknown or missing version");
  }
  if (!isAgentsLock(value)) {
    throw lockError("the lock file has an invalid structure");
  }
  return value;
}

export async function writeLock(root: string, lock: AgentsLock): Promise<void> {
  const path = resolve(root, lockRelativePath);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(sorted(lock), null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}
