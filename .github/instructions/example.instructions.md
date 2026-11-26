---
# Copy this file to .github/instructions/<topic>.instructions.md, where <topic>
# names what the rules cover (e.g. tests, commands, git-helpers).

# Glob(s) relative to the repository root; separate multiple with commas.
# This placeholder matches no files, so the template itself stays inactive.
applyTo: "<glob>"

# Optional. VS Code Local sessions only: load the file when the task is relevant,
# even if no file matches applyTo.
# description: "Use when <task this guidance helps with>."

# Optional. GitHub only: hide the file from "code-review" or "cloud-agent".
# excludeAgent: "code-review"
---

# <Topic> conventions

<!-- One sentence on what these files are and why they need their own rules. -->

## Structure

- Put <kind of code> in `<path>`; follow `<existing example file>`.
- Name <things> `<naming pattern>`.

## Required patterns

- Use `<helper or module>` for <task> instead of <what to avoid>.
- <Rule the agent repeatedly gets wrong, stated as a concrete action.>

## Safety

- Never <action that could lose work or leak data>.

## Verification

- After changes, run `<smallest relevant command>`.

<!--
Guidelines:
- Keep rules short, specific and actionable: name paths, helpers and commands.
- Only include rules for files matched by applyTo; project-wide rules belong
  in AGENTS.md.
- Don't repeat rules already enforced by ESLint, Prettier or TypeScript.
-->
