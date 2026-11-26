import { git } from "../git";
import { agentsRepoUrl } from "../agents/config";
import { readLock } from "../agents/lock";
import { listRemoteSkills } from "../agents/manifest";
import { withRemoteClone } from "../agents/remote";

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
