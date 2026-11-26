import { agentsRepoUrl } from "../agents/config";
import {
  applyPlan,
  formatCollisions,
  formatPlan,
  hashLocal,
  lockedFilePaths,
  reconcileLock,
} from "../agents/apply";
import { emptyLock, readLock, type AgentsLock } from "../agents/lock";
import { listRemoteSkills } from "../agents/manifest";
import { assertName } from "../agents/names";
import { withRemoteClone } from "../agents/remote";
import { planFiles, type DesiredFile, type PlanOwner } from "../agents/plan";
import { git } from "../git";
import { newOperationId, openJournal, withJournalLock } from "../journal";
import { sha256 } from "../files";
import { confirm } from "../prompt";
import { findRepositoryRoot } from "../repo-state";

export interface SkillOptions {
  force: boolean;
  yes: boolean;
}

function showEditedFiles(paths: string[]): string {
  return paths.map((path) => `  ${path}`).join("\n");
}

function lockWithSkill(
  lock: AgentsLock,
  owner: PlanOwner,
  desiredFiles: DesiredFile[],
  repo: string,
  commit: string,
): AgentsLock {
  const nextLock = structuredClone(lock);
  nextLock.source = { repo, commit };
  const requiredBy = nextLock.skills[owner.name]?.requiredBy ?? [];
  nextLock.skills[owner.name] = {
    status: "installed",
    explicit: true,
    requiredBy,
    commit,
    files: desiredFiles.map((file) => ({ path: file.path, sha256: sha256(file.content) })),
  };
  return nextLock;
}

export async function skillAdd(cwd: string, name: string, options: SkillOptions): Promise<void> {
  assertName("skill", name, "pit skill add");
  const root = await findRepositoryRoot(cwd);
  const journal = await openJournal(root);
  await withJournalLock(journal, async () => {
    const lock = await readLock(root);
    await reconcileLock(root, lock);
    const repoUrl = await agentsRepoUrl();
    await withRemoteClone(repoUrl, async (remote) => {
      const skills = await listRemoteSkills(remote);
      const skill = skills.find((entry) => entry.name === name);
      if (skill === undefined) {
        const available = skills.map((entry) => entry.name);
        throw new Error(
          `Skill "${name}" was not found in the agents repository. ` +
          `Available skills: ${available.length > 0 ? available.join(", ") : "(none)"}.`,
        );
      }
      if (skill.error !== undefined) {
        throw skill.error;
      }

      const owner: PlanOwner = { kind: "skill", name };
      const desiredFiles = await Promise.all(skill.files.map(async (file): Promise<DesiredFile> => ({
        path: file.targetPath,
        content: await remote.readFile(file.sourcePath),
        executable: file.mode === "100755",
      })));
      const paths = [
        ...lockedFilePaths(lock, [owner]),
        ...desiredFiles.map((file) => file.path),
      ];
      const localHashes = await hashLocal(root, paths);
      const plan = planFiles(root, [{ owner, files: desiredFiles }], [], lock, localHashes, options.force);
      if (plan.collisions.length > 0) {
        throw new Error(formatCollisions(plan));
      }
      if (plan.edited.length > 0 && !options.force) {
        throw new Error(
          `Skill "${name}" has edited files:\n${showEditedFiles(plan.edited.map((file) => file.path))}\n` +
          "Refusing to overwrite them; use --force to back them up.",
        );
      }

      const nextLock = lockWithSkill(lock, owner, desiredFiles, remote.url, remote.commit);
      const currentEntry = lock.skills[name];
      const hasFileChanges = plan.actions.some((action) => action.action !== "skip");
      if (
        !hasFileChanges
        && currentEntry?.status === "installed"
        && currentEntry.commit === remote.commit
        && lock.source.repo === remote.url
        && lock.source.commit === remote.commit
        && currentEntry.explicit
      ) {
        process.stdout.write(`Skill "${name}" is up to date.\n`);
        return;
      }

      if (plan.edited.length > 0 && options.force) {
        process.stderr.write(
          `Warning: --force will back up these edited files:\n${showEditedFiles(plan.edited.map((file) => file.path))}\n`,
        );
      }
      process.stdout.write(`${formatPlan(plan)}\n`);
      if (!options.yes && !(await confirm(`Install skill "${name}"?`))) {
        process.stdout.write("Cancelled; no changes were made.\n");
        return;
      }
      await applyPlan(root, plan, nextLock, newOperationId());
      process.stdout.write(`Installed skill "${name}".\n`);
    });
  });
}

export async function skillRemove(cwd: string, name: string, options: SkillOptions): Promise<void> {
  assertName("skill", name, "pit skill remove");
  const root = await findRepositoryRoot(cwd);
  const journal = await openJournal(root);
  await withJournalLock(journal, async () => {
    const lock = await readLock(root);
    await reconcileLock(root, lock);
    const entry = lock.skills[name];
    if (entry === undefined) {
      throw new Error(`Skill "${name}" is not installed.`);
    }
    if (entry.requiredBy.length > 0) {
      throw new Error(
        `skill ${name} is required by ${entry.requiredBy.join(", ")}; remove those agents first.`,
      );
    }

    const owner: PlanOwner = { kind: "skill", name };
    const localHashes = await hashLocal(root, lockedFilePaths(lock, [owner]));
    const plan = planFiles(root, [], [owner], lock, localHashes, options.force);
    if (plan.edited.length > 0 && !options.force) {
      throw new Error(
        `Skill "${name}" has edited files:\n${showEditedFiles(plan.edited.map((file) => file.path))}\n` +
        "Refusing to delete them; use --force to back them up.",
      );
    }

    const nextLock = structuredClone(lock);
    delete nextLock.skills[name];
    process.stdout.write(`${formatPlan(plan)}\n`);
    if (plan.edited.length > 0 && options.force) {
      process.stderr.write(
        `Warning: --force will back up these edited files:\n${showEditedFiles(plan.edited.map((file) => file.path))}\n`,
      );
    }
    if (!options.yes && !(await confirm(`Remove skill "${name}"?`))) {
      process.stdout.write("Cancelled; no changes were made.\n");
      return;
    }
    await applyPlan(root, plan, nextLock, newOperationId());
    process.stdout.write(`Removed skill "${name}".\n`);
  });
}

export async function skillList(cwd: string): Promise<void> {
  const remoteUrl = await agentsRepoUrl();
  await withRemoteClone(remoteUrl, async (remote) => {
    const rootResult = await git(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
    const lock = rootResult.exitCode === 0
      ? await readLock(rootResult.stdout.trim())
      : null;
    const entries = await listRemoteSkills(remote);
    for (const entry of entries) {
      const installed = lock !== null && Object.hasOwn(lock.skills, entry.name);
      process.stdout.write(`${entry.name}${installed ? " (installed)" : ""}\n`);
      if (entry.error !== undefined) {
        process.stdout.write(`  Error: ${entry.error.message}\n`);
        continue;
      }
      if (entry.description.length > 0) {
        process.stdout.write(`  ${entry.description}\n`);
      }
    }
  });
}
