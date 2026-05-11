import styles from './EmptyState.module.css';

export function EmptyState({ message }: { message: string }) {
  return (
    <div className={styles.empty}>
      <p>{message}</p>
      <p className={styles.hint}>Run <code>set up tenbo</code> with your coding agent, then reload.</p>
    </div>
  );
}
