import { sha256 } from "../files";
import type { AgentsLock, LockedFile } from "./lock";
import { resolveInside } from "./names";

export interface PlanOwner {
  kind: "agent" | "skill";
  name: string;
}

export interface DesiredFile {
  path: string;
  content: Buffer;
  executable: boolean;
}

export interface DesiredOwnerFiles {
  owner: PlanOwner;
  files: DesiredFile[];
}

export type PlannedActionKind = "write" | "overwrite" | "skip" | "recreate" | "delete";

export interface PlannedAction {
  path: string;
  owner: PlanOwner;
  action: PlannedActionKind;
  file?: DesiredFile;
}

export interface PlanCollision {
  path: string;
  owners: string[];
  reason: "unowned file" | `claimed by ${string}`;
}

export interface Plan {
  actions: PlannedAction[];
  collisions: PlanCollision[];
  edited: Array<{ path: string; owner: PlanOwner }>;
  backups: string[];
  warnings: string[];
  currentLock: AgentsLock;
  affectedOwners: PlanOwner[];
  removedOwners: PlanOwner[];
}

const allowedTargetDirs = [".github/agents", ".github/skills", ".github/scripts"];

function ownerKey(owner: PlanOwner): string {
  return `${owner.kind}:${owner.name}`;
}

export function ownerLabel(owner: PlanOwner): string {
  return `${owner.kind} "${owner.name}"`;
}

function lockedFiles(lock: AgentsLock, owner: PlanOwner): LockedFile[] {
  const entry = owner.kind === "agent" ? lock.agents[owner.name] : lock.skills[owner.name];
  return entry?.files ?? [];
}

function allLockedOwners(lock: AgentsLock): Array<{ owner: PlanOwner; files: LockedFile[] }> {
  return [
    ...Object.entries(lock.agents).map(([name, entry]) => ({
      owner: { kind: "agent" as const, name },
      files: entry.files,
    })),
    ...Object.entries(lock.skills).map(([name, entry]) => ({
      owner: { kind: "skill" as const, name },
      files: entry.files,
    })),
  ];
}

export function planFiles(
  root: string,
  desired: DesiredOwnerFiles[],
  ownersBeingRemoved: PlanOwner[],
  lock: AgentsLock,
  localHashes: Map<string, string | null>,
  force: boolean,
): Plan {
  const desiredByOwner = new Map<string, DesiredOwnerFiles>();
  const removed = new Map(ownersBeingRemoved.map((owner) => [ownerKey(owner), owner]));
  const affectedOwners = new Map<string, PlanOwner>();
  const desiredByPath = new Map<string, Array<{ owner: PlanOwner; file: DesiredFile }>>();
  const existingOwnersByPath = new Map<string, PlanOwner[]>();

  for (const { owner, files } of desired) {
    const key = ownerKey(owner);
    if (removed.has(key)) {
      throw new Error(`${ownerLabel(owner)} cannot be both installed and removed.`);
    }
    if (desiredByOwner.has(key)) {
      throw new Error(`${ownerLabel(owner)} appears more than once in the desired files.`);
    }
    desiredByOwner.set(key, { owner, files });
    affectedOwners.set(key, owner);
    for (const file of files) {
      resolveInside(root, file.path, allowedTargetDirs);
      const entries = desiredByPath.get(file.path) ?? [];
      entries.push({ owner, file });
      desiredByPath.set(file.path, entries);
    }
  }
  for (const owner of ownersBeingRemoved) {
    affectedOwners.set(ownerKey(owner), owner);
  }

  for (const { owner, files } of allLockedOwners(lock)) {
    for (const file of files) {
      resolveInside(root, file.path, allowedTargetDirs);
      const owners = existingOwnersByPath.get(file.path) ?? [];
      if (!owners.some((item) => ownerKey(item) === ownerKey(owner))) {
        owners.push(owner);
      }
      existingOwnersByPath.set(file.path, owners);
    }
  }

  const collisionsByPath = new Map<string, PlanCollision>();
  const addCollision = (collision: PlanCollision): void => {
    const existing = collisionsByPath.get(collision.path);
    if (existing === undefined) {
      collisionsByPath.set(collision.path, collision);
      return;
    }
    existing.owners = [...new Set([...existing.owners, ...collision.owners])].sort();
  };

  for (const [path, claims] of desiredByPath) {
    const claimOwners = [...new Map(claims.map(({ owner }) => [ownerKey(owner), owner])).values()];
    if (claimOwners.length > 1) {
      addCollision({
        path,
        owners: claimOwners.map(ownerLabel).sort(),
        reason: `claimed by ${ownerLabel(claimOwners[1]!)}`,
      });
    }

    const oldOwners = existingOwnersByPath.get(path) ?? [];
    const newOwner = claimOwners[0];
    if (newOwner !== undefined) {
      const otherOwner = oldOwners.find((owner) => ownerKey(owner) !== ownerKey(newOwner));
      if (otherOwner !== undefined) {
        addCollision({
          path,
          owners: [...new Set([ownerLabel(newOwner), ...oldOwners.map(ownerLabel)])].sort(),
          reason: `claimed by ${ownerLabel(otherOwner)}`,
        });
      } else if (oldOwners.length === 0 && localHashes.get(path) != null) {
        addCollision({
          path,
          owners: [ownerLabel(newOwner)],
          reason: "unowned file",
        });
      }
    }
  }

  const actions: PlannedAction[] = [];
  const edited: Plan["edited"] = [];
  const editedKeys = new Set<string>();
  const backups = new Set<string>();
  const markEdited = (path: string, owner: PlanOwner): void => {
    const key = `${ownerKey(owner)}\0${path}`;
    if (!editedKeys.has(key)) {
      editedKeys.add(key);
      edited.push({ path, owner });
    }
    if (force) {
      backups.add(path);
    }
  };

  for (const { owner, files } of desired) {
    const oldFiles = new Map<string, LockedFile[]>();
    for (const oldFile of lockedFiles(lock, owner)) {
      const filesAtPath = oldFiles.get(oldFile.path) ?? [];
      filesAtPath.push(oldFile);
      oldFiles.set(oldFile.path, filesAtPath);
    }
    for (const file of files) {
      const oldFileHashes = oldFiles.get(file.path) ?? [];
      const currentHash = localHashes.get(file.path) ?? null;
      const desiredHash = sha256(file.content);
      if (currentHash === null) {
        actions.push({
          path: file.path,
          owner,
          action: oldFileHashes.length === 0 ? "write" : "recreate",
          file,
        });
      } else if (currentHash === desiredHash) {
        actions.push({ path: file.path, owner, action: "skip", file });
      } else if (oldFileHashes.length === 0) {
        actions.push({ path: file.path, owner, action: "write", file });
      } else if (oldFileHashes.some((oldFile) => currentHash === oldFile.sha256)) {
        actions.push({ path: file.path, owner, action: "overwrite", file });
      } else {
        markEdited(file.path, owner);
        actions.push({ path: file.path, owner, action: "overwrite", file });
      }
    }
  }

  const removedKeys = new Set(removed.keys());
  for (const [key, owner] of affectedOwners) {
    const wanted = desiredByOwner.get(key);
    const wantedPaths = new Set(wanted?.files.map((file) => file.path) ?? []);
    if (wanted === undefined && !removedKeys.has(key)) {
      continue;
    }
    const oldFilesByPath = new Map<string, LockedFile[]>();
    for (const file of lockedFiles(lock, owner)) {
      const filesAtPath = oldFilesByPath.get(file.path) ?? [];
      filesAtPath.push(file);
      oldFilesByPath.set(file.path, filesAtPath);
    }
    for (const [path, oldFiles] of oldFilesByPath) {
      if (wantedPaths.has(path)) {
        continue;
      }
      const currentHash = localHashes.get(path) ?? null;
      if (currentHash === null) {
        continue;
      }
      if (!oldFiles.some((file) => currentHash === file.sha256)) {
        markEdited(path, owner);
      }
      actions.push({ path, owner, action: "delete" });
    }
  }

  return {
    actions,
    collisions: [...collisionsByPath.values()].sort((left, right) => left.path.localeCompare(right.path)),
    edited,
    backups: [...backups].sort(),
    warnings: [],
    currentLock: lock,
    affectedOwners: [...affectedOwners.values()],
    removedOwners: [...removed.values()],
  };
}
