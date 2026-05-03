import { Document, parseDocument, isMap, isSeq, YAMLMap, YAMLSeq } from 'yaml';

export function parseYaml(text: string): Document {
  return parseDocument(text, { keepSourceTokens: true });
}

export function stringifyYaml(doc: Document): string {
  return doc.toString({ lineWidth: 0, blockQuote: 'literal' });
}

function getSeq(doc: Document, key: string): YAMLSeq {
  const root = doc.contents;
  if (!isMap(root)) throw new Error('YAML root is not a map');
  const node = root.get(key, true);
  if (!isSeq(node)) throw new Error(`${key} is not a sequence`);
  return node;
}

function findById(seq: YAMLSeq, id: string): YAMLMap | null {
  for (const item of seq.items) {
    if (isMap(item) && item.get('id') === id) return item;
  }
  return null;
}

export function patchSeqItem(
  doc: Document,
  seqKey: string,
  id: string,
  patch: Record<string, unknown>
): void {
  const seq = getSeq(doc, seqKey);
  const node = findById(seq, id);
  if (!node) throw new Error(`item ${id} not found in ${seqKey}`);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) {
      node.delete(k);
    } else {
      node.set(k, v);
    }
  }
}

export function reorderSeqItems(doc: Document, seqKey: string, idsInOrder: string[]): void {
  const seq = getSeq(doc, seqKey);
  const byId = new Map<string, YAMLMap>();
  for (const item of seq.items) {
    if (isMap(item)) {
      const id = item.get('id') as string | undefined;
      if (id) byId.set(id, item);
    }
  }
  const reordered: YAMLMap[] = [];
  for (const id of idsInOrder) {
    const node = byId.get(id);
    if (!node) throw new Error(`item ${id} missing during reorder`);
    reordered.push(node);
  }
  seq.items = reordered;
}
