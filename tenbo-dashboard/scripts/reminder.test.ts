import { describe, it, expect } from 'vitest';
import { renderSessionReminder, runReminderCli } from './reminder';

describe('context reminders', () => {
  it('renders a short advisory reminder', () => {
    const reminder = renderSessionReminder();

    expect(reminder).toContain('tenbo-dashboard context feature');
    expect(reminder).toContain('advisory');
    expect(reminder).toContain('does not block');
    expect(reminder.length).toBeLessThan(500);
  });

  it('prints reminder text as JSON', () => {
    const result = runReminderCli(['print', '--json']);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      mode: 'print',
      reminder: expect.stringContaining('tenbo-dashboard context feature'),
    });
  });

  it('rejects unknown reminder commands', () => {
    const result = runReminderCli(['install', '--json']);

    expect(result.exitCode).toBe(2);
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: 'invalid_args',
    });
  });
});
