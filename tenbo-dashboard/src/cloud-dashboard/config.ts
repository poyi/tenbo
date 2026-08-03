export interface CloudDashboardConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  apiUrl: string;
  defaultProjectId?: string;
}

export type CloudDashboardMode =
  | { enabled: false }
  | { enabled: true; config: CloudDashboardConfig }
  | { enabled: true; error: string };

type Env = Record<string, string | boolean | undefined>;

/** Resolve only Vite's explicitly public variables; privileged credentials are never accepted. */
export function resolveCloudDashboardMode(env: Env): CloudDashboardMode {
  const values = {
    supabaseUrl: text(env.VITE_SUPABASE_URL),
    supabaseAnonKey: text(env.VITE_SUPABASE_ANON_KEY),
    apiUrl: text(env.VITE_TENBO_CLOUD_API_URL),
  };
  const requested = env.VITE_TENBO_CLOUD_MODE === 'true' || Object.values(values).some(Boolean);
  if (!requested) return { enabled: false };
  const missing = Object.entries(values).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length > 0) {
    return { enabled: true, error: `Hosted Tenbo is missing public configuration: ${missing.join(', ')}` };
  }
  return {
    enabled: true,
    config: {
      supabaseUrl: values.supabaseUrl!,
      supabaseAnonKey: values.supabaseAnonKey!,
      apiUrl: values.apiUrl!,
      ...(text(env.VITE_TENBO_DEFAULT_PROJECT_ID) ? { defaultProjectId: text(env.VITE_TENBO_DEFAULT_PROJECT_ID) } : {}),
    },
  };
}

function text(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
