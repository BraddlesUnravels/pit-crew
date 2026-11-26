import { git } from "../git";
import { agentsRepoUrl } from "../agents/config";
import { readLock } from "../agents/lock";
import { listRemoteAgents } from "../agents/manifest";
import { withRemoteClone } from "../agents/remote";

export async function agentList(cwd: string): Promise<void> {
  const remoteUrl = await agentsRepoUrl();
  await withRemoteClone(remoteUrl, async (remote) => {
    const rootResult = await git(["rev-parse", "--show-toplevel"], { cwd, allowFailure: true });
    const lock = rootResult.exitCode === 0
      ? await readLock(rootResult.stdout.trim())
      : null;
    const entries = await listRemoteAgents(remote);
    for (const entry of entries) {
      const installed = lock !== null && Object.hasOwn(lock.agents, entry.name);
      process.stdout.write(`${entry.name}${installed ? " (installed)" : ""}\n`);
      if (entry.error !== undefined) {
        process.stdout.write(`  Error: ${entry.error.message}\n`);
        continue;
      }
      if (entry.description.length > 0) {
        process.stdout.write(`  ${entry.description}\n`);
      }
      const manifest = entry.manifest;
      if (manifest === undefined) {
        continue;
      }
      if (manifest.workers !== undefined) {
        process.stdout.write(`  workers: ${manifest.workers.join(", ")}\n`);
      }
      if (manifest.skills !== undefined) {
        process.stdout.write(`  skills: ${manifest.skills.join(", ")}\n`);
      }
      if (manifest.scripts !== undefined) {
        process.stdout.write(`  scripts: ${manifest.scripts.join(", ")}\n`);
      }
      if (manifest.uses !== undefined) {
        process.stdout.write(
          `  uses: ${manifest.uses.map(({ agent, worker }) => `${agent}/${worker}`).join(", ")}\n`,
        );
      }
      for (const warning of entry.warnings) {
        process.stderr.write(`Warning: ${entry.name}: ${warning}\n`);
      }
    }
  });
}
