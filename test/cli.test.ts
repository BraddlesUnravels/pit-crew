import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { FILE_MODE_EXECUTABLE } from "../src/files";
import { main } from "../src/cli";
import { fold } from "../src/commands/fold";
import { flatFold } from "../src/commands/flat-fold";
import { copyName, take } from "../src/commands/take";
import { undo } from "../src/commands/undo";
import { appendJournal, openJournal, readJournal, type FoldRecord } from "../src/journal";
import { reconcilePending } from "../src/recovery";
import { inspectRepository } from "../src/repo-state";
import { completeBaseBranches, zshCompletion } from "../src/completion";

const execFileAsync = promisify(execFile);
let repo: string;

async function gitAt(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function git(args: string[]): Promise<string> {
  return gitAt(repo, args);
}

async function setupRepo(): Promise<void> {
  repo = await mkdtemp(join(tmpdir(), "pit-test-"));
  await git(["init", "-b", "main"]);
  await git(["config", "user.name", "Pit Tests"]);
  await git(["config", "user.email", "pit-tests@example.invalid"]);
  await writeFile(join(repo, "tracked.txt"), "base\n");
  await git(["add", "tracked.txt"]);
  await git(["commit", "-m", "initial commit"]);
}

async function head(): Promise<string> {
  return git(["rev-parse", "HEAD"]);
}

async function journalEntries(): Promise<Array<Record<string, unknown>>> {
  const path = resolve(repo, await git(["rev-parse", "--git-path", "pit/journal.jsonl"]));
  const contents = await readFile(path, "utf8");
  return contents.trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function branchWith(name: string, files: Record<string, string>): Promise<void> {
  await git(["checkout", "-q", "-b", name]);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await git(["add", "-A"]);
  await git(["commit", "-q", "-m", `${name} commit`]);
  await git(["checkout", "-q", "main"]);
}

async function read(path: string): Promise<string> {
  return readFile(join(repo, path), "utf8");
}

beforeEach(async () => setupRepo());
afterEach(async () => rm(repo, { recursive: true, force: true }));

describe("pit fold", () => {
  it("amends staged changes and leaves later unstaged edits alone", async () => {
    const before = await head();
    await writeFile(join(repo, "tracked.txt"), "staged\n");
    await git(["add", "tracked.txt"]);
    await writeFile(join(repo, "tracked.txt"), "unstaged\n");

    await fold(repo, { all: false, edit: false, noVerify: false, yes: true });

    expect(await head()).not.toBe(before);
    expect(await git(["show", "HEAD:tracked.txt"])).toBe("staged");
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("unstaged\n");
    expect(await git(["log", "-1", "--format=%s"])).toBe("initial commit");
  });

  it("folds tracked edits by default and leaves new files untracked", async () => {
    await writeFile(join(repo, "tracked.txt"), "tracked edit\n");
    await writeFile(join(repo, "new.txt"), "new file\n");

    await fold(repo, { all: false, edit: false, noVerify: false, yes: true });

    expect(await git(["show", "HEAD:tracked.txt"])).toBe("tracked edit");
    await expect(git(["show", "HEAD:new.txt"])).rejects.toThrow();
    expect(await git(["status", "--short"])).toContain("?? new.txt");
  });

  it("includes new files with -a", async () => {
    await writeFile(join(repo, "tracked.txt"), "tracked edit\n");
    await writeFile(join(repo, "new.txt"), "new file\n");

    await fold(repo, { all: true, edit: false, noVerify: false, yes: true });

    expect(await git(["show", "HEAD:new.txt"])).toBe("new file");
  });

  it("adds untracked files with -a while leaving unstaged tracked edits alone if changes are staged", async () => {
    await writeFile(join(repo, "tracked.txt"), "staged\n");
    await git(["add", "tracked.txt"]);
    await writeFile(join(repo, "tracked.txt"), "still unstaged\n");
    await writeFile(join(repo, "new.txt"), "new file\n");

    await fold(repo, { all: true, edit: false, noVerify: false, yes: true });

    expect(await git(["show", "HEAD:tracked.txt"])).toBe("staged");
    expect(await git(["show", "HEAD:new.txt"])).toBe("new file");
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("still unstaged\n");
  });

  it("does not alter the branch when there is nothing to fold", async () => {
    const before = await head();
    await expect(
      fold(repo, { all: false, edit: false, noVerify: false, yes: true }),
    ).rejects.toThrow("Nothing to fold");
    expect(await head()).toBe(before);
  });

  it("refuses a detached HEAD", async () => {
    await git(["checkout", "--detach"]);
    await writeFile(join(repo, "tracked.txt"), "edit\n");
    const before = await head();
    await expect(
      fold(repo, { all: false, edit: false, noVerify: false, yes: true }),
    ).rejects.toThrow("detached");
    expect(await head()).toBe(before);
  });

  it("refuses a repository with no commits", async () => {
    const emptyRepo = await mkdtemp(join(tmpdir(), "pit-empty-"));
    try {
      await gitAt(emptyRepo, ["init", "-b", "main"]);
      await writeFile(join(emptyRepo, "tracked.txt"), "edit\n");
      await expect(
        fold(emptyRepo, { all: false, edit: false, noVerify: false, yes: true }),
      ).rejects.toThrow("no commits");
      expect(await gitAt(emptyRepo, ["status", "--short"])).toContain("?? tracked.txt");
    } finally {
      await rm(emptyRepo, { recursive: true, force: true });
    }
  });

  it("refuses to run during an in-progress operation", async () => {
    await mkdir(join(repo, ".git", "rebase-merge"));
    await writeFile(join(repo, "tracked.txt"), "edit\n");
    const before = await head();
    await expect(
      fold(repo, { all: false, edit: false, noVerify: false, yes: true }),
    ).rejects.toThrow("in-progress rebase");
    expect(await head()).toBe(before);
  });

  it("detects a target commit in a known remote-tracking branch", async () => {
    const remote = await mkdtemp(join(tmpdir(), "pit-remote-"));
    try {
      await gitAt(remote, ["init", "--bare"]);
      await git(["remote", "add", "origin", remote]);
      await git(["push", "--set-upstream", "origin", "main"]);

      expect((await inspectRepository(repo)).remoteContainsHead).toBe(true);
    } finally {
      await rm(remote, { recursive: true, force: true });
    }
  });

  it("records a failed hook without moving HEAD or losing file content", async () => {
    const before = await head();
    const hooks = join(repo, ".githooks");
    await mkdir(hooks);
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
    await chmod(join(hooks, "pre-commit"), FILE_MODE_EXECUTABLE);
    await git(["config", "core.hooksPath", ".githooks"]);
    await writeFile(join(repo, "tracked.txt"), "edit to preserve\n");

    await expect(
      fold(repo, { all: false, edit: false, noVerify: false, yes: true }),
    ).rejects.toThrow("exited with status");

    expect(await head()).toBe(before);
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("edit to preserve\n");
    const entries = await journalEntries();
    expect(entries.at(-1)).toMatchObject({ action: "fold", phase: "failed" });
  });

  it("recovers a pending fold from its reflog entry", async () => {
    await writeFile(join(repo, "tracked.txt"), "folded work\n");
    await fold(repo, { all: false, edit: false, noVerify: false, yes: true });
    const journal = await openJournal(repo);
    const completed = (await readJournal(journal)).at(-1) as FoldRecord;
    await appendJournal(journal, { ...completed, phase: "pending" });

    const recovered = await reconcilePending(repo, journal, await readJournal(journal));

    expect(recovered.at(-1)).toMatchObject({
      action: "fold",
      id: completed.id,
      phase: "completed",
      result: await head(),
    });
  });
});

describe("pit fold -flat", () => {
  async function featureCommits(): Promise<{ base: string; before: string }> {
    const base = await head();
    await git(["checkout", "-b", "feature"]);
    await writeFile(join(repo, "tracked.txt"), "first\n");
    await git(["add", "tracked.txt"]);
    await git(["commit", "-m", "first feature commit"]);
    await writeFile(join(repo, "tracked.txt"), "second\n");
    await git(["add", "tracked.txt"]);
    await git(["commit", "-m", "second feature commit"]);
    return { base, before: await head() };
  }

  it("previews and flattens commits while preserving the index and worktree, then undoes", async () => {
    const { base, before } = await featureCommits();
    const tree = await git(["rev-parse", "HEAD^{tree}"]);
    await writeFile(join(repo, "tracked.txt"), "staged\n");
    await git(["add", "tracked.txt"]);
    await writeFile(join(repo, "tracked.txt"), "unstaged\n");
    await writeFile(join(repo, "untracked.txt"), "untracked\n");
    const cached = await git(["diff", "--cached"]);
    const unstaged = await git(["diff"]);
    const output = vi.spyOn(process.stdout, "write");
    try {
      await flatFold(repo, { base: "main", message: "flattened", yes: true });
      const printed = output.mock.calls.map(([text]) => String(text)).join("");
      expect(printed).toContain("first feature commit");
      expect(printed).toContain("second feature commit");
      expect(printed).toContain("Commit hooks will not run");
    } finally {
      output.mockRestore();
    }

    expect(await git(["rev-parse", "HEAD^"])).toBe(base);
    expect(await git(["rev-parse", "HEAD^{tree}"])).toBe(tree);
    expect(await git(["log", "-1", "--format=%s"])).toBe("flattened");
    expect(await git(["diff", "--cached"])).toBe(cached);
    expect(await git(["diff"])).toBe(unstaged);
    expect(await read("untracked.txt")).toBe("untracked\n");

    await undo(repo, { force: false, list: false, yes: true });
    expect(await head()).toBe(before);
    expect(await git(["diff", "--cached"])).toBe(cached);
    expect(await git(["diff"])).toBe(unstaged);
    expect(await read("untracked.txt")).toBe("untracked\n");
  });

  it("warns when an older commit is on a remote-tracking branch", async () => {
    await featureCommits();
    const first = await git(["rev-parse", "HEAD^"]);
    await git(["update-ref", "refs/remotes/origin/feature", first]);
    const output = vi.spyOn(process.stdout, "write");
    try {
      await flatFold(repo, { base: "main", message: "flattened", yes: true });
      expect(output.mock.calls.map(([text]) => String(text)).join("")).toContain("rewrites published history");
    } finally {
      output.mockRestore();
    }
  });

  it("reconciles an interrupted flat fold using its reflog and backup", async () => {
    const { before } = await featureCommits();
    await flatFold(repo, { base: "main", message: "flattened", yes: true });
    const result = await head();
    const journal = await openJournal(repo);
    const completed = (await readJournal(journal)).at(-1) as FoldRecord;
    await appendJournal(journal, { ...completed, phase: "pending" });
    await reconcilePending(repo, journal, await readJournal(journal));
    expect((await readJournal(journal)).at(-1)).toMatchObject({
      action: "fold", flat: true, phase: "completed", before, result,
    });
    await undo(repo, { force: false, list: false, yes: true });
    expect(await head()).toBe(before);
  });

  it("does not run commit hooks during a flat fold", async () => {
    await featureCommits();
    const hooks = join(repo, ".githooks");
    await mkdir(hooks);
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
    await chmod(join(hooks, "pre-commit"), FILE_MODE_EXECUTABLE);
    await git(["config", "core.hooksPath", ".githooks"]);
    await flatFold(repo, { base: "main", message: "flattened", yes: true });
    expect(await git(["log", "-1", "--format=%s"])).toBe("flattened");
  });

  it("refuses fewer than two branch commits or an invalid base without changing HEAD", async () => {
    await git(["checkout", "-b", "feature"]);
    await writeFile(join(repo, "tracked.txt"), "one\n");
    await git(["add", "tracked.txt"]);
    await git(["commit", "-m", "one"]);
    const before = await head();
    await expect(flatFold(repo, { base: "main", message: "flattened", yes: true }))
      .rejects.toThrow("fewer than two");
    await expect(flatFold(repo, { base: "missing", message: "flattened", yes: true }))
      .rejects.toThrow("not a unique");
    expect(await head()).toBe(before);
  });

  it("rejects incompatible normal-fold options for -flat", async () => {
    await expect(main(["fold", "-flat", "-a"])).rejects.toThrow();
    await expect(main(["fold", "--flat", "--edit"])).rejects.toThrow();
  });
});

describe("zsh base completion", () => {
  it("suggests the same other local and remote branches as the flat-fold picker", async () => {
    await git(["branch", "feature"]);
    await git(["update-ref", "refs/remotes/origin/main", await head()]);
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const subdir = join(repo, "nested");
    await mkdir(subdir);

    expect(await completeBaseBranches(subdir)).toEqual(["feature", "origin/main"]);
  });

  it("registers zsh completion for both --base forms without completing other arguments", () => {
    const result = spawnSync("zsh", ["-f"], {
      input: `
compdef() { : }
pit() { printf '%s\\n' main origin/main; }
compadd() { printf 'completion:%s\\n' "$@"; }
compset() { printf 'prefix:%s\\n' "$@"; }
${zshCompletion}
words=(pit fold -flat --base ma)
CURRENT=5
_pit
words=(pit fold -flat --base=ma)
CURRENT=4
_pit
words=(pit take --base ma)
CURRENT=4
_pit || print 'other command ignored'
`,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.match(/completion:branches/g)).toHaveLength(2);
    expect(result.stdout).toContain("prefix:--base=");
    expect(result.stdout).toContain("other command ignored");
  });
});

describe("pit undo", () => {
  it("restores the original commit and leaves folded changes staged", async () => {
    const before = await head();
    await writeFile(join(repo, "tracked.txt"), "folded work\n");
    await fold(repo, { all: false, edit: false, noVerify: false, yes: true });
    const folded = await head();

    await undo(repo, { force: false, list: false, yes: true });

    expect(await head()).toBe(before);
    expect(await git(["diff", "--cached", "--name-only"])).toBe("tracked.txt");
    expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("folded work\n");
    expect(await git(["cat-file", "-e", `${folded}^{commit}`])).toBe("");
  });

  it("refuses a moved branch unless forced, and preserves the moved tip", async () => {
    const original = await head();
    await writeFile(join(repo, "tracked.txt"), "folded work\n");
    await fold(repo, { all: false, edit: false, noVerify: false, yes: true });
    await writeFile(join(repo, "later.txt"), "later commit\n");
    await git(["add", "later.txt"]);
    await git(["commit", "-m", "later commit"]);
    const movedTip = await head();

    await expect(undo(repo, { force: false, list: false, yes: true }))
      .rejects.toThrow("moved since this fold");
    expect(await head()).toBe(movedTip);

    await undo(repo, { force: true, list: false, yes: true });

    expect(await head()).toBe(original);
    const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/pit/backups"]))
      .split("\n");
    const backupRefs = refs.filter((ref) => ref.length > 0);
    const hasMovedTipBackup = await Promise.all(
      backupRefs.map(async (ref) => (await git(["rev-parse", ref])) === movedTip),
    );
    expect(hasMovedTipBackup).toContain(true);
    expect(await readFile(join(repo, "later.txt"), "utf8")).toBe("later commit\n");
  });

  it("refuses to undo during an in-progress operation", async () => {
    await writeFile(join(repo, "tracked.txt"), "folded work\n");
    await fold(repo, { all: false, edit: false, noVerify: false, yes: true });
    await mkdir(join(repo, ".git", "rebase-merge"));

    await expect(undo(repo, { force: false, list: false, yes: true }))
      .rejects.toThrow("in-progress rebase");
  });
});

describe("pit take", () => {
  it("writes a new nested file to disk without staging it", async () => {
    await branchWith("feature", { "src/deep/new.ts": "export {};\n" });

    await take(repo, { branch: "feature", paths: ["src"], yes: true });

    expect(await read("src/deep/new.ts")).toBe("export {};\n");
    expect(await git(["status", "--porcelain"])).toBe("?? src/");
    expect(await git(["diff", "--cached", "--name-only"])).toBe("");
  });

  it("writes differing same-name files as numbered .copy variants and keeps the original", async () => {
    await writeFile(join(repo, "button.tsx"), "main\n");
    await writeFile(join(repo, "card.tsx"), "main\n");
    await git(["add", "."]);
    await git(["commit", "-q", "-m", "components"]);
    await branchWith("feature", { "button.tsx": "feature\n", "card.tsx": "feature card\n" });
    await writeFile(join(repo, "card.copy.tsx"), "unrelated\n");

    await take(repo, { branch: "feature", paths: ["button.tsx", "card.tsx"], yes: true });

    expect(await read("button.tsx")).toBe("main\n");
    expect(await read("button.copy.tsx")).toBe("feature\n");
    expect(await read("card.copy.tsx")).toBe("unrelated\n");
    expect(await read("card.copy-2.tsx")).toBe("feature card\n");
  });

  it("skips byte-identical files", async () => {
    await branchWith("feature", { "same.txt": "same\n" });
    await writeFile(join(repo, "same.txt"), "same\n");

    await take(repo, { branch: "feature", paths: ["same.txt"], yes: true });

    expect(existsSync(join(repo, "same.copy.txt"))).toBe(false);
    expect(await git(["status", "--porcelain"])).toBe("?? same.txt");
  });

  it("preserves local-only files when taking a directory", async () => {
    await branchWith("feature", { "dir/a.txt": "a\n", "dir/b.txt": "b\n" });
    await mkdir(join(repo, "dir"));
    await writeFile(join(repo, "dir/local.txt"), "local\n");

    await take(repo, { branch: "feature", paths: ["dir"], yes: true });

    expect(await read("dir/a.txt")).toBe("a\n");
    expect(await read("dir/b.txt")).toBe("b\n");
    expect(await read("dir/local.txt")).toBe("local\n");
  });

  it("names copies before the last extension", () => {
    expect(copyName("Makefile")).toBe("Makefile.copy");
    expect(copyName(".env")).toBe(".env.copy");
    expect(copyName("src/foo.test.ts")).toBe("src/foo.test.copy.ts");
    expect(copyName(".eslintrc.json")).toBe(".eslintrc.copy.json");
    expect(copyName("foo.ts", 2)).toBe("foo.copy-2.ts");
    expect(copyName("Makefile", 3)).toBe("Makefile.copy-3");
  });
});

describe("pit undo of take", () => {
  it("removes taken files and only the directories the take created", async () => {
    await branchWith("feature", { "nested/deep/x.txt": "x\n", "top.txt": "top\n" });
    await mkdir(join(repo, "nested"));
    await writeFile(join(repo, "nested/keep.txt"), "keep\n");
    await take(repo, { branch: "feature", paths: ["nested", "top.txt"], yes: true });
    expect(await read("nested/deep/x.txt")).toBe("x\n");

    await undo(repo, { force: false, list: false, yes: true });

    expect(existsSync(join(repo, "top.txt"))).toBe(false);
    expect(existsSync(join(repo, "nested/deep"))).toBe(false);
    expect(await read("nested/keep.txt")).toBe("keep\n");
  });

  it("refuses edited files unless forced, then backs them up", async () => {
    await branchWith("feature", { "taken.txt": "taken\n" });
    await take(repo, { branch: "feature", paths: ["taken.txt"], yes: true });
    await writeFile(join(repo, "taken.txt"), "edited\n");

    await expect(undo(repo, { force: false, list: false, yes: true })).rejects.toThrow("edited");
    expect(await read("taken.txt")).toBe("edited\n");

    await undo(repo, { force: true, list: false, yes: true });

    expect(existsSync(join(repo, "taken.txt"))).toBe(false);
    const refs = (await git(["for-each-ref", "--format=%(refname)", "refs/pit/backups"])).split("\n");
    expect(refs).toHaveLength(1);
    expect(await git(["cat-file", "-p", refs[0]!])).toBe("edited");
  });

  it("reverses take then fold -a with undo -2, leaving nothing staged", async () => {
    const before = await head();
    await branchWith("feature", { "lib/new.ts": "new\n" });
    await take(repo, { branch: "feature", paths: ["lib/new.ts"], yes: true });
    await fold(repo, { all: true, edit: false, noVerify: false, yes: true });
    expect(await git(["show", "HEAD:lib/new.ts"])).toBe("new");

    await undo(repo, { count: 2, force: false, list: false, yes: true });

    expect(await head()).toBe(before);
    expect(existsSync(join(repo, "lib"))).toBe(false);
    expect(await git(["status", "--porcelain"])).toBe("");
  });

  it("keeps only the three most recent actions undoable", async () => {
    const heads: string[] = [];
    for (const index of [1, 2, 3, 4]) {
      heads.push(await head());
      await writeFile(join(repo, "tracked.txt"), `fold ${index}\n`);
      await fold(repo, { all: false, edit: false, noVerify: false, yes: true });
    }
    expect((await journalEntries()).filter((entry) => entry.phase === "expired")).toHaveLength(1);

    await undo(repo, { count: 3, force: false, list: false, yes: true });

    expect(await head()).toBe(heads[1]);
    await expect(undo(repo, { force: false, list: false, yes: true }))
      .rejects.toThrow("no pit action left to undo");
  });

  it("rejects undoing more than three actions", async () => {
    await expect(main(["undo", "-4"])).rejects.toThrow("max 3");
    await expect(main(["undo", "-0"])).rejects.toThrow("max 3");
  });
});
