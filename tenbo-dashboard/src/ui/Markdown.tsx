import { type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import styles from './Markdown.module.css';
import { formatRoute } from '../router/routes';

const LAYER_LINK_RE = /^(?:\.\/)?scopes\/([^/]+)\/layers\/([^/]+?)(?:\.md)?$/;

function rewriteLayerLinks({ href, children, ...rest }: ComponentProps<'a'>) {
  if (typeof href === 'string') {
    const m = LAYER_LINK_RE.exec(href);
    if (m) {
      const target = formatRoute({ kind: 'docs-layer', scopeId: m[1], layerId: m[2], tab: 'overview' });
      return <a href={target} {...rest}>{children}</a>;
    }
  }
  return <a href={href} {...rest}>{children}</a>;
}

export function Markdown({ source }: { source: string }) {
  if (!source.trim()) return <div className={styles.empty}>This document is empty.</div>;
  return (
    <div className={styles.root}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ a: rewriteLayerLinks }}>{source}</ReactMarkdown>
    </div>
  );
}
