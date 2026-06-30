export interface SourceIndexInputMap {
  [path: string]: string;
}

export type SourceFileKind = 'source' | 'test' | 'docs' | 'config' | 'script' | 'spec' | 'unknown';

export interface SourceIndexFile {
  path: string;
  scope?: string;
  layers: string[];
  kind: SourceFileKind;
  tokens: string[];
  exports: string[];
  imports: string[];
  imported_by: string[];
  symbols: string[];
  line_count: number;
}

export interface SourceIndexLayer {
  scope: string;
  layer: string;
  files: string[];
  public_entrypoints: string[];
  tokens: string[];
}

export interface SourceIndex {
  schema_version: number;
  generated_at: string;
  repo_root_fingerprint: string;
  inputs: SourceIndexInputMap;
  files: SourceIndexFile[];
  layers: SourceIndexLayer[];
  warnings: string[];
}

export type IndexFreshnessStatus = 'fresh' | 'missing' | 'stale' | 'corrupt' | 'incompatible';

export interface IndexFreshness {
  status: IndexFreshnessStatus;
  path: string;
  message: string;
  current_inputs: SourceIndexInputMap;
  changed_inputs: string[];
}
