import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { collect } from "../core/collect";
import { defaultSettings, mergeSettings } from "../core/settings";
import { Settings } from "../core/types";
import { loadGraph, resolveAssetPath } from "../sources/file";

const MANIFEST = ".schrodinger-manifest.json";

interface ManifestEntry {
  hash: string;
  date?: string;
  lastMod?: string;
}
type Manifest = Record<string, ManifestEntry>;

const FRONT_MATTER_DATE_LINE = /^(date|lastMod|lastmod):/;

const USAGE = `logseq-schrodinger CLI

Usage:
  schrodinger export --graph <logseq-graph-dir> [options]

Options:
  --graph <dir>          Logseq graph directory (required)
  --out <dir>            Output root directory (default: current directory)
  --config <file>        JSON file with settings overrides
  --pages-dir <dir>      Output directory for pages (default: content/pages)
  --journal-dir <dir>    Output directory for journals (default: content/posts)
  --assets-dir <dir>     Output directory for assets (default: assets)
  --clean                Delete previously generated files that were not regenerated
  --dry-run              Print what would be written without touching the filesystem
  --quiet                Suppress progress output
  --help                 Show this help
`;

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function ensureDir(directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
}

function pruneEmptyParents(filePath: string, stopAt: string): void {
  let current = path.dirname(filePath);
  const root = path.resolve(stopAt);
  while (current.startsWith(root) && current !== root) {
    try {
      if (fs.readdirSync(current).length > 0) break;
      fs.rmdirSync(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

function frontMatterRange(content: string): [number, number] | undefined {
  if (!content.startsWith("---")) return undefined;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return undefined;
  return [3, end];
}

function stableContent(content: string): string {
  const range = frontMatterRange(content);
  if (!range) return content;
  const [start, end] = range;
  const lines = content
    .slice(start, end)
    .split("\n")
    .filter((line) => !FRONT_MATTER_DATE_LINE.test(line));
  return content.slice(0, start) + lines.join("\n") + content.slice(end);
}

function contentHash(content: string): string {
  return createHash("sha256").update(stableContent(content)).digest("hex");
}

function readDates(content: string): { date?: string; lastMod?: string } {
  const range = frontMatterRange(content);
  if (!range) return {};
  const dates: { date?: string; lastMod?: string } = {};
  for (const line of content.slice(range[0], range[1]).split("\n")) {
    const match = /^(date|lastMod|lastmod):\s*(.*)$/.exec(line);
    if (!match) continue;
    if (match[1] === "date") dates.date = match[2].trim();
    else dates.lastMod = match[2].trim();
  }
  return dates;
}

function setDates(
  content: string,
  dates: { date?: string; lastMod?: string },
): string {
  const range = frontMatterRange(content);
  if (!range) return content;
  const [start, end] = range;
  const lines = content.slice(start, end).split("\n");
  const set = (key: string, value: string | undefined) => {
    if (!value) return;
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index === -1) lines.push(`${key}: ${value}`);
    else lines[index] = `${key}: ${value}`;
  };
  set("date", dates.date);
  set("lastMod", dates.lastMod);
  return content.slice(0, start) + lines.join("\n") + content.slice(end);
}

function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      graph: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      "pages-dir": { type: "string" },
      "journal-dir": { type: "string" },
      "assets-dir": { type: "string" },
      clean: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }

  const command = positionals[0] ?? "export";
  if (command !== "export" || positionals.length > 1) {
    process.stderr.write(`error: unknown command: ${positionals.join(" ")}\n\n`);
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }

  const graphDir = values.graph;
  if (!graphDir) {
    process.stderr.write("error: --graph <logseq-graph-dir> is required\n\n");
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!fs.existsSync(graphDir) || !fs.statSync(graphDir).isDirectory()) {
    process.stderr.write(`error: graph directory not found: ${graphDir}\n`);
    process.exitCode = 1;
    return;
  }

  const fileConfig = values.config
    ? readJson<Partial<Settings>>(values.config)
    : undefined;
  const flagConfig: Partial<Settings> = {};
  if (values["pages-dir"]) flagConfig.pagesPath = values["pages-dir"];
  if (values["journal-dir"]) flagConfig.journalPath = values["journal-dir"];
  if (values["assets-dir"]) flagConfig.assetsPath = values["assets-dir"];

  const settings = mergeSettings(
    mergeSettings(defaultSettings, fileConfig),
    flagConfig,
  );

  const outDir = path.resolve(values.out ?? process.cwd());
  const clean = values.clean === true;
  const dryRun = values["dry-run"] === true;
  const quiet = values.quiet === true;

  const log = (message: string) => {
    if (!quiet) process.stdout.write(`${message}\n`);
  };

  const source = loadGraph(graphDir);
  const runner = async () => {
    const result = await collect({
      pages: source.pages,
      settings,
      getBlocks: async (page) => source.blocksByPage.get(page.name) ?? [],
      resolveBlockRef: (uuid) => source.blockRefs.get(uuid.toLowerCase()),
    });

    const manifestPath = path.join(outDir, MANIFEST);
    const previousRaw = readJson<unknown>(manifestPath);
    const previous: Manifest =
      previousRaw &&
      typeof previousRaw === "object" &&
      !Array.isArray(previousRaw)
        ? (previousRaw as Manifest)
        : {};

    const written: string[] = [];
    const manifest: Manifest = {};

    for (const file of result.files) {
      let content = file.content;
      const hash = contentHash(content);
      const prior = previous[file.path];
      if (prior && prior.hash === hash && (prior.date || prior.lastMod)) {
        // The page did not change; the mtime may have been reset by a copy or
        // sync, so keep the dates we published last time.
        content = setDates(content, { date: prior.date, lastMod: prior.lastMod });
      }
      const target = path.join(outDir, file.path);
      if (dryRun) {
        log(`would write ${file.path}`);
      } else {
        ensureDir(path.dirname(target));
        fs.writeFileSync(target, content);
      }
      written.push(file.path);
      manifest[file.path] = { hash, ...readDates(content) };
    }

    let missingAssets = 0;
    for (const asset of result.assets) {
      const from = resolveAssetPath(source, asset.ref);
      const target = path.join(outDir, asset.outPath);
      if (!fs.existsSync(from)) {
        missingAssets += 1;
        log(`warning: missing asset ${asset.ref}`);
        continue;
      }
      if (dryRun) {
        log(`would copy ${asset.ref} -> ${asset.outPath}`);
      } else {
        ensureDir(path.dirname(target));
        fs.copyFileSync(from, target);
      }
      written.push(asset.outPath);
      manifest[asset.outPath] = { hash: "" };
    }

    if (clean && !dryRun) {
      const current = new Set(written);
      for (const relative of Object.keys(previous)) {
        if (current.has(relative)) continue;
        const stale = path.join(outDir, relative);
        if (fs.existsSync(stale)) {
          fs.rmSync(stale);
          pruneEmptyParents(stale, outDir);
          log(`removed stale ${relative}`);
        }
      }
    }

    if (!dryRun) {
      ensureDir(outDir);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    log(
      `exported ${result.files.length} page(s) and ${result.assets.length} asset(s)` +
        (missingAssets > 0 ? ` (${missingAssets} missing)` : "") +
        (dryRun ? " [dry-run]" : ""),
    );
  };

  runner().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}

main();
