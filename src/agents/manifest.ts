import { resolveInside, assertName } from "./names";
import type { RemoteEntry, RemoteRepo } from "./remote";

export interface AgentManifest {
  agent: string;
  workers?: string[];
  skills?: string[];
  scripts?: string[];
  uses?: Array<{ agent: string; worker: string }>;
}

export interface InstalledFile {
  sourcePath: string;
  targetPath: string;
  mode: string;
  oid: string;
}

export interface ParsedManifest {
  manifest: AgentManifest;
  warnings: string[];
}

export interface RemoteAgent {
  name: string;
  manifest?: AgentManifest;
  description: string;
  warnings: string[];
  files: InstalledFile[];
  error?: Error;
}

export interface RemoteSkill {
  name: string;
  description: string;
  files: InstalledFile[];
  error?: Error;
}

const allowedTargetDirs = [".github/agents", ".github/skills", ".github/scripts"];
const allowedManifestKeys = new Set(["agent", "workers", "skills", "scripts", "uses"]);

function assertOnlyKeys(value: Record<string, unknown>, keys: Set<string>, context: string): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      throw new Error(`Unknown key "${key}" in ${context}.`);
    }
  }
}

function stringArray(
  value: unknown,
  kind: "worker" | "skill" | "script",
  context: string,
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${kind}s in ${context} must be an array.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    assertName(kind, item, context);
    if (seen.has(item)) {
      throw new Error(`Duplicate ${kind} "${item}" in ${context}.`);
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

function frontMatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? null;
}

function frontMatterValue(content: string, key: string): string {
  const matter = frontMatter(content);
  if (matter === null) {
    return "";
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = matter.match(new RegExp(`^${escapedKey}:\\s*(.*?)\\s*$`, "m"));
  if (match?.[1] === undefined) {
    return "";
  }
  const value = match[1];
  if (
    value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function asObject(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function assertInstallableEntries(folder: string, entries: RemoteEntry[]): void {
  for (const entry of entries) {
    if (entry.path.startsWith(`${folder}/`) || entry.path === folder) {
      if (entry.mode === "120000") {
        throw new Error(`Symlinks are not allowed in ${folder}: ${entry.path}`);
      }
      if (entry.mode === "160000") {
        throw new Error(`Submodules are not allowed in ${folder}: ${entry.path}`);
      }
      if (entry.mode !== "100644" && entry.mode !== "100755") {
        throw new Error(`Unsupported file mode ${entry.mode} in ${folder}: ${entry.path}`);
      }
    }
  }
}

function installedFile(remote: RemoteRepo, sourcePath: string, targetPath: string): InstalledFile {
  resolveInside(".", targetPath, allowedTargetDirs);
  const entry = remote.entries.find((candidate) => candidate.path === sourcePath);
  if (entry === undefined) {
    throw new Error(`File not found in agents repository: ${sourcePath}`);
  }
  return { sourcePath, targetPath, mode: entry.mode, oid: entry.oid };
}

export function parseManifest(folder: string, json: unknown, remote: RemoteRepo): ParsedManifest {
  const context = `${folder}/agent.manifest.json`;
  const object = asObject(json, context);
  assertOnlyKeys(object, allowedManifestKeys, context);
  assertName("agent", object.agent, context);
  if (object.agent !== folder) {
    throw new Error(`Agent name "${object.agent}" in ${context} does not match folder "${folder}".`);
  }
  const workers = stringArray(object.workers, "worker", context);
  const skills = stringArray(object.skills, "skill", context);
  const scripts = stringArray(object.scripts, "script", context);
  let uses: AgentManifest["uses"];
  if (object.uses !== undefined) {
    if (!Array.isArray(object.uses)) {
      throw new Error(`uses in ${context} must be an array.`);
    }
    const seen = new Set<string>();
    uses = object.uses.map((item) => {
      const use = asObject(item, context);
      assertOnlyKeys(use, new Set(["agent", "worker"]), context);
      assertName("agent", use.agent, context);
      assertName("worker", use.worker, context);
      const key = `${use.agent}\0${use.worker}`;
      if (seen.has(key)) {
        throw new Error(`Duplicate uses entry "${use.agent}/${use.worker}" in ${context}.`);
      }
      seen.add(key);
      return { agent: use.agent, worker: use.worker };
    });
  }

  const knownPaths = new Set(remote.entries.map((entry) => entry.path));
  const mainPath = `${folder}/${folder}.agent.md`;
  if (!knownPaths.has(mainPath)) {
    throw new Error(`Main agent file is missing: ${mainPath} (listed in ${context}).`);
  }
  for (const worker of workers ?? []) {
    const path = `${folder}/${worker}.agent.md`;
    if (!knownPaths.has(path)) {
      throw new Error(`Worker "${worker}" is missing (${path}) in ${context}.`);
    }
  }
  for (const script of scripts ?? []) {
    const path = `${folder}/scripts/${script}`;
    if (!knownPaths.has(path)) {
      throw new Error(`Script "${script}" is missing (${path}) in ${context}.`);
    }
  }
  for (const skill of skills ?? []) {
    const path = `skills/${skill}/SKILL.md`;
    if (!knownPaths.has(path)) {
      throw new Error(`Skill "${skill}" is missing (${path}) in ${context}.`);
    }
  }

  const listedAgentFiles = new Set([`${folder}.agent.md`, ...(workers ?? []).map((worker) => `${worker}.agent.md`)]);
  const warnings: string[] = [];
  for (const entry of remote.entries) {
    if (
      entry.path.startsWith(`${folder}/`)
      && !entry.path.slice(folder.length + 1).includes("/")
      && entry.path.endsWith(".agent.md")
      && !listedAgentFiles.has(entry.path.slice(folder.length + 1))
    ) {
      warnings.push(`Unlisted agent file: ${entry.path}`);
    }
  }
  return {
    manifest: {
      agent: object.agent,
      ...(workers === undefined ? {} : { workers }),
      ...(skills === undefined ? {} : { skills }),
      ...(scripts === undefined ? {} : { scripts }),
      ...(uses === undefined ? {} : { uses }),
    },
    warnings,
  };
}

export async function listRemoteAgents(remote: RemoteRepo): Promise<RemoteAgent[]> {
  const folders = new Set(
    remote.entries
      .map((entry) => entry.path.split("/")[0])
      .filter((folder): folder is string => folder !== undefined && folder !== "skills"),
  );
  const agents: RemoteAgent[] = [];
  for (const folder of [...folders].sort()) {
    const manifestPath = `${folder}/agent.manifest.json`;
    if (!remote.entries.some((entry) => entry.path === manifestPath)) {
      continue;
    }
    try {
      assertInstallableEntries(folder, remote.entries);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse((await remote.readFile(manifestPath)).toString("utf8")) as unknown;
      } catch (error) {
        throw new Error(`Invalid ${manifestPath}: ${(error as Error).message}`);
      }
      const parsed = parseManifest(folder, parsedJson, remote);
      const mainPath = `${folder}/${folder}.agent.md`;
      const description = frontMatterValue(
        (await remote.readFile(mainPath)).toString("utf8"),
        "description",
      );
      const warnings = [...parsed.warnings];
      for (const worker of parsed.manifest.workers ?? []) {
        const workerPath = `${folder}/${worker}.agent.md`;
        const workerContent = (await remote.readFile(workerPath)).toString("utf8");
        if (frontMatterValue(workerContent, "user-invocable") !== "false") {
          warnings.push(`Worker ${workerPath} should declare user-invocable: false.`);
        }
      }
      const files = [
        installedFile(remote, mainPath, `.github/agents/${folder}.agent.md`),
        ...(parsed.manifest.workers ?? []).map((worker) => {
          const path = `${folder}/${worker}.agent.md`;
          return installedFile(remote, path, `.github/agents/${worker}.agent.md`);
        }),
        ...(parsed.manifest.scripts ?? []).map((script) => {
          const path = `${folder}/scripts/${script}`;
          return installedFile(remote, path, `.github/scripts/${folder}/${script}`);
        }),
      ];
      agents.push({ name: folder, manifest: parsed.manifest, description, warnings, files });
    } catch (error) {
      agents.push({
        name: folder,
        description: "",
        warnings: [],
        files: [],
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return agents;
}

export async function listRemoteSkills(remote: RemoteRepo): Promise<RemoteSkill[]> {
  const folders = new Set(
    remote.entries
      .map((entry) => {
        const parts = entry.path.split("/");
        return parts[0] === "skills" ? parts[1] : undefined;
      })
      .filter((folder): folder is string => folder !== undefined),
  );
  const skills: RemoteSkill[] = [];
  for (const folder of [...folders].sort()) {
    const skillPath = `skills/${folder}/SKILL.md`;
    if (!remote.entries.some((entry) => entry.path === skillPath)) {
      continue;
    }
    try {
      assertName("skill", folder, skillPath);
      assertInstallableEntries(`skills/${folder}`, remote.entries);
      const description = frontMatterValue((await remote.readFile(skillPath)).toString("utf8"), "description");
      const files = remote.entries
        .filter((entry) => entry.path.startsWith(`skills/${folder}/`))
        .map((entry) => installedFile(
          remote,
          entry.path,
          `.github/skills/${folder}/${entry.path.slice(`skills/${folder}/`.length)}`,
        ));
      skills.push({ name: folder, description, files });
    } catch (error) {
      skills.push({
        name: folder,
        description: "",
        files: [],
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  return skills;
}
