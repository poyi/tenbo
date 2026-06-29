export const ITEM_COMMANDS = [
  {
    name: 'show',
    usage: 'tenbo-dashboard item show <id> [--json]',
    summary: 'Show the full roadmap item.',
  },
  {
    name: 'brief',
    usage: 'tenbo-dashboard item brief <id> [--json]',
    summary: 'Print compact execution context for one item.',
  },
  {
    name: 'handoff',
    usage: 'tenbo-dashboard item handoff <id> [--json]',
    summary: 'Generate a copy/paste handoff prompt.',
  },
  {
    name: 'set-status',
    usage: 'tenbo-dashboard item set-status <id> <now|next|later|done|dropped> [--json]',
    summary: 'Set the roadmap status.',
  },
  {
    name: 'add-note',
    usage: 'tenbo-dashboard item add-note <id> "<note>" [--json]',
    summary: 'Append a dated item note.',
  },
  {
    name: 'verify',
    usage: 'tenbo-dashboard item verify <id> --check [--json]',
    summary: 'Check whether recorded evidence matches completion state.',
    details: [
      'tenbo-dashboard item verify <id> --status <not_required|pending_live|verified|failed>',
      '                                  [--evidence "<text>"] [--note "<text>"] [--json]',
    ],
  },
  {
    name: 'doc-update',
    usage: 'tenbo-dashboard item doc-update <id> --date <today|YYYY-MM-DD> [--json]',
    summary: 'Record documentation freshness for an item.',
    details: [
      'tenbo-dashboard item doc-update <id> --skipped --reason "<text>" [--json]',
    ],
  },
  {
    name: 'complete',
    usage: 'tenbo-dashboard item complete <id> --evidence "<text>" [--doc-update today|YYYY-MM-DD] [--commit <sha>] [--verification <status>] [--json]',
    summary: 'Complete status, verification, docs, and optional commit link in one transaction.',
  },
  {
    name: 'link-commit',
    usage: 'tenbo-dashboard item link-commit <id> <sha> [--json]',
    summary: 'Attach a commit link to an item.',
  },
];

const commandByName = new Map(ITEM_COMMANDS.map((command) => [command.name, command]));

export function findItemCommand(name) {
  return commandByName.get(name);
}

export function formatItemHelp() {
  const maxNameLength = Math.max(...ITEM_COMMANDS.map((command) => command.name.length));
  const commandLines = ITEM_COMMANDS.flatMap((command) => [
    `  ${command.name.padEnd(maxNameLength)}  ${command.summary}`,
    `  ${' '.repeat(maxNameLength)}  ${command.usage}`,
  ]);

  return [
    'Usage: tenbo-dashboard item <command> <id> [options]',
    '',
    'Commands:',
    ...commandLines,
    '',
    'Run tenbo-dashboard item <command> --help for command-specific usage.',
    '',
  ].join('\n');
}

export function formatItemCommandHelp(name) {
  const command = findItemCommand(name);
  if (!command) return undefined;
  return [
    `Usage: ${command.usage}`,
    '',
    command.summary,
    ...(command.details?.length ? ['', 'Additional forms:', ...command.details.map((line) => `  ${line}`)] : []),
    '',
  ].join('\n');
}

export function topLevelItemHelpLines() {
  return ITEM_COMMANDS.flatMap((command) => {
    const lines = [`  ${command.usage}`];
    if (command.details?.length) lines.push(...command.details.map((line) => `  ${line}`));
    return lines;
  });
}
