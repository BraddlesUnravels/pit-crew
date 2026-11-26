import { git } from "../git";
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
import { askText, chooseOne, confirm } from "../prompt";
import { reconcilePending } from "../recovery";
import { currentBranchHead, inspectRepository } from "../repo-state";

export interface FlatFoldOptions {
  base?: string | undefined;
  message?: string | undefined;
  yes: boolean;
}

interface Branch {
  full: string;
  short: string;
}

export async function baseBranches(root: string, current: string): Promise<Branch[]> {
  const { stdout } = await git(
    ["for-each-ref", "--format=%(refname)%00%(refname:short)", "refs/heads", "refs/remotes"],
    { cwd: root },
  );
  return stdout.split("\n").filter(Boolean).flatMap((line) => {
    const [full, short] = line.split("\0");
    if (!full || !short || full === `refs/heads/${current}` || /^refs\/remotes\/[^/]+\/HEAD$/.test(full)) {
      return [];
    }
    return [{ full, short }];
  });
}

export async function flatFold(cwd: string, options: FlatFoldOptions): Promise<void> {
  const initial = await inspectRepository(cwd);
  const journal = await openJournal(initial.root);
  await withJournalLock(journal, async () => {
    await reconcilePending(initial.root, journal, await readJournal(journal));
    const state = await inspectRepository(initial.root);
    if (!state.branch) throw new Error("Cannot fold while HEAD is detached.");
    if (!state.head) throw new Error("Cannot fold a repository with no commits.");
    if (state.inProgress.length > 0) {
      throw new Error(`Cannot fold during an in-progress ${state.inProgress.join(", ")} operation.`);
    }
    if ((await git(["rev-parse", "--is-shallow-repository"], { cwd: state.root })).stdout.trim() === "true") {
      throw new Error("Cannot flatten a shallow repository; fetch full history first.");
    }

    const branches = await baseBranches(state.root, state.branch);
    let selected = options.base;
    if (selected === undefined) {
      if (branches.length === 0) throw new Error("No other base branches are available.");
      const choice = await chooseOne(
        "Choose the base branch",
        branches.map((branch) => ({ value: branch.full, label: branch.short })),
        "Choosing a base requires a terminal; pass --base <branch>.",
      );
      if (choice === null) {
        process.stdout.write("Cancelled; no changes were made.\n");
        return;
      }
      selected = choice;
    }
    const candidates = branches.filter((branch) => branch.full === selected || branch.short === selected);
    if (candidates.length !== 1 || candidates[0] === undefined) {
      throw new Error(`Base "${selected}" is not a unique other local or remote-tracking branch.`);
    }
    const baseBranch = candidates[0];
    const baseTip = (await git(["rev-parse", "--verify", `${baseBranch.full}^{commit}`], { cwd: state.root })).stdout.trim();
    const common = await git(["merge-base", "--all", state.head, baseTip], {
      cwd: state.root,
      allowFailure: true,
    });
    if (common.exitCode === 1) throw new Error("The selected base and current branch have no common ancestor.");
    if (common.exitCode !== 0) throw new Error(`Could not find merge base: ${common.stderr.trim()}`);
    const bases = common.stdout.trim().split("\n").filter(Boolean);
    if (bases.length !== 1 || bases[0] === undefined) {
      throw new Error("Multiple merge bases found; cannot safely select a branch boundary.");
    }
    const base = bases[0];
    const commits = (await git(
      ["rev-list", "--topo-order", "--reverse", state.head, `^${base}`],
      { cwd: state.root },
    )).stdout.trim().split("\n").filter(Boolean);
    if (commits.length < 2) {
      throw new Error("There are fewer than two commits after the selected merge base; nothing to flatten.");
    }
    const commitList = (await git(
      ["log", "--topo-order", "--reverse", "--format=%h %s", state.head, `^${base}`],
      { cwd: state.root },
    )).stdout.trimEnd();
    let shared = false;
    for (const commit of commits) {
      const result = await git(["branch", "--remotes", "--contains", commit], { cwd: state.root });
      if (result.stdout.trim()) {
        shared = true;
        break;
      }
    }
    process.stdout.write(
      `Base: ${baseBranch.short} (merge base ${base.slice(0, 12)})\n` +
      `Commits to flatten (${commits.length}):\n${commitList}\n` +
      "The new commit will retain the current HEAD tree; staged and unstaged changes remain untouched.\n" +
      "Merge topology within this range will be flattened. Commit hooks will not run.\n" +
      (shared ? "Warning: commits to be flattened appear in known remote-tracking branches; this rewrites published history.\n" : ""),
    );
    const message = options.message === undefined
      ? await askText("New commit message", "A commit message requires a terminal; pass --message <message>.")
      : options.message.trim();
    if (message === null) {
      process.stdout.write("Cancelled; no changes were made.\n");
      return;
    }
    if (!message.trim()) throw new Error("A commit message is required.");
    if (!options.yes && !(await confirm("Flatten these commits now?"))) {
      process.stdout.write("Cancelled; no changes were made.\n");
      return;
    }

    const currentBranch = (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: state.root,
      allowFailure: true,
    })).stdout.trim();
    if (currentBranch !== state.branch || await currentBranchHead(state.root, state.branch) !== state.head) {
      throw new Error("The branch changed after preview; no changes were made.");
    }

    const id = newOperationId();
    const backupRef = `refs/pit/backups/${id}`;
    const record: FoldRecord = {
      version: 1,
      id,
      action: "fold",
      flat: true,
      phase: "pending",
      branch: state.branch,
      before: state.head,
      backupRef,
      createdAt: new Date().toISOString(),
    };
    await updateRef(state.root, backupRef, state.head);
    await appendJournal(journal, record);
    try {
      const sign = await git(["config", "--type=bool", "--get", "commit.gpgsign"], {
        cwd: state.root,
        allowFailure: true,
      });
      if (sign.exitCode !== 0 && sign.exitCode !== 1) {
        throw new Error(`Could not read commit signing configuration: ${sign.stderr.trim()}`);
      }
      const args = ["commit-tree", `${state.head}^{tree}`, "-p", base, "-m", message];
      if (sign.stdout.trim() === "true") args.push("-S");
      const result = (await git(args, { cwd: state.root })).stdout.trim();
      await git(
        ["update-ref", "-m", `pit fold ${id}`, `refs/heads/${state.branch}`, result, state.head],
        { cwd: state.root },
      );
      await appendJournal(journal, { ...record, phase: "completed", result });
      await applyRetention(state.root, journal);
      process.stdout.write(`Flattened ${commits.length} commits into ${result.slice(0, 12)}. Run "pit undo" to reverse.\n`);
    } catch (error) {
      await reconcilePending(state.root, journal, await readJournal(journal));
      throw error;
    }
  });
}
