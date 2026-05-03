import styles from './ItemModal.module.css';

interface Props {
  value: string;
  initial: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}

export function TitleField({ value, initial, onChange, onCommit }: Props) {
  return (
    <h2 className={styles.titleHeader}>
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={e => { if (e.target.value !== initial) onCommit(e.target.value); }}
        className={styles.titleInput}
      />
    </h2>
  );
}
