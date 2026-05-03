import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './ItemModal.module.css';

interface Props {
  notes?: string;
  itemId: string;
}

export function NotesSection({ notes }: Props) {
  if (!notes) return null;
  return (
    <>
      <h3 className={styles.sectionH}>Notes</h3>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{notes}</ReactMarkdown>
    </>
  );
}
