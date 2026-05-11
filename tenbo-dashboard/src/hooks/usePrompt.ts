import { useState, useCallback, useEffect, useRef } from 'react';

export function usePrompt() {
  const [toast, setToast] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const copy = useCallback(async (text: string, label: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    try {
      await navigator.clipboard.writeText(text);
      setToast(`${label} copied. Paste into your coding agent in the repo root.`);
    } catch {
      setToast('Copy failed. Select and copy manually.');
    }
    timerRef.current = setTimeout(() => setToast(null), 3000);
  }, []);

  return { copy, toast };
}
