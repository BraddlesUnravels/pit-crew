import { inspectRepository, currentBranchHead } from "../repo-state";
import { git, gitInteractive } from "../git";
import {
  appendJournal,
  applyRetention,
  newOperationId,
  openJournal,
  readJournal,
  updateRef,
  withJournalLock,
  type FoldRecord,
} from "../journal";
import { confirm } from "../prompt";
import { reconcilePending } from "../recovery";

export interface FoldOptions {
  all: boolean;
  edit: boolean;
  noVerify: boolean;
  yes: boolean;
}

function assertFoldable(state: Awaited<ReturnType<typeof inspectRepository>>): asserts state is
  Awaited<ReturnType<typeof inspectRepository>> & { head: string; subject: string } {
  if (state.branch.length === 0) {
    throw new Error("Cannot fold while HEAD is detached.");
  }
  if (state.head === null || state.subject === null) {
    throw new Error("Cannot fold a repository with no commits.");
  }
  if (state.inProgress.length > 0) {
    throw new Error(`Cannot fold during an in-progress ${state.inProgress.join(", ")} operation.`);
  }
}

function formatFiles(files: string[]): string {
  return files.length === 0 ? "  (none)" : files.map((file) => `  ${file}`).join("\n");
}

async function addUntracked(root: string, files: string[]): Promise<void> {
  for (let offset = 0; offset < files.length; offset += 400) {
    const batch = files.slice(offset, offset + 400);
    await git(["--literal-pathspecs", "add", "--", ...batch], { cwd: root });
  }
}

export async function fold(cwd: string, options: FoldOptions): Promise<void> {
  const initialState = await inspectRepository(cwd);
  const journal = await openJournal(initialState.root);

  await withJournalLock(journal, async () => {
    const records = await readJournal(journal);
    await reconcilePending(initialState.root, journal, records);
    const state = await inspectRepository(initialState.root);
    assertFoldable(state);

    const trackedFiles = state.hasStagedChanges
      ? (await git(["diff", "--cached", "--name-only", "-z"], { cwd: state.root }))
        .stdout.split("\0").filter(Boolean)
      : state.trackedChanges;
    const untrackedFiles = options.all ? state.untrackedFiles : [];
    if (trackedFiles.length === 0 && untrackedFiles.length === 0) {
      throw new Error("Nothing to fold. Stage changes, edit tracked files, or use -a for new files.");
    }

    const summaryArgs = state.hasStagedChanges
      ? ["diff", "--cached", "--stat"]
      : ["diff", "HEAD", "--stat"];
    const summary = (await git(summaryArgs, { cwd: state.root })).stdout.trim();
    const remoteWarning = state.remoteContainsHead
      ? "\nWarning: the target commit appears in a known remote-tracking branch."
      : "";
    const preview =
      `Target: ${state.head.slice(0, 12)} ${state.subject}\n` +
      `Tracked changes to fold:\n${formatFiles(trackedFiles)}\n` +
      (untrackedFiles.length > 0
        ? `New files to add:\n${formatFiles(untrackedFiles)}\n`
        : "") +
      (summary.length > 0 ? `\n${summary}\n` : "") +
      remoteWarning +
      "\nReview the changes above.";
    process.stdout.write(`${preview}\n`);

    if (!options.yes && !(await confirm("Fold these changes now?"))) {
      process.stdout.write("Cancelled; no changes were staged or committed.\n");
      return;
    }

    const before = await currentBranchHead(state.root, state.branch);
    if (before !== state.head) {
      throw new Error("The branch moved after preview; no changes were folded. Run the command again.");
    }

    const id = newOperationId();
    const backupRef = `refs/pit/backups/${id}`;
    const record: FoldRecord = {
      version: 1,
      id,
      action: "fold",
      phase: "pending",
      branch: state.branch,
      before: state.head,
      backupRef,
      createdAt: new Date().toISOString(),
    };
    await updateRef(state.root, backupRef, state.head);
    await appendJournal(journal, record);

    try {
      if (!state.hasStagedChanges) {
        await git(["add", "-u"], { cwd: state.root });
      }
      if (untrackedFiles.length > 0) {
        await addUntracked(state.root, untrackedFiles);
      }

      const currentHead = await currentBranchHead(state.root, state.branch);
      if (currentHead !== state.head) {
        throw new Error("The branch moved before the commit could be amended; no commit was made.");
      }

      const commitArgs = ["commit", "--amend", options.edit ? "--edit" : "--no-edit"];
      if (options.noVerify) {
        commitArgs.push("--no-verify");
      }
      await gitInteractive(commitArgs, {
        cwd: state.root,
        env: { GIT_REFLOG_ACTION: `pit fold ${id}` },
      });
    } catch (error) {
      const updatedRecords = await readJournal(journal);
      await reconcilePending(state.root, journal, updatedRecords);
      const reconciled = await readJournal(journal);
      const operation = reconciled
        .filter((entry) => entry.id === id)
        .at(-1);
      if (operation?.phase === "completed") {
        throw new Error(
          `Git reported an error after the commit was amended. Fold is recorded; ` +
          `run "pit undo" to reverse it. ${(error as Error).message}`,
        );
      }
      if (operation?.phase !== "failed") {
        await appendJournal(journal, {
          ...record,
          phase: "failed",
          detail: (error as Error).message,
        });
      }
      throw error;
    }

    const result = await currentBranchHead(state.root, state.branch);
    if (result === null || result === state.head) {
      throw new Error(
        `Git returned successfully but the branch did not move. ` +
        `The pending operation is recorded as ${id}; inspect the repository before retrying.`,
      );
    }
    await appendJournal(journal, { ...record, phase: "completed", result });
    await applyRetention(state.root, journal);
    process.stdout.write(
      `Folded into ${result.slice(0, 12)}. Run "pit undo" to reverse this fold.\n`,
    );
  });
}
