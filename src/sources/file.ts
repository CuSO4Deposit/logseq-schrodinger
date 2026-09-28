import * as fs from "node:fs";
import * as path from "node:path";
import { RawBlock, RawPage } from "../core/types";

const PROP_RE = /^([A-Za-z0-9_!?@#$%^&*+./-]+)::\s?(.*)$/;
const BLOCK_RE = /^([ \t]*)-(?:[ \t](.*))?$/;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface FileGraphSource {
  pages: RawPage[];
  blocksByPage: Map<string, RawBlock[]>;
  blockRefs: Map<string, string>;
  graphDir: string;
}

function readIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function detectNameFormat(graphDir: string): string {
  const config = readIfExists(path.join(graphDir, "logseq", "config.edn"));
  if (!config) return "triple-lowbar";
  const match = /:file\/name-format\s+(:[A-Za-z0-9_-]+)/.exec(config);
  return match ? match[1].slice(1) : "triple-lowbar";
}

function decodePageName(base: string, nameFormat: string): string {
  let name = base;
  if (nameFormat === "triple-lowbar") name = name.replace(/___/g, "/");
  try {
    name = name
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    // keep the raw name when it is not valid percent-encoding
  }
  return name;
}

function parseValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function indentColumns(whitespace: string): number {
  let columns = 0;
  for (const char of whitespace) columns += char === "\t" ? 2 : 1;
  return columns;
}

function fenceToken(text: string): string | null {
  const match = /^\s*(`{3,}|~{3,})/.exec(text);
  return match ? match[1] : null;
}

function stripContinuation(line: string, baseColumns: number): string {
  let columns = 0;
  let index = 0;
  while (index < line.length && (line[index] === " " || line[index] === "\t")) {
    const width = line[index] === "\t" ? 2 : 1;
    if (columns + width > baseColumns + 2) break;
    columns += width;
    index += 1;
  }
  return line.slice(index);
}

function parsePropertiesAndBlocks(
  text: string,
): { properties: Record<string, unknown>; blocks: RawBlock[] } {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  const properties: Record<string, unknown> = {};

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const property = PROP_RE.exec(line);
    if (property) {
      properties[property[1]] = parseValue(property[2]);
      index += 1;
      continue;
    }
    if (line.trim() === "") {
      index += 1;
      continue;
    }
    break;
  }

  const blocks: RawBlock[] = [];
  const stack: RawBlock[] = [];
  let current: RawBlock | undefined;
  let currentColumns = 0;
  let fence: string | null = null;

  const pushBlock = (block: RawBlock) => {
    while (stack.length > 0 && stack[stack.length - 1].level >= block.level) {
      stack.pop();
    }
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(block);
    } else {
      blocks.push(block);
    }
    stack.push(block);
    current = block;
  };

  for (; index < lines.length; index += 1) {
    const line = lines[index];

    if (fence) {
      if (current) current.content += `\n${stripContinuation(line, currentColumns)}`;
      if (line.trim().startsWith(fence)) fence = null;
      continue;
    }

    const blockMatch = BLOCK_RE.exec(line);
    if (blockMatch) {
      const columns = indentColumns(blockMatch[1]);
      const block: RawBlock = {
        content: blockMatch[2] ?? "",
        level: Math.floor(columns / 2) + 1,
        children: [],
        properties: {},
      };
      pushBlock(block);
      currentColumns = columns;
      fence = fenceToken(block.content);
      continue;
    }

    if (line.trim() === "") {
      if (current) current.content += "\n";
      continue;
    }

    if (!current) {
      const block: RawBlock = {
        content: line.trim(),
        level: 1,
        children: [],
        properties: {},
      };
      pushBlock(block);
      currentColumns = 0;
      continue;
    }

    const property = PROP_RE.exec(line);
    if (property) {
      current.properties![property[1]] = parseValue(property[2]);
    }
    const segment = stripContinuation(line, currentColumns);
    current.content += `\n${segment}`;
    fence = fenceToken(segment);
  }

  return { properties, blocks };
}

function collectBlockRefs(
  blocks: RawBlock[],
  refs: Map<string, string>,
): void {
  for (const block of blocks) {
    const id = block.properties?.["id"];
    if (typeof id === "string" && UUID_RE.test(id)) {
      const cut = block.content.indexOf("\nid:: ");
      refs.set(id.toLowerCase(), cut === -1 ? block.content : block.content.slice(0, cut));
    }
    if (block.children.length > 0) collectBlockRefs(block.children, refs);
  }
}

function parsePageFile(
  filePath: string,
  journal: boolean,
  nameFormat: string,
): { page: RawPage; blocks: RawBlock[] } {
  const text = fs.readFileSync(filePath, "utf8");
  const stat = fs.statSync(filePath);
  const { properties, blocks } = parsePropertiesAndBlocks(text);

  let originalName: string;
  if (journal) {
    originalName = path.basename(filePath, ".md").replace(/_/g, "-");
    if (properties["date"] === undefined) properties["date"] = originalName;
  } else {
    originalName = decodePageName(path.basename(filePath, ".md"), nameFormat);
  }

  const page: RawPage = {
    name: originalName.toLowerCase(),
    originalName,
    properties,
    journal,
    createdAt: Number.isFinite(stat.birthtimeMs) ? stat.birthtimeMs : undefined,
    updatedAt: stat.mtimeMs,
  };

  return { page, blocks };
}

export function loadGraph(graphDir: string): FileGraphSource {
  const nameFormat = detectNameFormat(graphDir);
  const pages: RawPage[] = [];
  const blocksByPage = new Map<string, RawBlock[]>();
  const blockRefs = new Map<string, string>();

  const directories: [string, boolean][] = [
    [path.join(graphDir, "pages"), false],
    [path.join(graphDir, "journals"), true],
  ];

  for (const [directory, journal] of directories) {
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.endsWith(".md")) continue;
      if (entry.startsWith(".")) continue;
      const { page, blocks } = parsePageFile(
        path.join(directory, entry),
        journal,
        nameFormat,
      );
      pages.push(page);
      blocksByPage.set(page.name, blocks);
      collectBlockRefs(blocks, blockRefs);
    }
  }

  return { pages, blocksByPage, blockRefs, graphDir };
}

export function resolveAssetPath(source: FileGraphSource, ref: string): string {
  const relative = ref.replace(/^(\.\.\/)+/, "").replace(/^\//, "");
  return path.join(source.graphDir, relative);
}
