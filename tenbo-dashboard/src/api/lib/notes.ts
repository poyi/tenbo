export function normalizeNotes(notes: unknown): string {
  if (!notes) return '';
  if (typeof notes === 'string') return notes.trimEnd();
  if (Array.isArray(notes)) {
    return notes
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => entry.startsWith('- ') ? entry : `- ${entry}`)
      .join('\n');
  }
  return String(notes).trimEnd();
}
