import styles from './ItemModal.module.css';

interface Props {
  value: string;
  initial: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
}

export function DescriptionField({ value, initial, onChange, onCommit }: Props) {
  return (
    <>
      <label className={styles.descLabel}>Brief description</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        onBlur={e => { if (e.target.value !== initial) onCommit(e.target.value); }}
        className={styles.descTextarea}
      />
    </>
  );
}
