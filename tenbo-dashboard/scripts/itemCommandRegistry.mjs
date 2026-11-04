export const ITEM_COMMANDS = [
  {
    name: 'allocate-id',
    usage: 'tenbo-dashboard item allocate-id <prefix> [--json]',
    summary: 'Atomically allocate and reserve the next item id.',
  },
  {
    name: 'create',
    usage: 'tenbo-dashboard item create <id> --scope <scope> --title "<title>" --description "<description>" [--status later] [--layer <id>] [--type <type>] [--priority <p0-p3>] [--goal <gN>] [--json]',
    summary: 'Create a roadmap item through the typed backend.',
  },
  {
    name: 'update',
    usage: 'tenbo-dashboard item update <id> --patch \'<json>\' [--expected-version <version>] [--json]',
    summary: 'Update rich roadmap fields with an optional version guard.',
  },
  {
    name: 'reorder',
    usage: 'tenbo-dashboard item reorder <scope> --ids <id1,id2,...> [--expected-version <list-version>] [--json]',
    summary: 'Atomically reorder every active item in a scope.',
  },
  {
    name: 'archive',
    usage: 'tenbo-dashboard item archive <id> [--expected-version <version>] [--json]',
    summary: 'Move an item into its roadmap archive.',
  },
  {
    name: 'reopen',
    usage: 'tenbo-dashboard item reopen <id> [--status now|next|later] [--expected-version <version>] [--json]',
    summary: 'Restore an archived item or reopen a completed item.',
  },
  {
    name: 'claim',
    usage: 'tenbo-dashboard item claim <id> [--owner <actor>] [--lease <seconds>] [--json]',
    summary: 'Claim an item and receive a fencing token.',
  },
  {
    name: 'renew-claim',
    usage: 'tenbo-dashboard item renew-claim <id> --fencing-token <n> [--owner <actor>] [--lease <seconds>] [--json]',
    summary: 'Renew the current fenced item claim.',
  },
  {
    name: 'release-claim',
    usage: 'tenbo-dashboard item release-claim <id> --fencing-token <n> [--owner <actor>] [--json]',
    summary: 'Release the current fenced item claim.',
  },
  {
    name: 'dependency-add',
    usage: 'tenbo-dashboard item dependency-add <id> <prerequisite-id> [--expected-version <version>] [--fencing-token <n>] [--json]',
    summary: 'Add an executable prerequisite using the canonical dependency graph.',
  },
  {
    name: 'dependency-remove',
    usage: 'tenbo-dashboard item dependency-remove <id> <prerequisite-id> [--expected-version <version>] [--fencing-token <n>] [--json]',
    summary: 'Remove an executable prerequisite using the canonical dependency graph.',
  },
  {
    name: 'document-create',
    usage: 'tenbo-dashboard item document-create <item-id> --kind <spec|workpad|handoff> [--slug <slug>] (--content "<markdown>"|--content-file <path>) --fencing-token <n> [--json]',
    summary: 'Create and attach a planning document.',
  },
  {
    name: 'document-update',
    usage: 'tenbo-dashboard item document-update <document-id> (--content "<markdown>"|--content-file <path>) --expected-version <version> --fencing-token <n> [--json]',
    summary: 'Replace a planning document through version and claim-fence guards.',
  },
  {
    name: 'document-section-replace',
    usage: 'tenbo-dashboard item document-section-replace <document-id> --heading "<heading>" (--content "<markdown>"|--content-file <path>) --section-hash <sha256> --expected-version <version> --fencing-token <n> [--json]',
    summary: 'Replace one uniquely named Markdown section atomically.',
  },
  {
    name: 'document-section-append',
    usage: 'tenbo-dashboard item document-section-append <document-id> --heading "<heading>" (--content "<markdown>"|--content-file <path>) --expected-version <version> --fencing-token <n> [--json]',
    summary: 'Append one new uniquely named Markdown section atomically.',
  },
  {
    name: 'document-versions',
    usage: 'tenbo-dashboard item document-versions <document-id> [--json]',
    summary: 'List immutable planning-document versions.',
  },
  {
    name: 'document-diff',
    usage: 'tenbo-dashboard item document-diff <document-id> --from-version <version> --to-version <version> [--json]',
    summary: 'Compare two immutable planning-document versions.',
  },
  {
    name: 'document-version-restore',
    usage: 'tenbo-dashboard item document-version-restore <document-id> --version <version> --expected-version <current-version> --fencing-token <n> [--json]',
    summary: 'Restore an older version as a new immutable current version.',
  },
  {
    name: 'document-archive',
    usage: 'tenbo-dashboard item document-archive <document-id> --expected-version <version> --fencing-token <n> [--json]',
    summary: 'Archive a spec, workpad, or handoff.',
  },
  {
    name: 'document-restore',
    usage: 'tenbo-dashboard item document-restore <document-id> --expected-version <version> --fencing-token <n> [--json]',
    summary: 'Restore an archived planning document.',
  },
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
    usage: 'tenbo-dashboard item set-status <id> <now|next|later|done|dropped> [--expected-version <version> (cloud only)] [--json]',
    summary: 'Set the roadmap status.',
  },
  {
    name: 'add-note',
    usage: 'tenbo-dashboard item add-note <id> "<note>" [--expected-version <version> (cloud only)] [--json]',
    summary: 'Append a dated item note.',
  },
  {
    name: 'verify',
    usage: 'tenbo-dashboard item verify <id> --check [--expected-version <version> (cloud only)] [--json]',
    summary: 'Check whether recorded evidence matches completion state.',
    details: [
      'When done_when has structured `check:` entries, --check EXECUTES each',
      '(strict timeout, TERM then KILL) and records pass/fail evidence on the',
      "item's verification. Entries without a check are reported \"manual\"",
      '(not auto-passed). Execution only ever happens on this explicit call.',
      'tenbo-dashboard item verify <id> --status <not_required|pending_live|verified|failed>',
      '                                  [--evidence "<text>"] [--note "<text>"] [--expected-version <version> (cloud only)] [--json]',
    ],
  },
  {
    name: 'doc-update',
    usage: 'tenbo-dashboard item doc-update <id> --date <today|YYYY-MM-DD> [--expected-version <version> (cloud only)] [--json]',
    summary: 'Record documentation freshness for an item.',
    details: [
      'tenbo-dashboard item doc-update <id> --skipped --reason "<text>" [--expected-version <version> (cloud only)] [--json]',
    ],
  },
  {
    name: 'complete',
    usage: 'tenbo-dashboard item complete <id> --evidence "<text>" [--doc-update today|YYYY-MM-DD] [--commit <sha>] [--verification <status>] [--expected-version <version> (cloud only)] [--json]',
    summary: 'Complete status, verification, docs, and optional commit link in one transaction.',
  },
  {
    name: 'link-commit',
    usage: 'tenbo-dashboard item link-commit <id> <sha> [--expected-version <version> (cloud only)] [--json]',
    summary: 'Attach a commit link to an item.',
  },
  {
    name: 'history',
    usage: 'tenbo-dashboard item history <id> [--json]',
    summary: 'Show who changed this item and when, from the mutation journal.',
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
