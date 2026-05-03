import { Component, ReactNode } from 'react';

interface State { error: Error | null }

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: unknown) {
    console.error('UI crashed:', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, fontFamily: 'system-ui' }}>
          <h2 style={{ color: 'var(--error)' }}>Something went wrong</h2>
          <pre style={{ background: 'var(--bg-2)', padding: 12, borderRadius: 4, overflow: 'auto', fontSize: 12 }}>
            {this.state.error.message}
          </pre>
          <button className="outlined-button" onClick={() => location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
