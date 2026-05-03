import { useEffect, useState, useCallback } from 'react';
import { parseHash, formatRoute, type Route } from './routes.js';

export function useHashRoute(): { route: Route; navigate: (r: Route) => void } {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const navigate = useCallback((r: Route) => {
    window.location.hash = formatRoute(r);
  }, []);
  return { route, navigate };
}
