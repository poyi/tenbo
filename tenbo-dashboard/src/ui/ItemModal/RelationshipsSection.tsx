import type { Item, TenboState } from '../../types';
import { allItems, childrenOf, findItemById, relatedItems, type ItemRef } from '../../api/lib/relationships';
import styles from './ItemModal.module.css';

interface Props {
  item: Item;
  state: TenboState;
  onSelect: (ref: ItemRef) => void;
}

function Row({ itemRef, onSelect }: { itemRef: ItemRef; onSelect: (r: ItemRef) => void }) {
  const it = itemRef.item;
  return (
    <li>
      <button onClick={() => onSelect(itemRef)}>
        <span className={styles.relRowId}>{it.id}</span>
        <span className={styles.relRowTitle}>{it.title}</span>
        <span className={styles.relRowStatus} data-status={it.status}>{it.status}</span>
      </button>
    </li>
  );
}

export function RelationshipsSection({ item, state, onSelect }: Props) {
  const parent = item.spawned_from ? findItemById(state, item.spawned_from) : null;
  const flat = allItems(state).map((r) => r.item);
  const childItems = childrenOf(flat, item.id);
  // childrenOf returns Item[]; resolve back to ItemRef so we can navigate w/ scope.
  const children: ItemRef[] = childItems
    .map((c) => findItemById(state, c.id))
    .filter((r): r is ItemRef => r !== null);
  const peers = relatedItems(state, item);

  if (!parent && children.length === 0 && peers.length === 0) return null;

  return (
    <>
      <hr className="section-divider" />
      <h3 className={styles.sectionH}>Relationships</h3>

      {parent && (
        <div className={styles.relGroup}>
          <div className={styles.relGroupLabel}>Spawned from</div>
          <ul className={styles.relList}>
            <Row itemRef={parent} onSelect={onSelect} />
          </ul>
        </div>
      )}

      {children.length > 0 && (
        <div className={styles.relGroup}>
          <div className={styles.relGroupLabel}>Children</div>
          <ul className={styles.relList}>
            {children.map((c) => <Row key={c.item.id} itemRef={c} onSelect={onSelect} />)}
          </ul>
        </div>
      )}

      {peers.length > 0 && (
        <div className={styles.relGroup}>
          <div className={styles.relGroupLabel}>Related</div>
          <ul className={styles.relList}>
            {peers.map((p) => <Row key={p.item.id} itemRef={p} onSelect={onSelect} />)}
          </ul>
        </div>
      )}
    </>
  );
}
