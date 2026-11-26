import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { git } from "./git";

export type JournalPhase = "pending" | "completed" | "failed" | "expired";

export interface FoldRecord {
  version: 1;
  id: string;
  action: "fold";
  phase: JournalPhase;
  flat?: boolean;
  branch: string;
  before: string;
  backupRef: string;
  createdAt: string;
  result?: string;
  detail?: string;
}

export interface TakeFile {
  path: string;
  sha256: string;
  mode: string;
}

export interface TakeRecord {
  version: 1;
  id: string;
  action: "take";
  phase: JournalPhase;
  source: string;
  sourceCommit: string;
  createdAt: string;
  files: TakeFile[];
  createdDirs: string[];
  detail?: string;
}

interface UndoRecordBase {
  version: 1;
  id: string;
  action: "undo";
  phase: JournalPhase;
  undoes: string;
  createdAt: string;
  detail?: string;
}

export interface FoldUndoRecord extends UndoRecordBase {
  kind: "fold";
  branch: string;
  before: string;
  target: string;
  backupRef: string;
}

export interface TakeUndoRecord extends UndoRecordBase {
  kind: "take";
  removed: string[];
  backupRefs: string[];
}

export type UndoRecord = FoldUndoRecord | TakeUndoRecord;

export type UndoableRecord = FoldRecord | TakeRecord;

export type JournalRecord = FoldRecord | TakeRecord | UndoRecord;

export const MAX_UNDOABLE = 3;

export interface Journal {
  path: string;
  root: string;
}

export async function openJournal(root: string): Promise<Journal> {
  const result = await git(["rev-parse", "--git-path", "pit/journal.jsonl"], { cwd: root });
  const path = result.stdout.trim();
  const absolutePath = resolve(root, path);
  await mkdir(dirname(absolutePath), { recursive: true });
  return { path: absolutePath, root };
}

export function newOperationId(): string {
  return `${new Date().toISOString().replaceAll(/[-:.]/g, "")}-${randomUUID()}`;
}

export async function readJournal(journal: Journal): Promise<JournalRecord[]> {
  let contents: string;
  try {
    contents = await readFile(journal.path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const records: JournalRecord[] = [];
  for (const [index, line] of contents.split("\n").entries()) {
    if (line.length === 0) {
      continue;
    }
    try {
      const record = JSON.parse(line) as JournalRecord;
      if (record.version !== 1 || typeof record.id !== "string") {
        throw new Error("unsupported journal entry");
      }
      records.push(record);
    } catch (error) {
      throw new Error(`Journal is malformed at line ${index + 1}: ${(error as Error).message}`);
    }
  }
  return records;
}

export async function appendJournal(journal: Journal, record: JournalRecord): Promise<void> {
  const file = await open(journal.path, "a", 0o600);
  try {
    await file.write(`${JSON.stringify(record)}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function updateRef(root: string, ref: string, oid: string): Promise<void> {
  await git(["update-ref", ref, oid], { cwd: root });
}

export async function deleteRef(root: string, ref: string): Promise<void> {
  const result = await git(["update-ref", "-d", ref], { cwd: root, allowFailure: true });
  if (result.exitCode !== 0) {
    throw new Error(`Could not remove backup ref ${ref}: ${result.stderr.trim()}`);
  }
}

export async function withJournalLock<T>(journal: Journal, work: () => Promise<T>): Promise<T> {
  const lockPath = `${journal.path}.lock`;
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Another pit operation may be running (or a stale lock exists at ${lockPath}).`,
      );
    }
    throw error;
  }

  try {
    await lock.writeFile(`${process.pid}\n`);
    await lock.sync();
    return await work();
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export function latestRecords(records: JournalRecord[]): Map<string, JournalRecord> {
  const latest = new Map<string, JournalRecord>();
  for (const record of records) {
    latest.set(record.id, record);
  }
  return latest;
}

export function undoneIds(records: JournalRecord[]): Set<string> {
  return new Set(
    [...latestRecords(records).values()]
      .filter((record): record is UndoRecord => record.action === "undo" && record.phase === "completed")
      .map((record) => record.undoes),
  );
}

export function undoableActions(records: JournalRecord[]): UndoableRecord[] {
  const latest = latestRecords(records);
  const lastSeen = new Map<string, number>();
  records.forEach((record, index) => lastSeen.set(record.id, index));
  const undone = undoneIds(records);
  return [...latest.values()]
    .filter((record): record is UndoableRecord =>
      record.action !== "undo" && record.phase === "completed" && !undone.has(record.id))
    .sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt)
      || (lastSeen.get(right.id) ?? 0) - (lastSeen.get(left.id) ?? 0));
}

export async function applyRetention(root: string, journal: Journal): Promise<void> {
  const excess = undoableActions(await readJournal(journal)).slice(MAX_UNDOABLE);
  for (const record of excess) {
    await appendJournal(journal, { ...record, phase: "expired" });
    if (record.action === "fold") {
      await deleteRef(root, record.backupRef);
    }
  }
}
