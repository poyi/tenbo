import { X } from 'lucide-react';
import type { Finding } from '../../api/lib/health/types';
import { HeadlineSection } from './HeadlineSection';
import { SuggestionSection } from './SuggestionSection';
import { EvidenceSection } from './EvidenceSection';
import { RelatedFindingsSection } from './RelatedFindingsSection';
import styles from './FindingModal.module.css';

interface Props {
  finding: Finding | null;
  allFindings: Finding[];
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onSelectFinding?: (f: Finding) => void;
}

export function FindingModal({ finding, allFindings, onClose, onOpenFile, onSelectFinding }: Props) {
  if (!finding) return null;
  return (
    <>
      <div onClick={onClose} className={`overlay-backdrop ${styles.backdrop}`} />
      <div className={styles.modal}>
        <button onClick={onClose} className="close-x" aria-label="Close">
          <X size={18} strokeWidth={1.75} />
        </button>
        <HeadlineSection finding={finding} />
        <button type="button" className={styles.targetLink} onClick={() => onOpenFile(finding.target)}>
          {finding.target}
        </button>
        <SuggestionSection finding={finding} />
        <EvidenceSection finding={finding} />
        {onSelectFinding && <RelatedFindingsSection finding={finding} allFindings={allFindings} onSelect={onSelectFinding} />}
      </div>
    </>
  );
}
