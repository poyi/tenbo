export interface ItemCommandDefinition {
  name: string;
  usage: string;
  summary: string;
  details?: string[];
}

export const ITEM_COMMANDS: ItemCommandDefinition[];
export function findItemCommand(name: string): ItemCommandDefinition | undefined;
export function formatItemHelp(): string;
export function formatItemCommandHelp(name: string): string | undefined;
export function topLevelItemHelpLines(): string[];
