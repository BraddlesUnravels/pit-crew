import { rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { inspectRepository, currentBranchHead, type RepositoryState } from "../repo-state";
import { git } from "../git";
import {
  appendJournal,
  latestRecords,
  newOperationId,
  openJournal,
  readJournal,
  undoableActions,
  undoneIds,
  updateRef,
  withJournalLock,
  type FoldRecord,
  type FoldUndoRecord,
  type Journal,
  type TakeRecord,
  type TakeUndoRecord,
  type UndoableRecord,
} from "../journal";
import { errorCode, regularFileSha256 } from "../files";
import { confirm } from "../prompt";
import { reconcilePending } from "../recovery";

export interface UndoOptions {
  count?: number;
  force: boolean;
  list: boolean;
  yes: boolean;
}

function describe(record: UndoableRecord): string {
  if (record.action === "fold") {
    return `fold on ${record.branch}: ${record.before.slice(0, 12)} -> ` +
      `${record.result?.slice(0, 12) ?? "pending"}`;
  }
  return `take ${record.files.length} file(s) from ${record.source} (${record.sourceCommit.slice(0, 12)})`;
}

function showList(actions: UndoableRecord[], undone: Set<string>): void {
  if (actions.length === 0) {
    process.stdout.write("No pit actions recorded.\n");
    return;
  }
  const sorted = [...actions].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20);
  for (const record of sorted) {
    const status = undone.has(record.id)
      ? "undone"
      : record.phase === "completed" ? "undoable" : record.phase;
    process.stdout.write(
      `${record.createdAt}  ${record.action.padEnd(4)}  ${status.padEnd(9)} ${describe(record)}  ${record.id}\n`,
    );
  }
}

/** Returns false when the user cancelled. */
async function undoFold(
  state: RepositoryState,
  journal: Journal,
  foldRecord: FoldRecord,
  options: UndoOptions,
): Promise<boolean> {
  if (state.branch.length === 0) {
    throw new Error("Cannot undo while HEAD is detached.");
  }
  if (foldRecord.result === undefined) {
    throw new Error("There is no completed pit fold to undo.");
  }
  if (state.branch !== foldRecord.branch) {
    throw new Error(`This fold was made on branch "${foldRecord.branch}"; switch to that branch to undo it.`);
  }

  const branchHead = await currentBranchHead(state.root, state.branch);
  if (branchHead === null) {
    throw new Error("The current branch has no commit.");
  }
  const branchMoved = branchHead !== foldRecord.result;
  if (branchMoved && !options.force) {
    throw new Error(
      `Branch "${state.branch}" moved since this fold. Refusing to move it; ` +
      `inspect the new commits or use --force to restore the prior commit.`,
    );
  }

  if (branchMoved) {
    process.stdout.write(
      `Warning: --force will move ${state.branch} from ${branchHead.slice(0, 12)} ` +
      `back to ${foldRecord.before.slice(0, 12)}. The current tip will be kept in a backup ref.\n`,
    );
    if (!options.yes && !(await confirm("Continue with forced undo?"))) {
      return false;
    }
  }

  const id = newOperationId();
  const backupRef = `refs/pit/backups/${id}`;
  const undoRecord: FoldUndoRecord = {
    version: 1,
    id,
    action: "undo",
    phase: "pending",
    kind: "fold",
    undoes: foldRecord.id,
    branch: state.branch,
    before: branchHead,
    target: foldRecord.before,
    backupRef,
    createdAt: new Date().toISOString(),
  };
  await updateRef(state.root, backupRef, branchHead);
  await appendJournal(journal, undoRecord);

  try {
    await git(["reset", "--soft", foldRecord.before], {
      cwd: state.root,
      env: { GIT_REFLOG_ACTION: `pit undo ${id}` },
    });
  } catch (error) {
    await reconcilePending(state.root, journal, await readJournal(journal));
    throw error;
  }

  const result = await currentBranchHead(state.root, state.branch);
  if (result !== foldRecord.before) {
    throw new Error(
      `Git returned successfully but the branch did not reach ${foldRecord.before}. ` +
      `The pending undo is recorded as ${id}; inspect the repository before retrying.`,
    );
  }
  await appendJournal(journal, { ...undoRecord, phase: "completed" });
  process.stdout.write(
    foldRecord.flat
      ? `Restored ${foldRecord.before.slice(0, 12)}; the index and working tree are unchanged.\n`
      : `Restored ${foldRecord.before.slice(0, 12)}; folded changes are staged again.\n`,
  );
  return true;
}

async function unstageTakenFile(root: string, path: string, blob: string): Promise<void> {
  const inHead = await git(
    ["rev-parse", "--verify", "--quiet", `HEAD:${path}`],
    { cwd: root, allowFailure: true },
  );
  if (inHead.exitCode === 0) {
    return;
  }
  const staged = await git(["--literal-pathspecs", "ls-files", "-s", "-z", "--", path], { cwd: root });
  const entry = staged.stdout.split("\0").find((line) => line.endsWith(`\t${path}`));
  const indexBlob = entry?.split(" ")[1];
  if (indexBlob === blob) {
    await git(["--literal-pathspecs", "rm", "--cached", "--quiet", "--", path], { cwd: root });
  }
}

/** Returns false when the user cancelled. */
async function undoTake(
  state: RepositoryState,
  journal: Journal,
  takeRecord: TakeRecord,
  options: UndoOptions,
): Promise<boolean> {
  const matching: Array<{ path: string; blob: string }> = [];
  const edited: string[] = [];
  for (const file of takeRecord.files) {
    const absolute = join(state.root, file.path);
    const sha = await regularFileSha256(absolute);
    if (sha === file.sha256) {
      const blob = (await git(["hash-object", "--", file.path], { cwd: state.root })).stdout.trim();
      matching.push({ path: file.path, blob });
    } else if (sha !== null) {
      edited.push(file.path);
    }
  }

  if (edited.length > 0) {
    const list = edited.map((path) => `  ${path}`).join("\n");
    if (!options.force) {
      throw new Error(
        `Files from this take were edited since:\n${list}\n` +
        `Refusing to undo; use --force to back them up and delete them.`,
      );
    }
    process.stdout.write(
      `Warning: --force will delete these edited files after saving their content in backup refs:\n${list}\n`,
    );
    if (!options.yes && !(await confirm("Continue with forced undo?"))) {
      return false;
    }
  }

  const id = newOperationId();
  const backupRefs: string[] = [];
  for (const [index, path] of edited.entries()) {
    const blob = (await git(["hash-object", "-w", "--no-filters", "--", path], { cwd: state.root }))
      .stdout.trim();
    const ref = `refs/pit/backups/${id}/${index + 1}`;
    await updateRef(state.root, ref, blob);
    backupRefs.push(ref);
  }

  const undoRecord: TakeUndoRecord = {
    version: 1,
    id,
    action: "undo",
    phase: "pending",
    kind: "take",
    undoes: takeRecord.id,
    removed: [...matching.map((file) => file.path), ...edited],
    backupRefs,
    createdAt: new Date().toISOString(),
  };
  await appendJournal(journal, undoRecord);

  for (const path of undoRecord.removed) {
    try {
      await unlink(join(state.root, path));
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  for (const file of matching) {
    await unstageTakenFile(state.root, file.path, file.blob);
  }
  const dirs = [...takeRecord.createdDirs]
    .sort((left, right) => right.split("/").length - left.split("/").length || right.localeCompare(left));
  for (const dir of dirs) {
    try {
      await rmdir(join(state.root, dir));
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
        throw error;
      }
    }
  }

  await appendJournal(journal, { ...undoRecord, phase: "completed" });
  process.stdout.write(
    `Removed ${undoRecord.removed.length} file(s) taken from ${takeRecord.source}.` +
    (backupRefs.length > 0 ? ` Edited content is saved under refs/pit/backups/${id}/.` : "") +
    "\n",
  );
  return true;
}

export async function undo(cwd: string, options: UndoOptions): Promise<void> {
  const stateAtStart = await inspectRepository(cwd);
  const journal = await openJournal(stateAtStart.root);
  if (options.list) {
    const records = await readJournal(journal);
    const actions = [...latestRecords(records).values()]
      .filter((record): record is UndoableRecord => record.action !== "undo");
    showList(actions, undoneIds(records));
    return;
  }

  const count = options.count ?? 1;
  await withJournalLock(journal, async () => {
    await reconcilePending(stateAtStart.root, journal, await readJournal(journal));
    const initialState = await inspectRepository(stateAtStart.root);
    if (initialState.inProgress.length > 0) {
      throw new Error(`Cannot undo during an in-progress ${initialState.inProgress.join(", ")} operation.`);
    }

    const targets = undoableActions(await readJournal(journal)).slice(0, count);
    if (targets.length === 0) {
      throw new Error("There is no pit action left to undo.");
    }
    if (targets.length < count) {
      throw new Error(`Only ${targets.length} action(s) can be undone.`);
    }

    let succeeded = 0;
    for (const target of targets) {
      try {
        const state = await inspectRepository(stateAtStart.root);
        if (state.inProgress.length > 0) {
          throw new Error(`Cannot undo during an in-progress ${state.inProgress.join(", ")} operation.`);
        }
        if (undoableActions(await readJournal(journal))[0]?.id !== target.id) {
          throw new Error("The pit action history changed; stopping.");
        }
        const done = target.action === "fold"
          ? await undoFold(state, journal, target, options)
          : await undoTake(state, journal, target, options);
        if (!done) {
          process.stdout.write(
            count > 1
              ? `Cancelled; undid ${succeeded} of ${count} action(s).\n`
              : "Cancelled; no changes were made.\n",
          );
          return;
        }
        succeeded += 1;
      } catch (error) {
        if (count > 1) {
          throw new Error(`${(error as Error).message}\nUndid ${succeeded} of ${count} action(s) before stopping.`);
        }
        throw error;
      }
    }
    if (count > 1) {
      process.stdout.write(`Undid ${succeeded} action(s).\n`);
    }
  });
}
