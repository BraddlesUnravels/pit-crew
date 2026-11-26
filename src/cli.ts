#!/usr/bin/env node
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fold } from "./commands/fold";
import { flatFold } from "./commands/flat-fold";
import { take } from "./commands/take";
import { undo } from "./commands/undo";
import { agentList } from "./commands/agent";
import { skillList } from "./commands/skill";
import { completeBaseBranches, zshCompletion } from "./completion";
import type { FoldOptions } from "./commands/fold";
import type { TakeOptions } from "./commands/take";
import type { UndoOptions } from "./commands/undo";

function usage(): string {
  return [
    "Usage:",
    "  pit fold [-a] [--edit] [--no-verify] [--yes]",
    "  pit fold -flat [--base <branch>] [--message <message>] [--yes]",
    "  pit take [branch] [--yes] [-- paths...]",
    "  pit undo [-1|-2|-3] [--force] [--yes]",
    "  pit undo --list",
    "  pit agent list",
    "  pit agent add <name> [--force] [--yes]",
    "  pit agent remove <name> [--force] [--yes]",
    "  pit skill list",
    "  pit skill add <name> [--force] [--yes]",
    "  pit skill remove <name> [--force] [--yes]",
    "  pit completion zsh",
    "",
    "Commands:",
    "  fold      Amend the last commit with selected working changes.",
    "  take      Copy files from another branch into the working tree (unstaged).",
    "  undo      Reverse the latest pit fold or take (-2/-3 for more; up to 3 are kept).",
    "  agent     List and manage Copilot agents.",
    "  skill     List and manage Copilot skills.",
    "  completion  Print shell completion setup.",
    "",
    "Options:",
    "  -a, --all       Also include untracked files.",
    "      --edit      Open the configured editor for the amended message.",
    "      --no-verify Skip Git's pre-commit and commit-msg hooks.",
    "      --yes       Skip confirmation prompts.",
    "  -flat, --flat   Squash committed branch history against a chosen base.",
    "      --base      Base branch for a flat fold.",
    "      --message   New commit message for a flat fold.",
    "  -1, -2, -3      Undo the 1 (default), 2 or 3 most recent pit actions.",
    "      --force     Undo even if the branch moved or taken files were edited;",
    "                  back up what would be lost.",
    "      --list      List recent pit actions.",
  ].join("\n");
}

function foldOptions(args: string[]): FoldOptions {
  const { values, positionals } = parseArgs({
    args,
    options: {
      all: { type: "boolean", short: "a" },
      edit: { type: "boolean" },
      "no-verify": { type: "boolean" },
      yes: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }
  return {
    all: values.all ?? false,
    edit: values.edit ?? false,
    noVerify: values["no-verify"] ?? false,
    yes: values.yes ?? false,
  };
}

function flatFoldOptions(args: string[]) {
  const { values, positionals } = parseArgs({
    args: args.map((arg) => arg === "-flat" ? "--flat" : arg),
    options: {
      flat: { type: "boolean" },
      base: { type: "string" },
      message: { type: "string" },
      yes: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }
  return { base: values.base, message: values.message, yes: values.yes ?? false };
}

function takeOptions(args: string[]): TakeOptions {
  const separator = args.indexOf("--");
  const before = separator < 0 ? args : args.slice(0, separator);
  const paths = separator < 0 ? [] : args.slice(separator + 1);
  const { values, positionals } = parseArgs({
    args: before,
    options: {
      yes: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1) {
    throw new Error(`Unexpected argument: ${positionals[1]}`);
  }
  const branch = positionals[0];
  if (paths.length > 0 && branch === undefined) {
    throw new Error("Paths require a branch: pit take <branch> -- <paths...>");
  }
  return { branch, paths, yes: values.yes ?? false };
}

function undoOptions(args: string[]): UndoOptions {
  const countArgs = args.filter((arg) => /^-\d+$/.test(arg));
  if (countArgs.length > 1) {
    throw new Error("Pass at most one of -1, -2 or -3.");
  }
  const count = countArgs[0] === undefined ? undefined : Number(countArgs[0].slice(1));
  if (count !== undefined && (count < 1 || count > 3)) {
    throw new Error(`Invalid option ${countArgs[0]}: pit can undo 1 to 3 actions at a time (max 3).`);
  }
  const { values, positionals } = parseArgs({
    args: args.filter((arg) => !/^-\d+$/.test(arg)),
    options: {
      force: { type: "boolean" },
      list: { type: "boolean" },
      yes: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) {
    throw new Error(`Unexpected argument: ${positionals[0]}`);
  }
  if (values.list && (values.force || values.yes || count !== undefined)) {
    throw new Error("--list cannot be combined with -N, --force or --yes.");
  }
  return {
    count: count ?? 1,
    force: values.force ?? false,
    list: values.list ?? false,
    yes: values.yes ?? false,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "--version" || command === "-v") {
    const { default: packageJson } = await import("../package.json", { with: { type: "json" } });
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  if (command === "completion") {
    if (args.length !== 1 || args[0] !== "zsh") {
      throw new Error("Usage: pit completion zsh");
    }
    process.stdout.write(zshCompletion);
    return;
  }
  if (command === "__complete-base") {
    if (args.length > 0) throw new Error("Unexpected completion arguments.");
    const branches = await completeBaseBranches(process.cwd());
    if (branches.length > 0) process.stdout.write(`${branches.join("\n")}\n`);
    return;
  }
  if (command === "agent" || command === "skill") {
    const [subcommand, ...subcommandArgs] = args;
    if (subcommand === "add" || subcommand === "remove") {
      throw new Error(`${command} ${subcommand} is not yet implemented.`);
    }
    if (subcommand !== "list" || subcommandArgs.length > 0) {
      throw new Error(`Usage: pit ${command} list|add|remove`);
    }
    if (command === "agent") {
      await agentList(process.cwd());
    } else {
      await skillList(process.cwd());
    }
    return;
  }
  if (command !== "fold" && command !== "take" && command !== "undo") {
    throw new Error(`Unknown command "${command}".\n\n${usage()}`);
  }

  const cwd = process.cwd();
  if (command === "fold") {
    if (args.includes("-flat") || args.includes("--flat")) {
      await flatFold(cwd, flatFoldOptions(args));
    } else {
      await fold(cwd, foldOptions(args));
    }
    return;
  }
  if (command === "take") {
    await take(cwd, takeOptions(args));
    return;
  }
  await undo(cwd, undoOptions(args));
}

if (process.argv[1] !== undefined
  && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`pit: ${message}\n`);
    process.exitCode = 1;
  });
}
