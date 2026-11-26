import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitBuffer } from "../git";

export interface RemoteEntry {
  path: string;
  mode: string;
  oid: string;
}

export interface RemoteRepo {
  url: string;
  commit: string;
  entries: RemoteEntry[];
  readFile(path: string): Promise<Buffer>;
}

export function classifyCloneError(stderr: string, url: string): Error {
  const credentialPatterns = [
    "Authentication failed",
    "Permission denied (publickey",
    "could not read Username",
    "terminal prompts disabled",
    "Host key verification failed",
  ];
  if (credentialPatterns.some((pattern) => stderr.includes(pattern))) {
    return new Error(
      `Git credentials for ${url} were rejected or need an interactive prompt. ` +
      "Check your SSH key or credential helper.",
    );
  }
  if (
    stderr.includes("Repository not found")
    || stderr.includes("does not appear to be a git repository")
  ) {
    return new Error(
      `Agents repository ${url} does not exist or your credentials cannot access it.`,
    );
  }
  return new Error(stderr.trim() || `could not clone ${url}`);
}

async function openRemote(url: string, directory: string): Promise<RemoteRepo> {
  const { stdout } = await git(["rev-parse", "HEAD"], { cwd: directory });
  const commit = stdout.trim();
  const tree = await git(["ls-tree", "-r", "-z", "HEAD"], { cwd: directory });
  const entries = tree.stdout
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry): RemoteEntry => {
      const tab = entry.indexOf("\t");
      if (tab < 0) {
        throw new Error(`Could not parse agents repository tree entry: ${entry}`);
      }
      const [mode, , oid] = entry.slice(0, tab).split(" ");
      const path = entry.slice(tab + 1);
      if (mode === undefined || oid === undefined || path.length === 0) {
        throw new Error(`Could not parse agents repository tree entry: ${entry}`);
      }
      return { path, mode, oid };
    });
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  return {
    url,
    commit,
    entries,
    async readFile(path: string): Promise<Buffer> {
      const entry = byPath.get(path);
      if (entry === undefined) {
        throw new Error(`File not found in agents repository: ${path}`);
      }
      return gitBuffer(["cat-file", "blob", entry.oid], { cwd: directory });
    },
  };
}

export async function withRemoteClone<T>(
  url: string,
  work: (remote: RemoteRepo) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "pit-agents-"));
  try {
    const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: "0" };
    if (process.env.GIT_SSH_COMMAND === undefined) {
      env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
    }
    const result = await git(
      ["clone", "--depth", "1", "--single-branch", "--no-tags", "--", url, directory],
      { cwd: homedir(), allowFailure: true, env },
    );
    if (result.exitCode !== 0) {
      throw classifyCloneError(result.stderr, url);
    }
    return await work(await openRemote(url, directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
