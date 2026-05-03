import { useEffect, useRef } from 'react';
import styles from './DotGrid.module.css';

const COLS = 48;
const ROWS = 32;
const SPACING = 40;
const DOT_R = 1.5;
const ACTIVE_COUNT = 5;
const GLOW_DURATION = 5000;

const NS = 'http://www.w3.org/2000/svg';
const DOT_COLOR = '#36322e';   // --console-mist
const GLOW_COLOR = '#aba39e';  // --console-fog

export function DotGrid() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    // Respect prefers-reduced-motion
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) return;

    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    svg.setAttribute('viewBox', `0 0 ${COLS * SPACING} ${ROWS * SPACING}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    svg.style.cssText = 'position:absolute;inset:0;';

    const dots: SVGCircleElement[] = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', String(c * SPACING + SPACING / 2));
        dot.setAttribute('cy', String(r * SPACING + SPACING / 2));
        dot.setAttribute('r', String(DOT_R));
        dot.setAttribute('fill', DOT_COLOR);
        dot.setAttribute('opacity', '0.35');
        svg.appendChild(dot);
        dots.push(dot);
      }
    }

    container.appendChild(svg);

    let cancelled = false;

    function pickRandom(n: number): number[] {
      const indices = new Set<number>();
      while (indices.size < n) {
        indices.add(Math.floor(Math.random() * dots.length));
      }
      return [...indices];
    }

    function glowBatch() {
      if (cancelled) return;
      const chosen = pickRandom(ACTIVE_COUNT);

      const animations = chosen.map((idx) =>
        dots[idx].animate(
          [
            { fill: DOT_COLOR, opacity: 0.35 },
            { fill: GLOW_COLOR, opacity: 0.9, offset: 0.15 },
            { fill: GLOW_COLOR, opacity: 0.9, offset: 0.85 },
            { fill: DOT_COLOR, opacity: 0.35 },
          ],
          { duration: GLOW_DURATION, easing: 'ease-in-out' },
        ),
      );

      animations[animations.length - 1].onfinish = () => glowBatch();
    }

    glowBatch();

    return () => {
      cancelled = true;
      container.removeChild(svg);
    };
  }, []);

  return <div ref={ref} className={styles.backdrop} />;
}
