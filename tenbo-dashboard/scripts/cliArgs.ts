export function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function readOption(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  return args[i + 1];
}

export function readRepeated(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) out.push(args[i + 1]);
  }
  return out;
}

export interface PositionalArgsOptions {
  /**
   * Flags that consume the token immediately after them (e.g. `--status
   * done`). Any `--flag` NOT in this set is treated as boolean/valueless
   * (e.g. `--json`, `--check`) — the token that follows it is left in place
   * as a positional, regardless of where the flag appears among the args.
   * Defaults to no value-taking flags, so bare `positionalArgs(args)` never
   * consumes a token after a `--flag`.
   */
  valueFlags?: readonly string[];
}

export function positionalArgs(args: string[], options: PositionalArgsOptions = {}): string[] {
  const valueFlags = new Set(options.valueFlags ?? []);
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (valueFlags.has(arg) && i + 1 < args.length) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}
