import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitOptions {
  cwd: string;
  allowFailure?: boolean;
  env?: NodeJS.ProcessEnv;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export async function git(args: readonly string[], options: GitOptions): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof failure.code === "number" ? failure.code : null;
    const stderr = failure.stderr ?? "";
    if (options.allowFailure === true && exitCode !== null) {
      return { stdout: failure.stdout ?? "", stderr, exitCode };
    }

    const detail = stderr.trim() || failure.message || "Git could not be started";
    throw new GitError(`git ${args.join(" ")} failed: ${detail}`, args, exitCode, stderr);
  }
}

export async function gitBuffer(args: readonly string[], options: Omit<GitOptions, "allowFailure">): Promise<Buffer> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      encoding: "buffer",
      maxBuffer: 256 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { code?: number | string; stderr?: Buffer };
    const exitCode = typeof failure.code === "number" ? failure.code : null;
    const stderr = failure.stderr?.toString("utf8") ?? "";
    const detail = stderr.trim() || failure.message || "Git could not be started";
    throw new GitError(`git ${args.join(" ")} failed: ${detail}`, args, exitCode, stderr);
  }
}

export async function gitInteractive(
  args: readonly string[],
  options: Omit<GitOptions, "allowFailure">,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      stdio: "inherit",
    });

    child.once("error", (error) => {
      reject(new GitError(`Could not start Git: ${error.message}`, args, null, ""));
    });
    child.once("close", (code) => {
      if (code === 0) {
        resolve(0);
      } else {
        reject(new GitError(`git ${args.join(" ")} exited with status ${code ?? "unknown"}`, args, code, ""));
      }
    });
  });
}
