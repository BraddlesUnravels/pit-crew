import { lstat, mkdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  errorCode,
  FILE_MODE_EXECUTABLE,
  FILE_MODE_NON_EXECUTABLE,
  regularFileSha256,
} from "../files";
import { git } from "../git";
import { updateRef } from "../journal";
import type { AgentsLock } from "./lock";
import { writeLock } from "./lock";
import { resolveInside } from "./names";
import { ownerLabel, type Plan, type PlanOwner, type PlannedAction } from "./plan";

const allowedTargetDirs = [".github/agents", ".github/skills", ".github/scripts"];

export async function hashLocal(root: string, paths: string[]): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (const path of new Set(paths)) {
    const absolutePath = resolveInside(root, path, allowedTargetDirs);
    try {
      const stats = await lstat(absolutePath);
      if (!stats.isFile()) {
        throw new Error(`Refusing to manage non-regular file: ${path}`);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        hashes.set(path, null);
        continue;
      }
      throw error;
    }
    hashes.set(path, await regularFileSha256(absolutePath));
  }
  return hashes;
}

function isRemoved(plan: Plan, owner: PlanOwner): boolean {
  return plan.removedOwners.some((removed) =>
    removed.kind === owner.kind && removed.name === owner.name);
}

function setIntermediateLock(plan: Plan, nextLock: AgentsLock): AgentsLock {
  const intermediate = structuredClone(nextLock);
  for (const owner of plan.affectedOwners) {
    if (isRemoved(plan, owner)) {
      if (owner.kind === "agent") {
        const oldEntry = plan.currentLock.agents[owner.name];
        if (oldEntry !== undefined) {
          intermediate.agents[owner.name] = { ...oldEntry, status: "removing" };
        }
      } else {
        const oldEntry = plan.currentLock.skills[owner.name];
        if (oldEntry !== undefined) {
          intermediate.skills[owner.name] = { ...oldEntry, status: "removing" };
        }
      }
      continue;
    }
    if (owner.kind === "agent") {
      const entry = intermediate.agents[owner.name];
      if (entry !== undefined) {
        intermediate.agents[owner.name] = {
          ...entry,
          status: "installing",
          files: [...(plan.currentLock.agents[owner.name]?.files ?? []), ...entry.files],
        };
      }
    } else {
      const entry = intermediate.skills[owner.name];
      if (entry !== undefined) {
        intermediate.skills[owner.name] = {
          ...entry,
          status: "installing",
          files: [...(plan.currentLock.skills[owner.name]?.files ?? []), ...entry.files],
        };
      }
    }
  }
  return intermediate;
}

function setFinalLock(plan: Plan, nextLock: AgentsLock): AgentsLock {
  const finalLock = structuredClone(nextLock);
  for (const owner of plan.affectedOwners) {
    if (isRemoved(plan, owner)) {
      if (owner.kind === "agent") {
        delete finalLock.agents[owner.name];
      } else {
        delete finalLock.skills[owner.name];
      }
    } else if (owner.kind === "agent") {
      const entry = finalLock.agents[owner.name];
      if (entry !== undefined) {
        finalLock.agents[owner.name] = { ...entry, status: "installed" };
      }
    } else {
      const entry = finalLock.skills[owner.name];
      if (entry !== undefined) {
        finalLock.skills[owner.name] = { ...entry, status: "installed" };
      }
    }
  }
  return finalLock;
}

async function backUpEditedFiles(root: string, plan: Plan, opId: string): Promise<void> {
  for (const [index, path] of plan.backups.entries()) {
    resolveInside(root, path, allowedTargetDirs);
    const blob = (await git(
      ["hash-object", "-w", "--no-filters", "--", path],
      { cwd: root },
    )).stdout.trim();
    const ref = `refs/pit/backups/${opId}/${index + 1}`;
    await updateRef(root, ref, blob);
    process.stdout.write(`Backed up ${path} to ${ref}.\n`);
  }
}

function cleanupBoundary(owner: PlanOwner): string {
  if (owner.kind === "skill") {
    return `.github/skills/${owner.name}`;
  }
  return `.github/scripts/${owner.name}`;
}

async function removeEmptyOwnerFolders(root: string, action: PlannedAction): Promise<void> {
  if (action.owner.kind === "agent" && !action.path.startsWith(".github/scripts/")) {
    return;
  }
  const boundary = cleanupBoundary(action.owner);
  const safeBoundary = resolveInside(
    root,
    boundary,
    [action.owner.kind === "skill" ? ".github/skills" : ".github/scripts"],
  );
  const safeFile = resolveInside(root, action.path, [boundary]);
  let directory = dirname(safeFile);
  while (directory === safeBoundary || directory.startsWith(`${safeBoundary}/`)) {
    try {
      await rmdir(directory);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        // Continue upwards; an earlier directory may already have been removed.
      } else if (code === "ENOTEMPTY" || code === "EEXIST") {
        break;
      } else {
        throw error;
      }
    }
    if (directory === safeBoundary) {
      break;
    }
    directory = dirname(directory);
  }
}

export async function applyPlan(
  root: string,
  plan: Plan,
  nextLock: AgentsLock,
  opId: string,
): Promise<void> {
  await writeLock(root, setIntermediateLock(plan, nextLock));
  await backUpEditedFiles(root, plan, opId);

  for (const action of plan.actions) {
    if (action.action !== "write" && action.action !== "overwrite" && action.action !== "recreate") {
      continue;
    }
    const file = action.file;
    if (file === undefined) {
      throw new Error(`Missing contents for planned ${action.action} action: ${action.path}`);
    }
    const absolutePath = resolveInside(root, action.path, allowedTargetDirs);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, {
      mode: file.executable ? FILE_MODE_EXECUTABLE : FILE_MODE_NON_EXECUTABLE,
    });
  }

  const deleteActions = plan.actions.filter((action) => action.action === "delete");
  for (const action of deleteActions) {
    const absolutePath = resolveInside(root, action.path, allowedTargetDirs);
    try {
      await unlink(absolutePath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }
  for (const action of deleteActions) {
    await removeEmptyOwnerFolders(root, action);
  }

  await writeLock(root, setFinalLock(plan, nextLock));
}

function actionLabel(action: PlannedAction): string {
  if (action.action === "skip") {
    return "keep";
  }
  const script = action.path.startsWith(".github/scripts/");
  const executable = action.file?.executable === true;
  const description = script
    ? `script${executable ? " (executable)" : ""}`
    : "file";
  return `${action.action} ${description}`;
}

export function formatPlan(plan: Plan): string {
  if (plan.actions.length === 0) {
    return "No file changes.";
  }
  const groups = new Map<string, { owner: PlanOwner; actions: PlannedAction[] }>();
  for (const action of plan.actions) {
    const key = `${action.owner.kind}:${action.owner.name}`;
    const group = groups.get(key) ?? { owner: action.owner, actions: [] };
    group.actions.push(action);
    groups.set(key, group);
  }
  const lines = ["Planned changes:"];
  for (const { owner, actions } of [...groups.values()].sort((left, right) =>
    ownerLabel(left.owner).localeCompare(ownerLabel(right.owner)))) {
    lines.push(`${ownerLabel(owner)}:`);
    for (const action of actions) {
      lines.push(`  ${actionLabel(action)} ${action.path}`);
    }
  }
  return lines.join("\n");
}

function joinOwners(owners: string[]): string {
  if (owners.length < 2) {
    return owners[0] ?? "another owner";
  }
  return `${owners.slice(0, -1).join(", ")} and ${owners.at(-1)}`;
}

export function formatCollisions(plan: Plan): string {
  return plan.collisions.map((collision) => collision.reason === "unowned file"
    ? `${collision.path} is an unowned file blocking ${collision.owners[0]}.`
    : `${collision.path} is claimed by ${joinOwners(collision.owners)}.`)
    .join("\n");
}

export async function reconcileLock(_root: string, lock: AgentsLock): Promise<void> {
  for (const [name, entry] of Object.entries(lock.agents)) {
    if (entry.status === "installing" || entry.status === "removing") {
      const operation = entry.status === "installing" ? "add" : "remove";
      process.stdout.write(
        `pit: a previous ${operation} of ${name} was interrupted; re-run ` +
        `"pit agent ${operation} ${name}" to finish.\n`,
      );
    }
  }
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (entry.status === "installing" || entry.status === "removing") {
      const operation = entry.status === "installing" ? "add" : "remove";
      process.stdout.write(
        `pit: a previous ${operation} of ${name} was interrupted; re-run ` +
        `"pit skill ${operation} ${name}" to finish.\n`,
      );
    }
  }
}

export function lockedFilePaths(lock: AgentsLock, owners: PlanOwner[]): string[] {
  return owners.flatMap((owner) => {
    const entry = owner.kind === "agent" ? lock.agents[owner.name] : lock.skills[owner.name];
    return entry?.files.map((file) => file.path) ?? [];
  });
}
