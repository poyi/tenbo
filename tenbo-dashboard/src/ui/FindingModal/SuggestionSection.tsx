import type { Finding } from '../../api/lib/health/types';
import styles from './FindingModal.module.css';

export function SuggestionSection({ finding }: { finding: Finding }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Suggestion</h3>
      <p className={styles.suggestionSummary}>{finding.suggestion.summary}</p>
      <p className={styles.suggestionRationale}>{finding.suggestion.rationale}</p>
      <p className={styles.actionKind}>action_kind: <code>{finding.suggestion.action_kind}</code></p>
    </section>
  );
}
