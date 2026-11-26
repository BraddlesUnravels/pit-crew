import { homedir } from "node:os";
import { git } from "../git";

export async function agentsRepoUrl(): Promise<string> {
  const result = await git(
    ["config", "--global", "--get", "pit.agentsRepo"],
    { cwd: homedir(), allowFailure: true },
  );
  const url = result.stdout.trim();
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`Could not read pit.agentsRepo: ${result.stderr.trim()}`);
  }
  if (result.exitCode === 1 || url.length === 0) {
    throw new Error(
      "pit: no agents repository configured. Set one with: " +
      "git config --global pit.agentsRepo <url>",
    );
  }
  return url;
}
