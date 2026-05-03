import styles from './ItemModal.module.css';

interface Props {
  links: string[];
  onOpenFile: (path: string) => void;
}

export function LinksSection({ links, onOpenFile }: Props) {
  if (links.length === 0) return null;
  return (
    <>
      <h3 className={styles.sectionH}>Linked spec/plan</h3>
      <ul>
        {links.map(p => {
          const archived = p.startsWith('.tenbo/specs/archive/');
          return (
            <li key={p}>
              <button onClick={() => onOpenFile(p)} className="link-button">{p}</button>
              {archived && <span style={{ marginLeft: 6, fontSize: '0.75em', opacity: 0.7 }}>(archived)</span>}
            </li>
          );
        })}
      </ul>
    </>
  );
}
