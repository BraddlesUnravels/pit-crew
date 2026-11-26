# pit

`pit` is a local Git helper CLI. It provides `fold`, `take`, `undo`, and
read-only listing for Copilot agents and skills.
The npm package identifier (`pit-crew`) is provisional; the executable name is
`pit`. Check package-name availability before publishing.

## Requirements

- Node.js 24 or newer
- Git

## Development

```sh
npm install
npm run build
npm test
npm link
```

Source imports omit file extensions; the build type-checks TypeScript and
bundles the CLI with esbuild for Node.js.

Run `npm run lint` to check ESLint, or `npm run lint:fix` to apply automatic
fixes. Run `npm run format:check` to check Prettier formatting, or
`npm run format` to format the project. TypeScript's type check remains
separate (`npm run typecheck`). The existing files have not yet been
reformatted, so the formatting check reports differences until `npm run format`
is run.

ESLint uses the Babel TypeScript parser because TypeScript-ESLint does not yet
support the project's TypeScript 7 version. ESLint 9 is used for compatibility
with that parser; it is no longer supported upstream. The core `no-undef` and
`no-unused-vars` rules are disabled for TypeScript because they do not
understand TypeScript syntax.

### Zsh completion

To enable tab-completion for `pit fold -flat --base`, add the following to
`~/.zshrc` after your existing `compinit` setup:

```zsh
autoload -Uz compinit
compinit
source <(pit completion zsh)
```

If `compinit` is already configured, add only the `source` line. Restart the
shell or run the `source` line in the current shell. Completion lists other
local and remote-tracking branches without fetching.

## Commands

### `pit agent list` and `pit skill list`

Configure the Git repository that contains your agents and skills:

```sh
git config --global pit.agentsRepo <url>
pit agent list
pit skill list
```

The configured repository is cloned temporarily for each listing and removed
afterward. Listing works outside a Git project; from inside one, names recorded
in `.github/pit-agents.lock.json` are marked as installed. These commands do
not write files. Agent add/remove commands are not implemented yet.

### `pit skill add` and `pit skill remove`

Install or update a skill from the configured agents repository, or remove a
skill previously recorded in `.github/pit-agents.lock.json`:

```sh
pit skill add linting
pit skill add linting --yes
pit skill add linting --force --yes
pit skill remove linting
```

Skill files are written unstaged. Add previews changes and asks for
confirmation; `--yes` skips the prompt. Updating an installed skill refreshes
its files from the latest source commit. A file edited locally blocks an
update or removal; `--force` backs edited content up under
`refs/pit/backups/` before replacing or deleting it. Unowned files are never
overwritten, and skills required by installed agents cannot be removed.
Removing a skill uses the lock file and does not access the network.

### `pit fold`

Previews and amends the last commit with one confirmation. If the index already
contains staged changes, those are folded; otherwise tracked changes are staged
and folded. Untracked files are excluded unless `-a` is supplied. With `-a`,
untracked files are added while preserving unstaged edits to tracked files when
there were already staged changes.

The commit message is kept by default. `--edit` opens Git's configured editor.
If the target commit appears in a known remote-tracking branch, the preview
warns before confirmation. This check uses existing remote-tracking refs and
does not fetch.

```sh
pit fold
pit fold -a
pit fold --edit
pit fold --yes
```

`--yes` skips confirmation. `--no-verify` skips Git's pre-commit and commit-msg
hooks.

### `pit fold -flat`

Squashes the commits after the merge base with a chosen local or remote-tracking
branch into one commit on the current branch. Pick a base interactively or
provide `--base`; pit does not fetch. It previews every commit being flattened,
warns when any is reachable from a known remote-tracking branch, asks for a new
commit message, and confirms before changing history.

```sh
pit fold -flat
pit fold -flat --base main --message "Summarize the work" --yes
```

The new commit has the existing HEAD tree and the merge base as its sole parent.
Merge topology within the selected range is flattened. Staged, unstaged, and
untracked changes are left untouched. At least two commits are required; shallow
repositories and ambiguous or missing merge bases are refused. This operation
bypasses commit hooks but honors `commit.gpgSign`. It cannot be combined with
`-a`, `--edit`, or `--no-verify`. Use `pit undo` to restore the previous branch
tip while leaving the index and worktree unchanged.

### `pit take`

Copies files or folders from another branch into the working tree. Files are
written to disk only; nothing is staged or committed.

```sh
pit take                         # pick a branch, then files/folders
pit take feature                 # pick files/folders from feature
pit take feature -- src/ui       # take everything under src/ui that differs
pit take origin/main --yes -- Makefile
```

Without a branch, pit offers local and remote-tracking branches (other than the
current one); it does not fetch. Without paths, it offers a searchable list of
the files that are missing or different locally, plus their folders; choosing a
folder takes every listed file beneath it. Paths after `--` are relative to the
current directory and must match at least one differing file.

Take never overwrites or deletes local files:

- a file missing locally is written at its original path;
- a byte-identical local file is skipped;
- a differing local file is kept and the incoming file is written as a copy,
  with `.copy` before the last extension (`button.tsx` → `button.copy.tsx`,
  `foo.test.ts` → `foo.test.copy.ts`, `.eslintrc.json` → `.eslintrc.copy.json`,
  `Makefile` → `Makefile.copy`, `.env` → `.env.copy`). If that name is taken,
  pit uses `.copy-2`, `.copy-3`, …; an existing identical copy is skipped, so
  re-running take does not create duplicates.

Symlinks and submodules are reported as unsupported and skipped. Take refuses
to run during an in-progress Git operation or with sparse checkout enabled.
It previews the result and asks for confirmation unless `--yes` is supplied.

### `pit undo`

Reverses the latest pit `fold` or `take`.

```sh
pit undo
pit undo -2
pit undo --list
pit undo --force
```

Undoing a normal fold restores the commit that was current before it; the folded
content returns as staged changes. Undoing a flat fold restores the original
history without changing the index or worktree. Undo must run on the fold's branch and refuses
to move a branch that has advanced since the fold unless `--force` is provided.
A forced undo warns and keeps the current branch tip in a backup ref before
moving the branch.

Undoing a take deletes the files it wrote and any folders it created that are
now empty, on any branch. Files that are already gone are skipped. If a taken
file was edited since, undo refuses unless `--force` is given; a forced undo
warns, saves the edited content as a blob under `refs/pit/backups/`, then deletes
the file. Taken files that were staged unchanged as new files are unstaged.

`-1`, `-2` or `-3` undo that many recent actions, newest first, each recorded
separately; undo stops at the first action it cannot reverse. Pit keeps the
three most recent actions undoable; older ones expire (their fold backup refs
are removed). `--yes` skips forced-undo confirmations. `--list` shows recent
folds and takes with their status.

Pit records its operations in Git metadata under `pit/journal.jsonl` and keeps
backup refs under `refs/pit/backups/`. Incomplete journal operations are
reconciled from the branch reflog when possible. If Git history moved in a way
that cannot be reconciled safely, pit refuses to guess and retains the backup.

On a failing hook, pit leaves `HEAD` unchanged and records no completed fold.
The attempted staging and any hook edits may remain in the index or worktree;
inspect them before retrying.
