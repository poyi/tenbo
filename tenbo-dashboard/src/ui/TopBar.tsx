import { RefreshCw } from 'lucide-react';
import type { Mode } from '../router/routes';
import styles from './TopBar.module.css';

interface Props {
  mode: Mode;
  onSelectMode: (m: Mode) => void;
  onReload: () => void;
}

export function TopBar({ mode, onSelectMode, onReload }: Props) {
  return (
    <header className={styles.header}>
      <strong className={styles.brand}>tenbo</strong>
      <nav className={styles.modeToggle} role="tablist" aria-label="Top-level view">
        <button
          role="tab"
          aria-selected={mode === 'roadmap'}
          className={mode === 'roadmap' ? styles.modeActive : styles.modeButton}
          onClick={() => onSelectMode('roadmap')}
        >
          Roadmap
        </button>
        <button
          role="tab"
          aria-selected={mode === 'health'}
          className={mode === 'health' ? styles.modeActive : styles.modeButton}
          onClick={() => onSelectMode('health')}
        >
          Health
        </button>
        <button
          role="tab"
          aria-selected={mode === 'docs'}
          className={mode === 'docs' ? styles.modeActive : styles.modeButton}
          onClick={() => onSelectMode('docs')}
        >
          Docs
        </button>
      </nav>
      <div className={styles.spacer} />
      <button onClick={onReload} className="outlined-button icon-text">
        <RefreshCw size={14} strokeWidth={1.75} />
        Reload
      </button>
    </header>
  );
}
