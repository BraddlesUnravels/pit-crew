import { git } from "./git";
import { findRepositoryRoot } from "./repo-state";
import { baseBranches } from "./commands/flat-fold";

export async function completeBaseBranches(cwd: string): Promise<string[]> {
  const root = await findRepositoryRoot(cwd);
  const current = (await git(["branch", "--show-current"], { cwd: root })).stdout.trim();
  return (await baseBranches(root, current)).map((branch) => branch.short);
}

export const zshCompletion = `
_pit() {
  if [[ \${words[2]} != fold ]]; then
    return 1
  fi

  if [[ \${words[CURRENT-1]} == --base ]]; then
    local -a branches
    branches=("\${(@f)$(pit __complete-base 2>/dev/null)}")
    (( \${#branches} )) && compadd -a branches
  elif [[ \${words[CURRENT]} == --base=* ]]; then
    local -a branches
    branches=("\${(@f)$(pit __complete-base 2>/dev/null)}")
    compset -P '--base='
    (( \${#branches} )) && compadd -a branches
  fi
}
compdef _pit pit
`;
