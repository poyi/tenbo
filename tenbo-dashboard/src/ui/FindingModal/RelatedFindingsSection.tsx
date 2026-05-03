import type { Finding } from '../../api/lib/health/types';
import styles from './FindingModal.module.css';

interface Props {
  finding: Finding;
  allFindings: Finding[];
  onSelect: (f: Finding) => void;
}

export function RelatedFindingsSection({ finding, allFindings, onSelect }: Props) {
  const related = allFindings.filter(f =>
    f.id !== finding.id && (f.target === finding.target || (f.layer === finding.layer && f.signal === finding.signal))
  ).slice(0, 5);
  if (related.length === 0) return null;
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Related findings</h3>
      <ul className={styles.relatedList}>
        {related.map(f => (
          <li key={f.id}>
            <button type="button" className={styles.relatedLink} onClick={() => onSelect(f)}>
              {f.headline}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
