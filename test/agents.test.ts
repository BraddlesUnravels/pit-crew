import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FILE_MODE_EXECUTABLE,
  FILE_MODE_MASK,
  FILE_MODE_NON_EXECUTABLE,
  sha256,
} from "../src/files";
import { agentsRepoUrl } from "../src/agents/config";
import { planFiles, type DesiredFile } from "../src/agents/plan";
import { assertName, resolveInside } from "../src/agents/names";
import {
  classifyCloneError,
  withRemoteClone,
} from "../src/agents/remote";
import { listRemoteAgents, listRemoteSkills, parseManifest } from "../src/agents/manifest";
import { emptyLock, readLock, writeLock } from "../src/agents/lock";
import { agentList } from "../src/commands/agent";
import { main } from "../src/cli";
import { chooseMany } from "../src/prompt";

const clackMock = vi.hoisted(() => ({
  autocompleteMultiselect: vi.fn(),
  isCancel: vi.fn(),
}));
vi.mock("@clack/prompts", () => clackMock);

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];
const previousConfig = process.env.GIT_CONFIG_GLOBAL;
const previousSystemConfig = process.env.GIT_CONFIG_NOSYSTEM;
const previousCwd = process.cwd();

async function gitAt(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

interface AgentsRepoSpec {
  files?: Record<string, string>;
  executable?: string[];
  symlinks?: Record<string, string>;
}

async function makeAgentsRepo(spec: AgentsRepoSpec = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pit-agents-fixture-"));
  temporaryPaths.push(root);
  const files: Record<string, string> = {
    "reviewer/agent.manifest.json": JSON.stringify({
      version: "1.0.0",
      agent: "reviewer",
      workers: ["worker"],
      skills: ["linting"],
      scripts: ["audit.sh"],
      uses: [{ agent: "planner", worker: "consult" }],
    }),
    "reviewer/reviewer.agent.md": [
      "---",
      "description: Reviews code carefully",
      "---",
      "Review code changes.",
      "",
    ].join("\n"),
    "reviewer/worker.agent.md": [
      "---",
      "user-invocable: false",
      "---",
      "Review a focused area.",
      "",
    ].join("\n"),
    "reviewer/scripts/audit.sh": "#!/bin/sh\nprintf 'audit\\n'\n",
    "skills/linting/SKILL.md": [
      "---",
      "description: Apply linting guidance",
      "---",
      "Linting skill contents.",
      "",
    ].join("\n"),
    "skills/linting/examples/rules.json": "{\"strict\":true}\n",
    ...spec.files,
  };
  await gitAt(root, ["init", "-b", "main"]);
  await gitAt(root, ["config", "user.name", "Pit Tests"]);
  await gitAt(root, ["config", "user.email", "pit-tests@example.invalid"]);
  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(root, path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, content);
    if (path === "reviewer/scripts/audit.sh" || spec.executable?.includes(path)) {
      await chmod(absolutePath, FILE_MODE_EXECUTABLE);
    }
  }
  for (const [path, target] of Object.entries(spec.symlinks ?? {})) {
    const absolutePath = join(root, path);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await symlink(target, absolutePath);
  }
  await gitAt(root, ["add", "-A"]);
  await gitAt(root, ["commit", "-m", "agents fixture"]);
  return pathToFileURL(root).href;
}

async function updateAgentsRepo(url: string, path: string, content: string): Promise<string> {
  const root = fileURLToPath(url);
  const absolutePath = join(root, path);
  await mkdir(join(absolutePath, ".."), { recursive: true });
  await writeFile(absolutePath, content);
  await gitAt(root, ["add", path]);
  await gitAt(root, ["commit", "-m", "update agents fixture"]);
  return gitAt(root, ["rev-parse", "HEAD"]);
}

async function useGlobalConfig(options: { agentsRepo?: string } = {}): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pit-global-config-"));
  temporaryPaths.push(directory);
  const configPath = join(directory, "gitconfig");
  const agentConfig = options.agentsRepo === undefined
    ? ""
    : `\n[pit]\n\tagentsRepo = ${options.agentsRepo}\n`;
  await writeFile(
    configPath,
    `[user]\n\tname = Pit Tests\n\temail = pit-tests@example.invalid\n${agentConfig}`,
  );
  process.env.GIT_CONFIG_GLOBAL = configPath;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
}

async function setupProjectRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pit-project-"));
  temporaryPaths.push(root);
  await gitAt(root, ["init", "-b", "main"]);
  await gitAt(root, ["config", "user.name", "Pit Tests"]);
  await gitAt(root, ["config", "user.email", "pit-tests@example.invalid"]);
  await writeFile(join(root, "README.txt"), "project\n");
  await gitAt(root, ["add", "README.txt"]);
  await gitAt(root, ["commit", "-m", "project fixture"]);
  return root;
}

function lockWithSkillFiles(files: Array<{ path: string; content: Buffer }>) {
  const lock = emptyLock({ url: "file:///agents", commit: "abc" });
  lock.skills.linting = {
    status: "installed",
    explicit: true,
    requiredBy: [],
    commit: "abc",
    files: files.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
  };
  return lock;
}

function desiredSkillFile(content: string): DesiredFile {
  return {
    path: ".github/skills/linting/SKILL.md",
    content: Buffer.from(content),
    executable: false,
  };
}

function captureOutput(): { stdout: ReturnType<typeof vi.spyOn>; stderr: ReturnType<typeof vi.spyOn> } {
  return {
    stdout: vi.spyOn(process.stdout, "write").mockImplementation(() => true),
    stderr: vi.spyOn(process.stderr, "write").mockImplementation(() => true),
  };
}

afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
  if (previousConfig === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = previousConfig;
  }
  if (previousSystemConfig === undefined) {
    delete process.env.GIT_CONFIG_NOSYSTEM;
  } else {
    process.env.GIT_CONFIG_NOSYSTEM = previousSystemConfig;
  }
  process.chdir(previousCwd);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent source configuration and cloning", () => {
  it("reports the exact missing configuration message", async () => {
    await useGlobalConfig();
    await expect(agentsRepoUrl()).rejects.toMatchObject({
      message: "No agents repository configured. Set one with: " +
        "git config --global pit.agentsRepo <url>",
    });
  });

  it.each([
    "Authentication failed",
    "Permission denied (publickey",
    "could not read Username",
    "terminal prompts disabled",
    "Host key verification failed",
  ])("classifies credential error %s", (message) => {
    expect(classifyCloneError(message, "ssh://example.invalid/agents.git").message).toBe(
      "Git credentials for ssh://example.invalid/agents.git were rejected or need an interactive prompt. " +
        "Check your SSH key or credential helper.",
    );
  });

  it("classifies missing repositories and preserves other Git errors", () => {
    expect(classifyCloneError("fatal: Repository not found", "url").message).toBe(
      "Agents repository url does not exist or your credentials cannot access it.",
    );
    expect(classifyCloneError("fatal: other failure", "url").message).toBe("fatal: other failure");
    expect(classifyCloneError("", "url").message).toBe("could not clone url");
  });

  it("cleans up the temporary clone when cloning a missing file URL fails", async () => {
    const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pit-agents-")));
    const missingRepo = pathToFileURL(join(tmpdir(), `missing-pit-agents-${Date.now()}`)).href;
    await expect(withRemoteClone(missingRepo, async () => undefined)).rejects.toThrow(/fatal:|does not exist/);
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith("pit-agents-"));
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });
});

describe("agent manifests and remote listings", () => {
  it("requires a non-empty source manifest version and preserves valid versions", async () => {
    const url = await makeAgentsRepo();
    await withRemoteClone(url, async (remote) => {
      expect(() => parseManifest("reviewer", { agent: "reviewer" }, remote))
        .toThrow("Version in reviewer/agent.manifest.json must be a non-empty string.");
      for (const version of [undefined, null, 1, "", " \t "]) {
        expect(() => parseManifest("reviewer", { agent: "reviewer", version }, remote))
          .toThrow("Version in reviewer/agent.manifest.json must be a non-empty string.");
      }
      expect(parseManifest("reviewer", { agent: "reviewer", version: "1.2.3" }, remote).manifest)
        .toEqual({ agent: "reviewer", version: "1.2.3" });
      expect(() => parseManifest("reviewer", {
        agent: "reviewer", version: "1.2.3", unexpected: true,
      }, remote)).toThrow('Unknown key "unexpected"');
    });
  });

  it("reports versionless remote agents while listing the planner under its folder name", async () => {
    const url = await makeAgentsRepo({
      files: {
        "legacy/agent.manifest.json": JSON.stringify({ agent: "legacy" }),
        "legacy/legacy.agent.md": "Legacy agent.",
        "planner/agent.manifest.json": JSON.stringify({ version: "1", agent: "planner" }),
        "planner/planner.agent.md": "Planner agent.",
      },
    });
    await withRemoteClone(url, async (remote) => {
      const agents = await listRemoteAgents(remote);
      expect(agents.find((entry) => entry.name === "legacy")?.error?.message)
        .toContain("Version in legacy/agent.manifest.json must be a non-empty string.");
      expect(agents.find((entry) => entry.name === "planner")).toMatchObject({
        manifest: { version: "1", agent: "planner" },
        files: [expect.objectContaining({
          sourcePath: "planner/planner.agent.md",
          targetPath: ".github/agents/planner.agent.md",
        })],
      });
    });
  });

  it.each(["../x", "a/b"])("rejects invalid names %s with manifest context", (name) => {
    expect(() => assertName("agent", name, "checker/agent.manifest.json"))
      .toThrow(`"${name}" in checker/agent.manifest.json`);
  });

  it("rejects traversal and targets outside the allowed install directories", () => {
    expect(() => resolveInside("/repo", "../escape", [".github/agents"]))
      .toThrow("cannot contain '..'");
    expect(() => resolveInside("/repo", ".github/scripts/audit.sh", [".github/agents"]))
      .toThrow("outside the allowed folders");
  });

  it("keeps a broken agent isolated while listing other agents", async () => {
    const url = await makeAgentsRepo({
      files: {
        "broken/agent.manifest.json": JSON.stringify({ version: "1", agent: "different" }),
        "broken/broken.agent.md": "Broken agent.",
        "missing/agent.manifest.json": JSON.stringify({ version: "1", agent: "missing", workers: ["absent"] }),
        "missing/missing.agent.md": "Missing worker agent.",
        "missing-script/agent.manifest.json": JSON.stringify({
          version: "1",
          agent: "missing-script",
          scripts: ["absent.sh"],
        }),
        "missing-script/missing-script.agent.md": "Missing script agent.",
        "missing-skill/agent.manifest.json": JSON.stringify({
          version: "1",
          agent: "missing-skill",
          skills: ["absent"],
        }),
        "missing-skill/missing-skill.agent.md": "Missing skill agent.",
      },
    });
    await withRemoteClone(url, async (remote) => {
      const agents = await listRemoteAgents(remote);
      expect(agents.find((entry) => entry.name === "reviewer")?.error).toBeUndefined();
      expect(agents.find((entry) => entry.name === "broken")?.error?.message).toContain(
        "does not match folder",
      );
      expect(agents.find((entry) => entry.name === "missing")?.error?.message).toContain(
        'Worker "absent" is missing',
      );
      expect(agents.find((entry) => entry.name === "missing-script")?.error?.message).toContain(
        'Script "absent.sh" is missing',
      );
      expect(agents.find((entry) => entry.name === "missing-skill")?.error?.message).toContain(
        'Skill "absent" is missing',
      );
    });
  });

  it("refuses symlinks inside agent folders and retains executable script modes", async () => {
    const url = await makeAgentsRepo({
      executable: ["reviewer/scripts/audit.sh"],
      symlinks: { "reviewer/linked.agent.md": "reviewer.agent.md" },
    });
    await withRemoteClone(url, async (remote) => {
      const agents = await listRemoteAgents(remote);
      expect(agents.find((entry) => entry.name === "reviewer")?.error?.message).toContain(
        "Symlinks are not allowed",
      );
    });

    const validUrl = await makeAgentsRepo({ executable: ["reviewer/scripts/audit.sh"] });
    await withRemoteClone(validUrl, async (remote) => {
      const reviewer = (await listRemoteAgents(remote)).find((entry) => entry.name === "reviewer");
      expect(reviewer?.files.find((file) => file.sourcePath.endsWith("audit.sh"))?.mode).toBe("100755");
      expect(reviewer?.files).toContainEqual(expect.objectContaining({
        sourcePath: "reviewer/reviewer.agent.md",
        targetPath: ".github/agents/reviewer.agent.md",
      }));
    });
  });

  it("lists skills and includes all files from each skill directory", async () => {
    const url = await makeAgentsRepo();
    await withRemoteClone(url, async (remote) => {
      const skills = await listRemoteSkills(remote);
      expect(skills).toEqual([
        expect.objectContaining({
          name: "linting",
          description: "Apply linting guidance",
          files: expect.arrayContaining([
            expect.objectContaining({ sourcePath: "skills/linting/examples/rules.json" }),
          ]),
        }),
      ]);
    });
  });
});

describe("file installation planning", () => {
  const root = "/repo";
  const owner = { kind: "skill" as const, name: "linting" };
  const file = desiredSkillFile("new");

  it("plans new, identical and unedited changed files", () => {
    const empty = emptyLock({ url: "", commit: "" });
    expect(planFiles(root, [{ owner, files: [file] }], [], empty, new Map(), false)
      .actions[0]?.action).toBe("write");
    expect(planFiles(
      root,
      [{ owner, files: [file] }],
      [],
      lockWithSkillFiles([{ path: file.path, content: file.content }]),
      new Map([[file.path, sha256(file.content)]]),
      false,
    ).actions[0]?.action).toBe("skip");

    const old = Buffer.from("old");
    const lock = lockWithSkillFiles([{ path: file.path, content: old }]);
    expect(planFiles(
      root,
      [{ owner, files: [file] }],
      [],
      lock,
      new Map([[file.path, sha256(old)]]),
      false,
    ).actions[0]?.action).toBe("overwrite");
  });

  it("blocks edited files unless forced, then schedules a backup", () => {
    const old = Buffer.from("old");
    const lock = lockWithSkillFiles([{ path: file.path, content: old }]);
    const localHashes = new Map([[file.path, sha256(Buffer.from("edited"))]]);
    const blocked = planFiles(root, [{ owner, files: [file] }], [], lock, localHashes, false);
    expect(blocked.edited).toEqual([{ path: file.path, owner }]);
    const forced = planFiles(root, [{ owner, files: [file] }], [], lock, localHashes, true);
    expect(forced.actions[0]?.action).toBe("overwrite");
    expect(forced.backups).toEqual([file.path]);

    const interruptedUpdate = lockWithSkillFiles([{ path: file.path, content: old }]);
    interruptedUpdate.skills.linting!.status = "installing";
    interruptedUpdate.skills.linting!.files.push({
      path: file.path,
      sha256: sha256(file.content),
    });
    const resumed = planFiles(
      root,
      [{ owner, files: [file] }],
      [],
      interruptedUpdate,
      new Map([[file.path, sha256(old)]]),
      false,
    );
    expect(resumed.actions[0]?.action).toBe("overwrite");
    expect(resumed.edited).toEqual([]);
  });

  it("recreates locally deleted files and deletes files no longer wanted", () => {
    const old = Buffer.from("old");
    const lock = lockWithSkillFiles([{ path: file.path, content: old }]);
    expect(planFiles(root, [{ owner, files: [file] }], [], lock, new Map([[file.path, null]]), false)
      .actions[0]?.action).toBe("recreate");
    expect(planFiles(root, [], [owner], lock, new Map([[file.path, sha256(old)]]), false)
      .actions[0]?.action).toBe("delete");
  });

  it("reports unowned and multiply claimed paths as collisions", () => {
    const empty = emptyLock({ url: "", commit: "" });
    const unowned = planFiles(
      root,
      [{ owner, files: [file] }],
      [],
      empty,
      new Map([[file.path, sha256(Buffer.from("local"))]]),
      false,
    );
    expect(unowned.collisions).toMatchObject([{ path: file.path, reason: "unowned file" }]);

    const agent = { kind: "agent" as const, name: "reviewer" };
    const shared = planFiles(
      root,
      [{ owner, files: [file] }, { owner: agent, files: [file] }],
      [],
      empty,
      new Map([[file.path, null]]),
      false,
    );
    expect(shared.collisions[0]?.owners).toEqual(['agent "reviewer"', 'skill "linting"']);
  });

  it("rejects targets that escape the managed folders", () => {
    expect(() => planFiles(
      root,
      [{ owner, files: [{ ...file, path: "../outside" }] }],
      [],
      emptyLock({ url: "", commit: "" }),
      new Map(),
      false,
    )).toThrow("cannot contain '..'");
  });
});

describe("agent and skill list commands", () => {
  it("prints names, descriptions, metadata and installed markers", async () => {
    const agentsRepo = await makeAgentsRepo();
    await useGlobalConfig({ agentsRepo });
    const project = await setupProjectRepo();
    await mkdir(join(project, ".github"), { recursive: true });
    await writeFile(join(project, ".github/pit-agents.lock.json"), JSON.stringify({
      version: 1,
      source: { repo: agentsRepo, commit: "abc" },
      agents: {
        reviewer: {
          status: "installed",
          commit: "abc",
          manifest: { agent: "reviewer" },
          files: [],
        },
      },
      skills: {
        linting: {
          status: "installed",
          explicit: true,
          requiredBy: ["reviewer"],
          commit: "abc",
          files: [],
        },
      },
    }));
    process.chdir(project);
    const output = captureOutput();
    try {
      await main(["agent", "list"]);
      await main(["skill", "list"]);
      const printed = output.stdout.mock.calls.map((call: unknown[]) => String(call[0])).join("");
      expect(printed).toContain("reviewer (installed)");
      expect(printed).toContain("Reviews code carefully");
      expect(printed).toContain("workers: worker");
      expect(printed).toContain("skills: linting");
      expect(printed).toContain("scripts: audit.sh");
      expect(printed).toContain("uses: planner/consult");
      expect(printed).toContain("linting (installed)");
      expect(printed).toContain("Apply linting guidance");
    } finally {
      output.stdout.mockRestore();
      output.stderr.mockRestore();
    }
  });

  it("works outside a Git repository without installed markers", async () => {
    const agentsRepo = await makeAgentsRepo();
    await useGlobalConfig({ agentsRepo });
    const outside = await mkdtemp(join(tmpdir(), "pit-outside-"));
    temporaryPaths.push(outside);
    const output = captureOutput();
    try {
      await agentList(outside);
      const printed = output.stdout.mock.calls.map((call: unknown[]) => String(call[0])).join("");
      expect(printed).toContain("reviewer\n");
      expect(printed).not.toContain("(installed)");
    } finally {
      output.stdout.mockRestore();
      output.stderr.mockRestore();
    }
  });

  it("prints manifest warnings to stderr", async () => {
    const agentsRepo = await makeAgentsRepo({
      files: {
        "reviewer/extra.agent.md": "Unlisted file.",
        "reviewer/worker.agent.md": "Worker without front matter.",
      },
    });
    await useGlobalConfig({ agentsRepo });
    const output = captureOutput();
    try {
      await agentList(process.cwd());
      const warnings = output.stderr.mock.calls.map((call: unknown[]) => String(call[0])).join("");
      expect(warnings).toContain("Unlisted agent file");
      expect(warnings).toContain("user-invocable: false");
    } finally {
      output.stdout.mockRestore();
      output.stderr.mockRestore();
    }
  });

  it("rejects missing and unknown list subcommands and defers add/remove", async () => {
    await expect(main(["agent"])).rejects.toThrow("Usage: pit agent");
    await expect(main(["skill", "unknown"])).rejects.toThrow("Usage: pit skill");
    await expect(main(["agent", "add", "reviewer"])).rejects.toThrow("not yet implemented");
    await expect(main(["skill", "add"])).rejects.toThrow("Usage: pit skill add|remove");
  });
});

describe("skill add and remove commands", () => {
  it("installs executable files and records the explicit skill and commit unstaged", async () => {
    const agentsRepo = await makeAgentsRepo({ executable: ["skills/linting/SKILL.md"] });
    await useGlobalConfig({ agentsRepo });
    const project = await setupProjectRepo();
    process.chdir(project);
    const output = captureOutput();
    try {
      await main(["skill", "add", "linting", "--yes"]);
      const skillPath = join(project, ".github/skills/linting/SKILL.md");
      expect(await readFile(skillPath, "utf8")).toContain("Linting skill contents.");
      expect((await stat(skillPath)).mode & FILE_MODE_MASK).toBe(FILE_MODE_EXECUTABLE);
      const lock = await readLock(project);
      expect(lock.skills.linting).toMatchObject({
        status: "installed",
        explicit: true,
        requiredBy: [],
        commit: await gitAt(fileURLToPath(agentsRepo), ["rev-parse", "HEAD"]),
      });
      expect(await gitAt(project, ["diff", "--cached", "--name-only"])).toBe("");
      expect(await gitAt(project, ["status", "--porcelain"])).toContain("?? .github/");
    } finally {
      output.stdout.mockRestore();
      output.stderr.mockRestore();
    }
  });

  it("updates unedited files from a newer agents repository commit", async () => {
    const agentsRepo = await makeAgentsRepo();
    await useGlobalConfig({ agentsRepo });
    const project = await setupProjectRepo();
    process.chdir(project);
    await main(["skill", "add", "linting", "--yes"]);
    const updatedCommit = await updateAgentsRepo(
      agentsRepo,
      "skills/linting/SKILL.md",
      "Updated linting skill.\n",
    );
    await main(["skill", "add", "linting", "--yes"]);
    expect(await readFile(join(project, ".github/skills/linting/SKILL.md"), "utf8"))
      .toBe("Updated linting skill.\n");
    expect((await readLock(project)).skills.linting?.commit).toBe(updatedCommit);
  });

  it("blocks local edits and backs them up before a forced update", async () => {
    const agentsRepo = await makeAgentsRepo();
    await useGlobalConfig({ agentsRepo });
    const project = await setupProjectRepo();
    process.chdir(project);
    await main(["skill", "add", "linting", "--yes"]);
    const skillPath = join(project, ".github/skills/linting/SKILL.md");
    await writeFile(skillPath, "local edit\n");
    await updateAgentsRepo(agentsRepo, "skills/linting/SKILL.md", "Upstream update.\n");

    await expect(main(["skill", "add", "linting", "--yes"])).rejects.toThrow("edited files");
    const output = captureOutput();
    try {
      await main(["skill", "add", "linting", "--force", "--yes"]);
      const printed = output.stdout.mock.calls.map((call: unknown[]) => String(call[0])).join("");
      const backup = printed.match(/refs\/pit\/backups\/[^/\s]+\/1/);
      expect(backup?.[0]).toBeDefined();
      expect(await gitAt(project, ["cat-file", "blob", backup![0]!])).toBe("local edit");
      expect(await readFile(skillPath, "utf8")).toBe("Upstream update.\n");
    } finally {
      output.stdout.mockRestore();
      output.stderr.mockRestore();
    }
  });

  it("refuses to overwrite an unowned skill path without writing a lock", async () => {
    const agentsRepo = await makeAgentsRepo();
    await useGlobalConfig({ agentsRepo });
    const project = await setupProjectRepo();
    const target = join(project, ".github/skills/linting/SKILL.md");
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "unowned\n");
    process.chdir(project);
    await expect(main(["skill", "add", "linting", "--yes"])).rejects.toThrow("unowned file");
    expect(await readFile(target, "utf8")).toBe("unowned\n");
    await expect(readFile(join(project, ".github/pit-agents.lock.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("removes installed skill files and their empty folder", async () => {
    const agentsRepo = await makeAgentsRepo();
    await useGlobalConfig({ agentsRepo });
    const project = await setupProjectRepo();
    process.chdir(project);
    await main(["skill", "add", "linting", "--yes"]);
    await main(["skill", "remove", "linting", "--yes"]);
    await expect(stat(join(project, ".github/skills/linting")))
      .rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(join(project, ".github/skills"))).isDirectory()).toBe(true);
    expect((await readLock(project)).skills).toEqual({});
  });

  it("refuses required skills and backs up edited files on forced removal", async () => {
    const agentsRepo = await makeAgentsRepo();
    await useGlobalConfig({ agentsRepo });
    const project = await setupProjectRepo();
    process.chdir(project);
    await main(["skill", "add", "linting", "--yes"]);
    const lock = await readLock(project);
    lock.skills.linting!.requiredBy = ["reviewer"];
    await writeLock(project, lock);
    await expect(main(["skill", "remove", "linting", "--yes"]))
      .rejects.toThrow("required by reviewer");
    lock.skills.linting!.requiredBy = [];
    await writeLock(project, lock);

    const skillPath = join(project, ".github/skills/linting/SKILL.md");
    await writeFile(skillPath, "edited before remove\n");
    await expect(main(["skill", "remove", "linting", "--yes"])).rejects.toThrow("edited files");
    const output = captureOutput();
    try {
      await main(["skill", "remove", "linting", "--force", "--yes"]);
      const printed = output.stdout.mock.calls.map((call: unknown[]) => String(call[0])).join("");
      const backup = printed.match(/refs\/pit\/backups\/[^/\s]+\/1/);
      expect(backup?.[0]).toBeDefined();
      expect(await gitAt(project, ["cat-file", "blob", backup![0]!]))
        .toBe("edited before remove");
      await expect(stat(skillPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      output.stdout.mockRestore();
      output.stderr.mockRestore();
    }
  });

  it("removes from the lock without contacting the configured remote", async () => {
    await useGlobalConfig({ agentsRepo: "file:///missing-agents-repository" });
    const project = await setupProjectRepo();
    const content = Buffer.from("installed skill\n");
    const path = ".github/skills/linting/SKILL.md";
    await mkdir(join(project, path, ".."), { recursive: true });
    await writeFile(join(project, path), content);
    const lock = emptyLock({ url: "file:///missing-agents-repository", commit: "abc" });
    lock.skills.linting = {
      status: "installed",
      explicit: true,
      requiredBy: [],
      commit: "abc",
      files: [{ path, sha256: sha256(content) }],
    };
    await writeLock(project, lock);
    process.chdir(project);
    await main(["skill", "remove", "linting", "--yes"]);
    await expect(stat(join(project, path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reconciles an interrupted installation when add is re-run", async () => {
    const agentsRepo = await makeAgentsRepo();
    await useGlobalConfig({ agentsRepo });
    const project = await setupProjectRepo();
    const commit = await gitAt(fileURLToPath(agentsRepo), ["rev-parse", "HEAD"]);
    const skillContent = Buffer.from([
      "---",
      "description: Apply linting guidance",
      "---",
      "Linting skill contents.",
      "",
    ].join("\n"));
    const exampleContent = Buffer.from('{"strict":true}\n');
    const mainPath = ".github/skills/linting/SKILL.md";
    const examplePath = ".github/skills/linting/examples/rules.json";
    const lock = emptyLock({ url: agentsRepo, commit });
    lock.skills.linting = {
      status: "installing",
      explicit: true,
      requiredBy: [],
      commit,
      files: [
        { path: mainPath, sha256: sha256(skillContent) },
        { path: examplePath, sha256: sha256(exampleContent) },
      ],
    };
    await writeLock(project, lock);
    await mkdir(join(project, mainPath, ".."), { recursive: true });
    await writeFile(join(project, mainPath), skillContent);
    process.chdir(project);
    const output = captureOutput();
    try {
      await main(["skill", "add", "linting", "--yes"]);
      const printed = output.stdout.mock.calls.map((call: unknown[]) => String(call[0])).join("");
      expect(printed).toContain(
        'pit: a previous add of linting was interrupted; re-run "pit skill add linting" to finish.',
      );
      expect(await readFile(join(project, examplePath), "utf8")).toBe('{"strict":true}\n');
      expect((await readLock(project)).skills.linting?.status).toBe("installed");
    } finally {
      output.stdout.mockRestore();
      output.stderr.mockRestore();
    }
  });

  it("preserves the non-interactive confirmation error without --yes", async () => {
    const agentsRepo = await makeAgentsRepo();
    await useGlobalConfig({ agentsRepo });
    const project = await setupProjectRepo();
    process.chdir(project);
    const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      await expect(main(["skill", "add", "linting"])).rejects.toThrow(
        "Confirmation requires an interactive terminal; pass --yes to proceed.",
      );
    } finally {
      if (inputTTY === undefined) {
        delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
      } else {
        Object.defineProperty(process.stdin, "isTTY", inputTTY);
      }
      if (outputTTY === undefined) {
        delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
      } else {
        Object.defineProperty(process.stdout, "isTTY", outputTTY);
      }
    }
  });
});

describe("agents lock and prompts", () => {
  it("round-trips locks and writes sorted keys with a trailing newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "pit-lock-"));
    temporaryPaths.push(root);
    expect(await readLock(root)).toMatchObject({
      version: 1,
      source: { repo: "", commit: "" },
      agents: {},
      skills: {},
    });
    const lock = emptyLock({ url: "file:///agents", commit: "abc" });
    lock.agents.zeta = {
      status: "installed",
      commit: "abc",
      manifest: { version: "1.0.0", agent: "zeta" },
      files: [],
    };
    lock.agents.alpha = {
      status: "installed",
      commit: "abc",
      manifest: { version: "2.0.0", agent: "alpha" },
      files: [],
    };
    await writeLock(root, lock);
    const contents = await readFile(join(root, ".github/pit-agents.lock.json"), "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.indexOf('"alpha"')).toBeLessThan(contents.indexOf('"zeta"'));
    expect(
      (await stat(join(root, ".github/pit-agents.lock.json"))).mode & FILE_MODE_MASK,
    ).toBe(FILE_MODE_NON_EXECUTABLE);
    expect(await readLock(root)).toEqual(lock);
  });

  it("preserves versionless legacy lock entries and rejects invalid stored manifest versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pit-lock-legacy-"));
    temporaryPaths.push(root);
    await mkdir(join(root, ".github"));
    const path = join(root, ".github/pit-agents.lock.json");
    const lock = emptyLock({ url: "file:///agents", commit: "abc" });
    lock.agents.reviewer = {
      status: "installed",
      commit: "abc",
      manifest: { agent: "reviewer" },
      files: [],
    };
    await writeFile(path, JSON.stringify(lock));
    const legacy = await readLock(root);
    expect(legacy).toEqual(lock);
    await writeLock(root, legacy);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(lock);

    for (const version of [null, 1, "", " \t "]) {
      await writeFile(path, JSON.stringify({
        ...lock,
        agents: {
          reviewer: { ...lock.agents.reviewer, manifest: { agent: "reviewer", version } },
        },
      }));
      await expect(readLock(root)).rejects.toThrow("the lock file has an invalid structure");
    }
  });

  it("rejects malformed or unknown-version lock files with repair guidance", async () => {
    const root = await mkdtemp(join(tmpdir(), "pit-lock-invalid-"));
    temporaryPaths.push(root);
    await mkdir(join(root, ".github"));
    const path = join(root, ".github/pit-agents.lock.json");
    await writeFile(path, "{");
    await expect(readLock(root)).rejects.toThrow("Fix or delete .github/pit-agents.lock.json");
    await writeFile(path, JSON.stringify({ version: 2 }));
    await expect(readLock(root)).rejects.toThrow("unknown or missing version");
  });

  it("requires a selection with chooseMany by default", async () => {
    const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    clackMock.autocompleteMultiselect.mockResolvedValue(["one"]);
    clackMock.isCancel.mockReturnValue(false);
    try {
      await chooseMany("Choose", [{ value: "one" }], "interactive required");
      expect(clackMock.autocompleteMultiselect).toHaveBeenCalledWith(
        expect.objectContaining({ required: true }),
      );
      clackMock.autocompleteMultiselect.mockClear();
      await chooseMany("Choose optional", [{ value: "one" }], "interactive required", false);
      expect(clackMock.autocompleteMultiselect).toHaveBeenCalledWith(
        expect.objectContaining({ required: false }),
      );
    } finally {
      if (inputTTY === undefined) {
        delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
      } else {
        Object.defineProperty(process.stdin, "isTTY", inputTTY);
      }
      if (outputTTY === undefined) {
        delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
      } else {
        Object.defineProperty(process.stdout, "isTTY", outputTTY);
      }
      clackMock.autocompleteMultiselect.mockReset();
      clackMock.isCancel.mockReset();
    }
  });
});
