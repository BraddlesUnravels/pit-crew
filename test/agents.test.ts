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
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { agentsRepoUrl } from "../src/agents/config";
import { assertName, resolveInside } from "../src/agents/names";
import {
  classifyCloneError,
  withRemoteClone,
} from "../src/agents/remote";
import { listRemoteAgents, listRemoteSkills } from "../src/agents/manifest";
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
      await chmod(absolutePath, 0o755);
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
    await expect(agentsRepoUrl()).rejects.toThrow(
      "pit: no agents repository configured. Set one with: git config --global pit.agentsRepo <url>",
    );
  });

  it.each([
    "Authentication failed",
    "Permission denied (publickey",
    "could not read Username",
    "terminal prompts disabled",
    "Host key verification failed",
  ])("classifies credential error %s", (message) => {
    expect(classifyCloneError(message, "ssh://example.invalid/agents.git").message).toContain(
      "Git credentials for ssh://example.invalid/agents.git were rejected or need an interactive prompt.",
    );
  });

  it("classifies missing repositories and preserves other Git errors", () => {
    expect(classifyCloneError("fatal: Repository not found", "url").message).toContain(
      "does not exist or your credentials cannot access it",
    );
    expect(classifyCloneError("fatal: other failure", "url").message).toBe("fatal: other failure");
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
        "broken/agent.manifest.json": JSON.stringify({ agent: "different" }),
        "broken/broken.agent.md": "Broken agent.",
        "missing/agent.manifest.json": JSON.stringify({ agent: "missing", workers: ["absent"] }),
        "missing/missing.agent.md": "Missing worker agent.",
        "missing-script/agent.manifest.json": JSON.stringify({
          agent: "missing-script",
          scripts: ["absent.sh"],
        }),
        "missing-script/missing-script.agent.md": "Missing script agent.",
        "missing-skill/agent.manifest.json": JSON.stringify({
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
    await expect(main(["skill", "remove", "linting"])).rejects.toThrow("not yet implemented");
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
      manifest: { agent: "zeta" },
      files: [],
    };
    lock.agents.alpha = {
      status: "installed",
      commit: "abc",
      manifest: { agent: "alpha" },
      files: [],
    };
    await writeLock(root, lock);
    const contents = await readFile(join(root, ".github/pit-agents.lock.json"), "utf8");
    expect(contents.endsWith("\n")).toBe(true);
    expect(contents.indexOf('"alpha"')).toBeLessThan(contents.indexOf('"zeta"'));
    expect(await readLock(root)).toEqual(lock);
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
