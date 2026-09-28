export interface RawPage {
  name: string;
  originalName: string;
  properties: Record<string, unknown>;
  journal: boolean;
  createdAt?: number;
  updatedAt?: number;
}

export interface RawBlock {
  content: string;
  level: number;
  marker?: string | null;
  properties?: Record<string, unknown>;
  children: RawBlock[];
  isMetadata?: boolean;
}

export interface Settings {
  linkFormat: string;
  bulletHandling: string;
  exportTasks: boolean;
  leafTitle: boolean;
  tagsFromTitle: boolean;
  assetsPath: string;
  pagesPath: string;
  journalPath: string;
}

export interface OutputFile {
  path: string;
  content: string;
}

export interface AssetRef {
  ref: string;
  outPath: string;
}
