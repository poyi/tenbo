import React, { lazy, Suspense } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { resolveCloudDashboardMode } from './cloud-dashboard/config';
import './styles.css';

const cloudMode = resolveCloudDashboardMode(import.meta.env);
const CloudDashboardApp = lazy(() => import('./cloud-dashboard/CloudDashboardApp').then((module) => ({ default: module.CloudDashboardApp })));

function RootApp() {
  if (!cloudMode.enabled) return <App />;
  if ('error' in cloudMode) {
    return <main style={{ padding: 32 }} data-tenbo-hosted-contract="x-094-v1"><h1>Tenbo cloud configuration error</h1><p role="alert">{cloudMode.error}</p></main>;
  }
  return <Suspense fallback={<main style={{ padding: 32 }}>Loading Tenbo cloud…</main>}><CloudDashboardApp config={cloudMode.config} /></Suspense>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <RootApp />
    </ErrorBoundary>
  </React.StrictMode>
);
