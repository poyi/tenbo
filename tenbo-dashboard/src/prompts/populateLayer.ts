export function populateLayerPrompt(
  target: 'intent' | 'codeMap' | 'readme',
  scopeId: string,
  layerId: string,
): string {
  const file = target === 'intent' ? 'intent.md' : target === 'codeMap' ? 'code-map.md' : 'README.md';
  return [
    `Run the tenbo populate-architecture behavior for scope \`${scopeId}\`, layer \`${layerId}\`.`,
    `Focus on \`${file}\`.`,
    `Use the universal prompting rule: ask, don't guess.`,
  ].join('\n');
}
