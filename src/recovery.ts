import { join } from "node:path";
import {
  appendJournal,
  applyRetention,
  latestRecords,
  readJournal,
  type FoldRecord,
  type FoldUndoRecord,
  type Journal,
  type JournalRecord,
  type TakeRecord,
  type TakeUndoRecord,
} from "./journal";
import { git } from "./git";
import { regularFileSha256 } from "./files";

async function findOperationReflogEntry(
  root: string,
  branch: string,
  action: "fold" | "undo",
  id: string,
): Promise<string | null> {
  const result = await git(
    ["reflog", `--format=%H%x09%gs`, `refs/heads/${branch}`],
    { cwd: root, allowFailure: true },
  );
  const marker = `pit ${action} ${id}`;
  for (const line of result.stdout.split("\n")) {
    const [oid, message] = line.split("\t", 2);
    if (oid !== undefined && message?.startsWith(marker)) {
      return oid;
    }
  }
  return null;
}

async function branchHead(root: string, branch: string): Promise<string> {
  return (await git(
    ["rev-parse", "--verify", `refs/heads/${branch}`],
    { cwd: root, allowFailure: true },
  )).stdout.trim();
}

async function reconcileFold(root: string, journal: Journal, record: FoldRecord): Promise<boolean> {
  const operationResult = await findOperationReflogEntry(root, record.branch, "fold", record.id);
  if (operationResult !== null) {
    await appendJournal(journal, { ...record, phase: "completed", result: operationResult });
    return true;
  }
  if (await branchHead(root, record.branch) === record.before) {
    await appendJournal(journal, {
      ...record,
      phase: "failed",
      detail: "No fold ref update was recorded.",
    });
    return false;
  }
  throw new Error(
    `Cannot safely reconcile interrupted fold ${record.id}; ` +
    `its backup is retained at ${record.backupRef}.`,
  );
}

async function reconcileFoldUndo(root: string, journal: Journal, record: FoldUndoRecord): Promise<void> {
  const operationResult = await findOperationReflogEntry(root, record.branch, "undo", record.id);
  if (operationResult !== null) {
    await appendJournal(journal, { ...record, phase: "completed" });
    return;
  }
  if (await branchHead(root, record.branch) === record.before) {
    await appendJournal(journal, {
      ...record,
      phase: "failed",
      detail: "No undo ref update was recorded.",
    });
    return;
  }
  throw new Error(
    `Cannot safely reconcile interrupted undo ${record.id}; ` +
    `its backup is retained at ${record.backupRef}.`,
  );
}

export async function takenFilesOnDisk(root: string, record: TakeRecord): Promise<TakeRecord["files"]> {
  const present: TakeRecord["files"] = [];
  for (const file of record.files) {
    if (await regularFileSha256(join(root, file.path)) === file.sha256) {
      present.push(file);
    }
  }
  return present;
}

async function reconcileTake(root: string, journal: Journal, record: TakeRecord): Promise<boolean> {
  const files = await takenFilesOnDisk(root, record);
  if (files.length > 0) {
    await appendJournal(journal, { ...record, phase: "completed", files });
    return true;
  }
  await appendJournal(journal, {
    ...record,
    phase: "failed",
    detail: "No taken files were found on disk.",
  });
  return false;
}

async function reconcileTakeUndo(
  root: string,
  journal: Journal,
  record: TakeUndoRecord,
  take: JournalRecord | undefined,
): Promise<void> {
  const remaining = take?.action === "take" ? await takenFilesOnDisk(root, take) : [];
  if (remaining.length === 0) {
    await appendJournal(journal, { ...record, phase: "completed" });
  } else {
    await appendJournal(journal, {
      ...record,
      phase: "failed",
      detail: `Interrupted with ${remaining.length} taken file(s) still on disk.`,
    });
  }
}

export async function reconcilePending(
  root: string,
  journal: Journal,
  records: JournalRecord[],
): Promise<JournalRecord[]> {
  const latest = latestRecords(records);
  const pending = [...latest.values()].filter((record) => record.phase === "pending");

  let completedAction = false;
  for (const record of pending) {
    if (record.action === "fold") {
      completedAction = await reconcileFold(root, journal, record) || completedAction;
    } else if (record.action === "take") {
      completedAction = await reconcileTake(root, journal, record) || completedAction;
    } else if (record.kind === "fold") {
      await reconcileFoldUndo(root, journal, record);
    } else {
      await reconcileTakeUndo(root, journal, record, latest.get(record.undoes));
    }
  }
  if (completedAction) {
    await applyRetention(root, journal);
  }

  return readJournal(journal);
}
