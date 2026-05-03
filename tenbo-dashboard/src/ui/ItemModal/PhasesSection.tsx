import type { Item, Phase, Status } from '../../types';
import { phaseProgress } from '../../api/lib/phases';

const STATUSES: Status[] = ['now', 'next', 'later', 'done'];

interface Props {
  item: Item;
  onPhaseStatusChange?: (phaseId: number, status: Status) => void;
}

export function PhasesSection({ item, onPhaseStatusChange }: Props) {
  const phases = item.phases ?? [];
  if (phases.length === 0) return null;
  const { done, total } = phaseProgress(phases);
  const firstPendingId = phases.find(p => p.status !== 'done')?.id;

  return (
    <details open>
      <summary>
        <strong>Phases</strong>
        <span style={{ fontSize: 11, color: 'var(--muted, #888)', marginLeft: 6 }}>
          · {done}/{total} done
        </span>
      </summary>
      <ol style={{ listStyle: 'none', paddingLeft: 0, marginTop: 6 }}>
        {phases.map((p) => {
          const isNext = p.id === firstPendingId;
          const isDone = p.status === 'done';
          return (
            <li
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                padding: '4px 6px',
                borderLeft: `3px solid ${isNext ? 'var(--accent, #4F46E5)' : 'var(--border, #ddd)'}`,
                background: isNext ? 'var(--accent-soft, rgba(79,70,229,0.06))' : 'transparent',
                marginBottom: 2,
                opacity: isDone ? 0.7 : 1,
              }}
              data-phase-status={p.status}
            >
              <span style={{ fontSize: 11, color: 'var(--muted)', minWidth: 18 }}>p{p.id}</span>
              <span style={{ flex: 1, fontWeight: isNext ? 600 : 400, textDecoration: isDone ? 'line-through' : 'none' }}>
                {p.title}
              </span>
              {onPhaseStatusChange ? (
                <select
                  value={p.status}
                  onChange={e => onPhaseStatusChange(p.id, e.target.value as Status)}
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: 'var(--console-fog)',
                    background: 'var(--console-soot)',
                    border: '1px solid var(--console-mist)',
                    borderRadius: 'var(--r-sm, 4px)',
                    padding: '2px 20px 2px 8px',
                    cursor: 'pointer',
                    appearance: 'none',
                    WebkitAppearance: 'none',
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")`,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 6px center',
                  }}
                >
                  {STATUSES.map(s => <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>)}
                </select>
              ) : (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>{p.status.charAt(0).toUpperCase() + p.status.slice(1)}</span>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
