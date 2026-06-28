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

export function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      if (args[i + 1] && !args[i + 1].startsWith('--')) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}
