import type { RelatedDoc } from '../../types';
import styles from './ItemModal.module.css';

interface Props {
  related: RelatedDoc[];
  onOpenFile: (path: string) => void;
  onPromote: (path: string) => void;
}

export function RelatedSection({ related, onOpenFile, onPromote }: Props) {
  if (related.length === 0) return null;
  return (
    <>
      <h3 className={styles.sectionH}>Related docs</h3>
      <ul>
        {related.map(d => (
          <li key={d.path}>
            <button onClick={() => onOpenFile(d.path)} className="link-button">{d.title || d.path}</button>
            {' '}
            <button onClick={() => onPromote(d.path)} className={styles.promote}>promote</button>
          </li>
        ))}
      </ul>
    </>
  );
}
