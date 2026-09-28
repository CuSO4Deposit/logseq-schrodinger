import { Settings } from "./types";

export const LINK_FORMATS = ["[[Logseq Format]]", "Without brackets"];

export const BULLET_HANDLING = ["Convert Bullets", "Remove All Bullets"];

export const defaultSettings: Settings = {
  linkFormat: LINK_FORMATS[0],
  bulletHandling: BULLET_HANDLING[0],
  exportTasks: false,
  leafTitle: false,
  tagsFromTitle: false,
  assetsPath: "assets",
  pagesPath: "content/pages",
  journalPath: "content/posts",
};

export function mergeSettings(
  base: Settings,
  overrides: Partial<Settings> | undefined,
): Settings {
  const merged: Settings = { ...base };
  if (!overrides) return merged;
  for (const key of Object.keys(base) as (keyof Settings)[]) {
    const value = overrides[key];
    if (value !== undefined) {
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}
