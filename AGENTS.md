# Agent instructions

## Project

`pit` is a TypeScript CLI for Git workflows, currently providing `fold`, `take`
and `undo`. The executable is named `pit`; `pit-crew` is a provisional npm package
name. The current target is macOS with Node.js 24 or newer and Git.

## Development

- Use npm. `npm run build` type-checks and bundles the executable with esbuild.
- Use extensionless relative imports in TypeScript. Keep the bundled CLI
  compatible with Node's ESM runtime.
- Keep TypeScript strict and follow the existing code style.
- Run `npm run typecheck`, `npm test`, and `npm run build` for relevant code
  changes. Tests use Vitest and temporary, real Git repositories; add focused
  integration cases for Git behavior changes.
- Do not run `npm link` automatically: it changes the user's global npm links.
- Do not edit generated files in `dist/` or publish the package.

## Git safety

- Run Git through the helpers in `src/git.ts`, passing arguments separately
  rather than constructing shell commands.
- Preserve user work and existing staged/unstaged changes. Exercise history
  rewriting and failure scenarios only in throwaway repositories.
- Preserve the preview and confirmation behavior, operation-state checks,
  backup refs, journal locking, and interrupted-operation recovery when
  changing `fold`, `take` or `undo`.
- Prompts use `@clack/prompts` via `src/prompt.ts`; without a TTY, prompting
  fails and asks for `--yes` (and, for `take`, a branch and paths).
- `fold` uses staged changes when present; otherwise it stages tracked changes.
  Untracked files are included only with `-a`. Remote warnings use existing
  remote-tracking refs and do not fetch.
- `undo` normally refuses when the branch has moved. Forced undo warns and
  backs up the current tip. Do not silently relax these safeguards.
- `take` writes files to disk only (never staged) and never overwrites or
  deletes local files: identical files are skipped, differing ones are written
  as `.copy` variants (before the last extension, numbered `.copy-N`). It has
  no force option, skips symlinks and submodules, and refuses sparse checkouts.
- Undo of a take deletes only files whose content still matches the journal;
  edited files need `--force`, which backs them up in `refs/pit/backups/`.
- `undo -1..-3` reverses that many actions one at a time. Only the newest three
  folds/takes stay undoable; older ones are journaled as expired and their fold
  backup refs removed. Never delete undo backup refs.
- Git hooks and signing follow the user's Git configuration. A failed hook
  can leave staging or hook edits in place; do not assume the worktree and
  index remain unchanged.
- Keep user-facing behavior and setup instructions in `README.md` in sync with
  changes.