import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { inspectRepository } from "../repo-state";
import { git, gitBuffer } from "../git";
import {
  appendJournal,
  applyRetention,
  newOperationId,
  openJournal,
  readJournal,
  withJournalLock,
  type TakeFile,
  type TakeRecord,
} from "../journal";
import { errorCode, sha256 } from "../files";
import { chooseMany, chooseOne, confirm, type Choice } from "../prompt";
import { reconcilePending } from "../recovery";

export interface TakeOptions {
  branch?: string | undefined;
  paths?: string[] | undefined;
  yes: boolean;
}

interface Candidate {
  path: string;
  mode: string;
  oid: string;
}

interface PlannedWrite {
  source: string;
  destination: string;
  mode: string;
  content: Buffer;
}

interface Plan {
  writes: PlannedWrite[];
  identical: Array<{ source: string; existing: string }>;
  createdDirs: string[];
}

const NON_INTERACTIVE_PICK =
  "Choosing interactively requires a terminal; pass a branch and paths: pit take <branch> -- <paths...>";

/** Inserts `.copy` (or `.copy-N` for N > 1) before the last extension of the file name. */
export function copyName(path: string, attempt = 1): string {
  const name = posix.basename(path);
  const dir = posix.dirname(path);
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot <= 0 ? [name, ""] : [name.slice(0, dot), name.slice(dot)];
  const copy = `${stem}${attempt === 1 ? ".copy" : `.copy-${attempt}`}${extension}`;
  return dir === "." ? copy : `${dir}/${copy}`;
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function isSparseCheckout(root: string): Promise<boolean> {
  const result = await git(["config", "--bool", "core.sparseCheckout"], { cwd: root, allowFailure: true });
  return result.stdout.trim() === "true";
}

async function pickBranch(root: string, currentBranch: string): Promise<string | null> {
  const { stdout } = await git(
    ["for-each-ref", "--format=%(refname)%00%(refname:short)", "refs/heads", "refs/remotes"],
    { cwd: root },
  );
  const branches: Choice[] = [];
  for (const line of stdout.split("\n")) {
    const [full, short] = line.split("\0");
    if (full === undefined || short === undefined || /^refs\/remotes\/[^/]+\/HEAD$/.test(full)) {
      continue;
    }
    if (full === `refs/heads/${currentBranch}`) {
      continue;
    }
    branches.push({ value: short, label: short });
  }
  if (branches.length === 0) {
    throw new Error("There are no other branches to take files from.");
  }
  return chooseOne("Take files from which branch?", branches, NON_INTERACTIVE_PICK);
}

async function listCandidates(
  root: string,
  sourceCommit: string,
): Promise<{ files: Candidate[]; unsupported: Candidate[] }> {
  const diff = (await git(
    ["diff", "--name-status", "-z", "--no-renames", sourceCommit],
    { cwd: root },
  )).stdout.split("\0");
  const changed = new Set<string>();
  for (let index = 0; index + 1 < diff.length; index += 2) {
    const status = diff[index];
    const path = diff[index + 1];
    if (path !== undefined && (status === "M" || status === "D" || status === "T")) {
      changed.add(path);
    }
  }

  const files: Candidate[] = [];
  const unsupported: Candidate[] = [];
  const tree = (await git(["ls-tree", "-r", "-z", sourceCommit], { cwd: root })).stdout.split("\0");
  for (const entry of tree) {
    const tab = entry.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const path = entry.slice(tab + 1);
    if (!changed.has(path)) {
      continue;
    }
    const [mode, , oid] = entry.slice(0, tab).split(" ");
    if (mode === undefined || oid === undefined) {
      continue;
    }
    (mode === "100644" || mode === "100755" ? files : unsupported).push({ path, mode, oid });
  }
  return { files, unsupported };
}

/** Resolves symlinks in the longest existing prefix so paths compare with Git's real top level. */
async function realpathExisting(path: string): Promise<string> {
  const missing: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...missing);
    } catch (error) {
      const parent = dirname(current);
      if (errorCode(error) !== "ENOENT" || parent === current) {
        throw error;
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

async function repoRelativePaths(root: string, cwd: string, paths: string[]): Promise<string[]> {
  const realRoot = await realpath(root);
  const realCwd = await realpath(cwd);
  const result: string[] = [];
  for (const path of paths) {
    const absolute = await realpathExisting(resolve(realCwd, path));
    const rel = relative(realRoot, absolute);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Path "${path}" is outside the repository.`);
    }
    result.push(rel.split(sep).join("/"));
  }
  return result;
}

function underPath(candidate: string, path: string): boolean {
  return path === "" || candidate === path || candidate.startsWith(`${path}/`);
}

async function chooseFiles(root: string, files: Candidate[]): Promise<Set<string> | null> {
  const directories = new Map<string, number>();
  const options: Choice[] = [];
  for (const file of files) {
    const missing = await lstatOrNull(join(root, file.path)) === null;
    options.push({ value: file.path, label: file.path, hint: missing ? "new" : "differs" });
    let dir = posix.dirname(file.path);
    while (dir !== ".") {
      directories.set(dir, (directories.get(dir) ?? 0) + 1);
      dir = posix.dirname(dir);
    }
  }
  for (const [dir, count] of directories) {
    options.push({ value: `${dir}/`, label: `${dir}/`, hint: `${count} file${count === 1 ? "" : "s"}` });
  }
  options.sort((left, right) => left.value.localeCompare(right.value));

  const selected = await chooseMany("Select files or folders to take", options, NON_INTERACTIVE_PICK);
  if (selected === null) {
    return null;
  }
  const paths = new Set<string>();
  for (const value of selected) {
    const prefix = value.endsWith("/") ? value.slice(0, -1) : value;
    for (const file of files) {
      if (underPath(file.path, prefix)) {
        paths.add(file.path);
      }
    }
  }
  return paths;
}

async function assertParentsWritable(root: string, path: string, missingDirs: Set<string>): Promise<void> {
  const parents: string[] = [];
  for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) {
    parents.unshift(dir);
  }
  for (const dir of parents) {
    const stats = await lstatOrNull(join(root, dir));
    if (stats === null) {
      missingDirs.add(dir);
    } else if (!stats.isDirectory()) {
      throw new Error(`Cannot write "${path}": "${dir}" exists locally and is not a directory.`);
    }
  }
}

async function sameContent(path: string, content: Buffer): Promise<boolean> {
  return content.equals(await readFile(path));
}

async function planWrites(root: string, files: Candidate[]): Promise<Plan> {
  const plan: Plan = { writes: [], identical: [], createdDirs: [] };
  const missingDirs = new Set<string>();
  const reserved = new Set<string>();
  const needsCopy: Array<{ file: Candidate; content: Buffer }> = [];

  for (const file of files) {
    const content = await gitBuffer(["cat-file", "--filters", `--path=${file.path}`, file.oid], { cwd: root });
    let stats;
    try {
      stats = await lstat(join(root, file.path));
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        await assertParentsWritable(root, file.path, missingDirs);
        plan.writes.push({ source: file.path, destination: file.path, mode: file.mode, content });
        reserved.add(file.path);
        continue;
      }
      if (errorCode(error) === "ENOTDIR") {
        await assertParentsWritable(root, file.path, missingDirs);
      }
      throw error;
    }
    if (stats.isFile() && await sameContent(join(root, file.path), content)) {
      plan.identical.push({ source: file.path, existing: file.path });
    } else {
      needsCopy.push({ file, content });
    }
  }

  for (const { file, content } of needsCopy) {
    for (let attempt = 1; ; attempt += 1) {
      const candidate = copyName(file.path, attempt);
      if (reserved.has(candidate)) {
        continue;
      }
      const stats = await lstatOrNull(join(root, candidate));
      if (stats === null) {
        plan.writes.push({ source: file.path, destination: candidate, mode: file.mode, content });
        reserved.add(candidate);
        break;
      }
      if (stats.isFile() && await sameContent(join(root, candidate), content)) {
        plan.identical.push({ source: file.path, existing: candidate });
        break;
      }
    }
  }

  plan.createdDirs = [...missingDirs].sort((left, right) =>
    left.split("/").length - right.split("/").length || left.localeCompare(right));
  return plan;
}

function section(title: string, lines: string[]): string {
  return lines.length === 0 ? "" : `${title}:\n${lines.map((line) => `  ${line}`).join("\n")}\n`;
}

export async function take(cwd: string, options: TakeOptions): Promise<void> {
  const initialState = await inspectRepository(cwd);
  const journal = await openJournal(initialState.root);

  await withJournalLock(journal, async () => {
    await reconcilePending(initialState.root, journal, await readJournal(journal));
    const state = await inspectRepository(initialState.root);
    const root = state.root;
    if (state.inProgress.length > 0) {
      throw new Error(`Cannot take during an in-progress ${state.inProgress.join(", ")} operation.`);
    }
    if (await isSparseCheckout(root)) {
      throw new Error("Cannot take while sparse checkout is enabled.");
    }

    const paths = options.paths ?? [];
    if (paths.length > 0 && options.branch === undefined) {
      throw new Error("Paths require a branch: pit take <branch> -- <paths...>");
    }
    const branch = options.branch ?? await pickBranch(root, state.branch);
    if (branch === null) {
      process.stdout.write("Cancelled; no files were written.\n");
      return;
    }
    const resolved = await git(
      ["rev-parse", "--verify", "--quiet", `${branch}^{commit}`],
      { cwd: root, allowFailure: true },
    );
    if (resolved.exitCode !== 0) {
      throw new Error(`Branch or commit "${branch}" was not found.`);
    }
    const sourceCommit = resolved.stdout.trim();

    const candidates = await listCandidates(root, sourceCommit);
    let selectedFiles: Candidate[];
    let selectedUnsupported: Candidate[];
    if (paths.length > 0) {
      const wanted = await repoRelativePaths(root, cwd, paths);
      for (const [index, path] of wanted.entries()) {
        const matches = [...candidates.files, ...candidates.unsupported]
          .some((candidate) => underPath(candidate.path, path));
        if (!matches) {
          throw new Error(`"${paths[index]}" does not match any file that differs in ${branch}.`);
        }
      }
      const matchesAny = (candidate: Candidate): boolean => wanted.some((path) => underPath(candidate.path, path));
      selectedFiles = candidates.files.filter(matchesAny);
      selectedUnsupported = candidates.unsupported.filter(matchesAny);
    } else {
      if (candidates.files.length === 0) {
        process.stdout.write(`No files in ${branch} differ from the working tree.\n`);
        return;
      }
      const chosen = await chooseFiles(root, candidates.files);
      if (chosen === null) {
        process.stdout.write("Cancelled; no files were written.\n");
        return;
      }
      selectedFiles = candidates.files.filter((file) => chosen.has(file.path));
      selectedUnsupported = [];
    }

    const plan = await planWrites(root, selectedFiles);
    const newFiles = plan.writes.filter((write) => write.destination === write.source);
    const copies = plan.writes.filter((write) => write.destination !== write.source);
    process.stdout.write(
      `Taking from ${branch} (${sourceCommit.slice(0, 12)})\n` +
      section("New files", newFiles.map((write) => write.destination)) +
      section("Copies (local file kept)", copies.map((write) => `${write.source} -> ${write.destination}`)) +
      section("Skipped, identical", plan.identical.map((entry) =>
        entry.existing === entry.source ? entry.source : `${entry.source} (same as ${entry.existing})`)) +
      section("Skipped, unsupported", selectedUnsupported.map((entry) =>
        `${entry.path} (${entry.mode === "120000" ? "symlink" : entry.mode === "160000" ? "submodule" : entry.mode})`)),
    );
    if (plan.writes.length === 0) {
      process.stdout.write("Nothing to take; no files would be written.\n");
      return;
    }
    if (!options.yes && !(await confirm(`Write ${plan.writes.length} file(s) to the working tree?`))) {
      process.stdout.write("Cancelled; no files were written.\n");
      return;
    }

    const files: TakeFile[] = plan.writes.map((write) => ({
      path: write.destination,
      sha256: sha256(write.content),
      mode: write.mode,
    }));
    const record: TakeRecord = {
      version: 1,
      id: newOperationId(),
      action: "take",
      phase: "pending",
      source: branch,
      sourceCommit,
      createdAt: new Date().toISOString(),
      files,
      createdDirs: plan.createdDirs,
    };
    await appendJournal(journal, record);

    const written: TakeFile[] = [];
    try {
      for (const dir of plan.createdDirs) {
        await mkdir(join(root, dir));
      }
      for (const [index, write] of plan.writes.entries()) {
        await writeFile(join(root, write.destination), write.content, {
          flag: "wx",
          mode: write.mode === "100755" ? 0o755 : 0o644,
        });
        written.push(files[index]!);
      }
    } catch (error) {
      if (written.length > 0) {
        await appendJournal(journal, { ...record, phase: "completed", files: written });
        await applyRetention(root, journal);
        throw new Error(
          `Wrote ${written.length} of ${files.length} file(s) before failing; ` +
          `run "pit undo" to remove them. ${(error as Error).message}`,
        );
      }
      await appendJournal(journal, { ...record, phase: "failed", detail: (error as Error).message });
      throw error;
    }

    await appendJournal(journal, { ...record, phase: "completed" });
    await applyRetention(root, journal);
    process.stdout.write(
      `Wrote ${written.length} file(s) from ${branch}; they are not staged. ` +
      `Run "pit undo" to remove them.\n`,
    );
  });
}
