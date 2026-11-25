import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "./git";

export interface RepositoryState {
  root: string;
  gitDir: string;
  branch: string;
  head: string | null;
  subject: string | null;
  inProgress: string[];
  hasStagedChanges: boolean;
  trackedChanges: string[];
  untrackedFiles: string[];
  remoteContainsHead: boolean;
}

export async function findRepositoryRoot(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
  if (result.exitCode !== 0) {
    throw new Error("Not inside a Git repository.");
  }
  return result.stdout.trim();
}

async function gitPath(root: string, name: string): Promise<string> {
  const result = await git(["rev-parse", "--git-path", name], { cwd: root });
  const path = result.stdout.trim();
  return resolve(root, path);
}

async function namesFromGit(root: string, args: string[]): Promise<string[]> {
  const { stdout } = await git(args, { cwd: root });
  return stdout.split("\0").filter((path) => path.length > 0);
}

export async function inspectRepository(cwd: string): Promise<RepositoryState> {
  const root = await findRepositoryRoot(cwd);
  const gitDir = (await git(["rev-parse", "--absolute-git-dir"], { cwd: root })).stdout.trim();
  const branch = (await git(["branch", "--show-current"], { cwd: root })).stdout.trim();
  const headResult = await git(
    ["rev-parse", "--verify", "--quiet", "HEAD"],
    { cwd: root, allowFailure: true },
  );
  if (headResult.exitCode !== 0 && headResult.exitCode !== 1) {
    throw new Error(`Could not determine HEAD: ${headResult.stderr.trim()}`);
  }
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
  const subject = head === null
    ? null
    : (await git(["log", "-1", "--format=%s", "HEAD"], { cwd: root })).stdout.trim();

  const markers: Array<[string, string]> = [
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["MERGE_HEAD", "merge"],
    ["CHERRY_PICK_HEAD", "cherry-pick"],
    ["REVERT_HEAD", "revert"],
    ["BISECT_LOG", "bisect"],
    ["sequencer", "sequencer operation"],
  ];
  const inProgress = new Set<string>();
  for (const [marker, label] of markers) {
    if (!existsSync(await gitPath(root, marker))) {
      continue;
    }
    if (marker === "rebase-apply") {
      const applying = existsSync(await gitPath(root, "rebase-apply/applying"));
      inProgress.add(applying ? "am" : "rebase");
    } else if (marker === "sequencer" && inProgress.size > 0) {
      continue;
    } else {
      inProgress.add(label);
    }
  }

  const staged = await git(["diff", "--cached", "--quiet"], { cwd: root, allowFailure: true });
  if (staged.exitCode !== 0 && staged.exitCode !== 1) {
    throw new Error(`Could not inspect staged changes: ${staged.stderr.trim()}`);
  }
  const trackedChanges = head === null
    ? []
    : await namesFromGit(root, ["diff", "HEAD", "--name-only", "-z"]);
  const untrackedFiles = await namesFromGit(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  let remoteContainsHead = false;
  if (head !== null) {
    const remoteBranches = await git(
      ["branch", "--remotes", "--contains", head],
      { cwd: root },
    );
    remoteContainsHead = remoteBranches.stdout.trim().length > 0;
  }

  return {
    root,
    gitDir,
    branch,
    head,
    subject,
    inProgress: [...inProgress],
    hasStagedChanges: staged.exitCode === 1,
    trackedChanges,
    untrackedFiles,
    remoteContainsHead,
  };
}

export async function currentBranchHead(root: string, branch: string): Promise<string | null> {
  const result = await git(
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    { cwd: root, allowFailure: true },
  );
  if (result.exitCode === 1) {
    return null;
  }
  if (result.exitCode !== 0) {
    throw new Error(`Could not determine branch tip: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}
