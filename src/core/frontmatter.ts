import { RawPage, Settings } from "./types";

export function hugoDate(value: number | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function stripBrackets(value: string): string {
  return value.replace(/^\[\[(.*?)\]\]$/, "$1").trim();
}

export function asArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value
      .map((item) => stripBrackets(String(item)))
      .filter((item) => item !== "");
  }
  return String(value)
    .split(",")
    .map((item) => stripBrackets(item))
    .filter((item) => item !== "");
}

function parseTagList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const chunks = Array.isArray(value)
    ? value.map(String)
    : String(value).split(",");
  const tags: string[] = [];
  for (const chunk of chunks) {
    for (const token of chunk.split(/\s+/)) {
      const tag = stripBrackets(token).replace(/^#/, "").trim();
      if (tag !== "") tags.push(tag);
    }
  }
  return tags;
}

function yamlScalar(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  const text = String(value);
  if (text === "") return '""';
  if (/^(true|false|null|~|-?\d+(\.\d+)?)$/i.test(text)) {
    return JSON.stringify(text);
  }
  if (
    /[:#[\]{}&*!|>'"%@`,]/.test(text) ||
    text.trim() !== text ||
    text.includes("\n") ||
    /^[-?]/.test(text)
  ) {
    return JSON.stringify(text);
  }
  return text;
}

function serialize(pairs: [string, unknown][]): string {
  let out = "---";
  for (const [key, value] of pairs) {
    if (Array.isArray(value)) {
      out += `\n${key}:`;
      for (const item of value) out += `\n- ${yamlScalar(item)}`;
    } else {
      out += `\n${key}:${value === undefined || value === "" ? "" : ` ${yamlScalar(value)}`}`;
    }
  }
  return `${out}\n---`;
}

export interface FrontMatterOverrides {
  title?: string;
  tags?: string[];
  categories?: string[];
  date?: string;
  lastMod?: string;
}

export interface FrontMatterInput {
  page: RawPage;
  settings: Settings;
  overrides?: FrontMatterOverrides;
}

export function resolveTitle(page: RawPage, settings: Settings): string {
  const props = page.properties;
  if (typeof props["hugo-title"] === "string" && props["hugo-title"] !== "") {
    return props["hugo-title"];
  }
  if (typeof props["title"] === "string" && props["title"] !== "") {
    return props["title"];
  }
  return settings.leafTitle
    ? page.originalName.split("/").slice(-1)[0]
    : page.originalName;
}

export function buildFrontMatter(input: FrontMatterInput): string {
  const { page, settings } = input;
  const overrides = input.overrides ?? {};
  const props: Record<string, unknown> = { ...page.properties };

  const title = overrides.title ?? resolveTitle(page, settings);

  let tags = parseTagList(props["tags"]);
  if (overrides.tags) tags = tags.concat(overrides.tags);
  if (settings.tagsFromTitle) {
    page.originalName
      .split("/")
      .slice(0, -1)
      .forEach((tag) => tags.push(tag));
  }

  let categories = asArray(props["categories"] ?? props["category"]);
  if (overrides.categories) categories = categories.concat(overrides.categories);

  const date =
    overrides.date ??
    (props["date"] as string | undefined) ??
    (page.createdAt ? hugoDate(page.createdAt) : undefined);
  const lastMod =
    overrides.lastMod ??
    (props["lastmod"] as string | undefined) ??
    (page.updatedAt ? hugoDate(page.updatedAt) : undefined);

  for (const key of [
    "public",
    "filters",
    "hugo-title",
    "title",
    "tags",
    "categories",
    "category",
    "date",
    "lastmod",
  ]) {
    delete props[key];
  }

  const pairs: [string, unknown][] = [["title", title]];
  if (date) pairs.push(["date", date]);
  if (lastMod) pairs.push(["lastMod", lastMod]);
  pairs.push(["tags", tags]);
  pairs.push(["categories", categories]);
  if ("alias" in props) props["alias"] = asArray(props["alias"]);
  if ("aliases" in props) props["aliases"] = asArray(props["aliases"]);
  for (const [key, value] of Object.entries(props)) pairs.push([key, value]);

  return serialize(pairs);
}
