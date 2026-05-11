import { useState, useMemo } from 'react';
import { Markdown } from '../../Markdown';
import type { TenboState, DecisionRecord } from '../../../types';
import styles from './DecisionsTab.module.css';

function statusOf(d: DecisionRecord): 'accepted' | 'superseded' | 'unknown' {
  const s = d.frontmatter.status;
  if (s === 'accepted' || s === 'superseded') return s;
  return 'unknown';
}

function titleOf(d: DecisionRecord): string {
  const t = d.frontmatter.title;
  if (typeof t === 'string' && t.trim()) return t;
  return d.slug;
}

function dateOf(d: DecisionRecord): string | null {
  const v = d.frontmatter.date;
  if (typeof v === 'string' && v.trim()) return v;
  if (v && typeof v === 'object' && Object.prototype.toString.call(v) === '[object Date]') {
    return (v as Date).toISOString().slice(0, 10);
  }
  return null;
}

export function DecisionsTab({ state }: { state: TenboState }) {
  const decisions = state.decisions;

  const sorted = useMemo(() => {
    if (!decisions) return [];
    const list = Object.values(decisions);
    // Sort: accepted before superseded, then by date desc, then by slug.
    list.sort((a, b) => {
      const sa = statusOf(a);
      const sb = statusOf(b);
      const supA = sa === 'superseded' ? 1 : 0;
      const supB = sb === 'superseded' ? 1 : 0;
      if (supA !== supB) return supA - supB;
      const da = dateOf(a) ?? '';
      const db = dateOf(b) ?? '';
      if (da !== db) return db.localeCompare(da);
      return a.slug.localeCompare(b.slug);
    });
    return list;
  }, [decisions]);

  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const selected = selectedSlug ? decisions?.[selectedSlug] ?? null : sorted[0] ?? null;
  const activeSlug = selected?.slug ?? null;

  if (!decisions) {
    return (
      <div className={styles.emptyOuter}>
        <h2 className={styles.emptyHeading}>No decision records yet</h2>
        <p className={styles.emptyBody}>
          Decision records capture project-level choices that a future audit
          would otherwise re-suggest without context — &ldquo;we considered X, declined
          because Y.&rdquo; They live in <code>.tenbo/decisions/&lt;slug&gt;.md</code>.
        </p>
        <p className={styles.emptyBody}>
          Create a Markdown file with frontmatter plus Context, Decision,
          Consequences, and When to revisit sections.
        </p>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className={styles.emptyOuter}>
        <p className={styles.emptyBody}>
          The <code>.tenbo/decisions/</code> directory exists but contains no
          records yet.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.layout}>
      <aside className={styles.list} aria-label="Decision records">
        {sorted.map((d) => {
          const status = statusOf(d);
          const date = dateOf(d);
          const isActive = d.slug === activeSlug;
          return (
            <button
              key={d.slug}
              type="button"
              className={`${styles.listItem} ${isActive ? styles.listItemActive : ''} ${status === 'superseded' ? styles.listItemSuperseded : ''}`}
              onClick={() => setSelectedSlug(d.slug)}
              aria-pressed={isActive}
            >
              <div className={styles.itemTitleRow}>
                <span className={styles.itemTitle}>{titleOf(d)}</span>
                <span
                  className={`${styles.badge} ${
                    status === 'accepted' ? styles.badgeAccepted :
                    status === 'superseded' ? styles.badgeSuperseded :
                    styles.badgeUnknown
                  }`}
                >
                  {status === 'unknown' ? '?' : status}
                </span>
              </div>
              <div className={styles.itemMeta}>
                <span className={styles.itemSlug}>{d.slug}</span>
                {date ? (
                  <span className={styles.itemDate}>{date}</span>
                ) : (
                  <span className={styles.itemDateMissing} title="Missing date in frontmatter">
                    no date
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </aside>

      <section className={styles.detail}>
        {selected ? (
          <DecisionDetail decision={selected} all={decisions} onSelect={setSelectedSlug} />
        ) : (
          <p>Select a decision to view its body.</p>
        )}
      </section>
    </div>
  );
}

function DecisionDetail({
  decision,
  all,
  onSelect,
}: {
  decision: DecisionRecord;
  all: Record<string, DecisionRecord>;
  onSelect: (slug: string) => void;
}) {
  const status = statusOf(decision);
  const date = dateOf(decision);
  const supersededBy = decision.frontmatter.superseded_by;
  const successor = typeof supersededBy === 'string' ? all[supersededBy] : undefined;

  return (
    <article>
      <header className={styles.detailHeader}>
        <div className={styles.detailTitleRow}>
          <h1 className={styles.detailTitle}>{titleOf(decision)}</h1>
          <span
            className={`${styles.badge} ${
              status === 'accepted' ? styles.badgeAccepted :
              status === 'superseded' ? styles.badgeSuperseded :
              styles.badgeUnknown
            }`}
          >
            {status === 'unknown' ? '?' : status}
          </span>
        </div>
        <div className={styles.detailMeta}>
          <span>{decision.path}</span>
          {date ? <span>{date}</span> : <span className={styles.warn}>no date in frontmatter</span>}
        </div>
        {status === 'superseded' && (
          <div className={styles.supersededBanner}>
            Superseded
            {typeof supersededBy === 'string' ? (
              <>
                {' by '}
                {successor ? (
                  <button
                    type="button"
                    className={styles.successorLink}
                    onClick={() => onSelect(successor.slug)}
                  >
                    {titleOf(successor)} ({successor.slug})
                  </button>
                ) : (
                  <code>{supersededBy}</code>
                )}
                {!successor && <span className={styles.warn}> — successor not found</span>}
              </>
            ) : (
              <span className={styles.warn}> — no superseded_by reference</span>
            )}
          </div>
        )}
      </header>
      <Markdown source={decision.body} />
    </article>
  );
}
