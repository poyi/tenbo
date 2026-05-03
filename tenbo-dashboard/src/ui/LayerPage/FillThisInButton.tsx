import { usePrompt } from '../../hooks/usePrompt';

export function FillThisInButton({ label, prompt }: { label: string; prompt: string }) {
  const { copy, toast } = usePrompt();
  return (
    <>
      <button onClick={() => copy(prompt, 'Prompt')}>{label}</button>
      {toast && <div role="status">{toast}</div>}
    </>
  );
}
