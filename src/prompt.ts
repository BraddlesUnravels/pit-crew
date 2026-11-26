import * as clack from "@clack/prompts";

export interface Choice {
  value: string;
  label?: string;
  hint?: string;
}

function requireInteractive(message: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(message);
  }
}

export async function confirm(message: string): Promise<boolean> {
  requireInteractive("Confirmation requires an interactive terminal; pass --yes to proceed.");
  const answer = await clack.confirm({ message, initialValue: false });
  return !clack.isCancel(answer) && answer;
}

export async function askText(message: string, nonInteractiveMessage: string): Promise<string | null> {
  requireInteractive(nonInteractiveMessage);
  const answer = await clack.text({
    message,
    validate: (value) => !value?.trim() ? "A commit message is required." : undefined,
  });
  return clack.isCancel(answer) ? null : answer.trim();
}

export async function chooseOne(
  message: string,
  options: Choice[],
  nonInteractiveMessage: string,
): Promise<string | null> {
  requireInteractive(nonInteractiveMessage);
  const answer = await clack.autocomplete<string>({ message, options, placeholder: "Type to search" });
  return clack.isCancel(answer) ? null : answer;
}

export async function chooseMany(
  message: string,
  options: Choice[],
  nonInteractiveMessage: string,
  required = true,
): Promise<string[] | null> {
  requireInteractive(nonInteractiveMessage);
  const answer = await clack.autocompleteMultiselect<string>({
    message,
    options,
    placeholder: "Type to search",
    required,
  });
  return clack.isCancel(answer) ? null : answer;
}
