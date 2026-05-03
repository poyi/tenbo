import type { Finding } from '../../api/lib/health/types';
import styles from './FindingModal.module.css';

export function EvidenceSection({ finding }: { finding: Finding }) {
  const d = finding.details;
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>Evidence</h3>
      {d.kind === 'hotspot-files' && (
        <ul className={styles.kvList}>
          <li><span>LOC</span><span>{d.loc.toLocaleString()}</span></li>
          <li><span>Commits in last 30d</span><span>{d.commits_30d}</span></li>
          {d.top_functions.length > 0 && (
            <li><span>Top functions</span><span>{d.top_functions.map(fn => `${fn.name} (${fn.loc})`).join(', ')}</span></li>
          )}
        </ul>
      )}
      {d.kind === 'aging-todos' && (
        <ul className={styles.kvList}>
          <li><span>Line</span><span>{finding.target}:{d.line}</span></li>
          <li><span>Age</span><span>{d.age_days} days</span></li>
          <li><span>Author</span><span>{d.author}</span></li>
          <li><span>Commit</span><span><code>{d.commit_hash.slice(0, 7)}</code></span></li>
          <li><span>Text</span><span><code>{d.text}</code></span></li>
        </ul>
      )}
      {d.kind === 'doc-drift' && (
        <ul className={styles.kvList}>
          <li><span>Drift type</span><span>{d.drift_type}</span></li>
          <li><span>Doc</span><span>{d.doc_path}</span></li>
          <li><span>Affected files</span><span>{d.affected_files.join(', ')}</span></li>
        </ul>
      )}
      {d.kind === 'test-coverage' && (
        <ul className={styles.kvList}>
          <li><span>Suggested test path</span><span><code>{d.suggested_test_path}</code></span></li>
        </ul>
      )}
      {d.kind === 'architecture-compliance' && (
        <ul className={styles.kvList}>
          <li><span>Expected</span><span><code>{d.expected_path_pattern}</code></span></li>
          <li><span>Actual</span><span><code>{d.actual_path}</code></span></li>
          <li><span>Rule</span><span>{d.rule}</span></li>
        </ul>
      )}
      {(d.kind === 'dead-code' || d.kind === 'coupling' || d.kind === 'redundancy') && (
        <pre className={styles.rawDetails}>{JSON.stringify(d, null, 2)}</pre>
      )}
    </section>
  );
}
