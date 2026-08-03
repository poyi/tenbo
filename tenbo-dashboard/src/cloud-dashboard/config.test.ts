import { describe, expect, it } from 'vitest';
import { resolveCloudDashboardMode } from './config';

describe('hosted dashboard public configuration', () => {
  it('stays local when hosted mode is not requested and rejects partial public config', () => {
    expect(resolveCloudDashboardMode({})).toEqual({ enabled: false });
    expect(resolveCloudDashboardMode({ VITE_TENBO_CLOUD_MODE: 'true', VITE_SUPABASE_URL: 'https://db.test' })).toEqual({
      enabled: true,
      error: 'Hosted Tenbo is missing public configuration: supabaseAnonKey, apiUrl',
    });
  });

  it('accepts only the browser-safe hosted settings', () => {
    const result = resolveCloudDashboardMode({
      VITE_TENBO_CLOUD_MODE: 'true',
      VITE_SUPABASE_URL: 'https://db.test',
      VITE_SUPABASE_ANON_KEY: 'public-key',
      VITE_TENBO_CLOUD_API_URL: 'https://api.test',
      VITE_TENBO_DEFAULT_PROJECT_ID: 'project-1',
      SUPABASE_SERVICE_ROLE_KEY: 'must-not-cross',
      TENBO_CLOUD_AGENT_TOKEN: 'must-not-cross',
    });
    expect(result).toEqual({ enabled: true, config: {
      supabaseUrl: 'https://db.test', supabaseAnonKey: 'public-key', apiUrl: 'https://api.test', defaultProjectId: 'project-1',
    } });
    expect(JSON.stringify(result)).not.toContain('must-not-cross');
  });
});
