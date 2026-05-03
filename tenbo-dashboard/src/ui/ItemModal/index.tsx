import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { Item, Layer, Priority, RelatedDoc, Status, TenboState } from '../../types';
import { effectiveStatus } from '../../api/lib/phases';
import type { Route } from '../../router/routes';
import { TitleField } from './TitleField';
import { DescriptionField } from './DescriptionField';
import { StatusLayerControls } from './StatusLayerControls';
import { NotesSection } from './NotesSection';
import { LinksSection } from './LinksSection';
import { RelatedSection } from './RelatedSection';
import { RelationshipsSection } from './RelationshipsSection';
import { EnrichmentSections } from './EnrichmentSections';
import { PhasesSection } from './PhasesSection';
import styles from './ItemModal.module.css';

interface Props {
  item: Item | null;
  scopeId: string;
  layers: Layer[];
  relatedDocs: RelatedDoc[];
  state?: TenboState;
  onClose: () => void;
  onPatch: (patch: Partial<Item>) => Promise<void>;
  onOpenFile: (path: string) => void;
  onPromoteRelated: (path: string) => Promise<void>;
  onSelectItem?: (scopeId: string | undefined, item: Item) => void;
  navigate: (r: Route) => void;
}

function hasEnrichment(item: Item): boolean {
  return Boolean(item.affects?.length || item.done_when?.length || item.risks?.length || item.type || item.files_to_read?.length);
}

export function ItemModal({ item, scopeId, layers, relatedDocs, state, onClose, onPatch, onOpenFile, onPromoteRelated, onSelectItem, navigate }: Props) {
  const [draft, setDraft] = useState(item);
  useEffect(() => setDraft(item), [item]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (!item || !draft) return null;
  const related = relatedDocs.filter(d => d.itemId === item.id);
  const explicit = item.links ?? [];

  const save = (patch: Partial<Item>) => onPatch(patch);

  return (
    <>
      <div onClick={onClose} className={`overlay-backdrop ${styles.backdrop}`} />
      <div className={styles.modal}>
        <button onClick={onClose} className="close-x" aria-label="Close">
          <X size={18} strokeWidth={1.75} />
        </button>
        <div className={styles.chip}>{item.id} · {item.layer ?? (item.layers || []).join(', ')}</div>

        <TitleField
          value={draft.title}
          initial={item.title}
          onChange={(v) => setDraft({ ...draft, title: v })}
          onCommit={(v) => save({ title: v })}
        />

        <DescriptionField
          value={draft.description}
          initial={item.description}
          onChange={(v) => setDraft({ ...draft, description: v })}
          onCommit={(v) => save({ description: v })}
        />

        <StatusLayerControls
          status={effectiveStatus(draft)}
          layer={draft.layer ?? ''}
          layers={layers}
          priority={draft.priority}
          statusDisabled={!!draft.phases?.length}
          onStatusChange={(s: Status) => { setDraft({ ...draft, status: s }); save({ status: s }); }}
          onLayerChange={(l) => { setDraft({ ...draft, layer: l }); save({ layer: l }); }}
          onPriorityChange={(p: Priority | undefined) => { setDraft({ ...draft, priority: p }); save({ priority: p }); }}
        />

        {(draft.phases?.length ?? 0) > 0 && <hr className="section-divider" />}
        <PhasesSection
          item={draft}
          onPhaseStatusChange={(phaseId, status) => {
            const updatedPhases = (draft.phases ?? []).map(p =>
              p.id === phaseId ? { ...p, status } : p
            );
            setDraft({ ...draft, phases: updatedPhases });
            save({ phases: updatedPhases });
          }}
        />

        {item.notes && <hr className="section-divider" />}
        <NotesSection notes={item.notes} itemId={item.id} />

        {(explicit.length > 0 || related.length > 0) && <hr className="section-divider" />}
        <LinksSection links={explicit} onOpenFile={onOpenFile} />
        <RelatedSection related={related} onOpenFile={onOpenFile} onPromote={onPromoteRelated} />

        {state && onSelectItem && (
          <RelationshipsSection
            item={item}
            state={state}
            onSelect={(ref) => onSelectItem(ref.scopeId, ref.item)}
          />
        )}

        {hasEnrichment(item) && <hr className="section-divider" />}
        <EnrichmentSections item={item} scopeId={scopeId} navigate={(r) => { onClose(); navigate(r); }} />
      </div>
    </>
  );
}
