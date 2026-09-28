import { AssetRef, RawBlock, RawPage, Settings } from "./types";

export interface RenderContext {
  settings: Settings;
  publicNames: Set<string>;
  allPages: RawPage[];
  resolveBlockRef: (uuid: string) => string | undefined;
}

export interface RenderResult {
  body: string;
  assets: AssetRef[];
}

const BLOCK_REF_RE =
  /\(\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\)/i;
const EMBED_REF_RE =
  /{{embed\s*\(\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)\)}}/i;

export function parseLinks(
  text: string,
  publicNames: Set<string>,
  linkFormat: string,
): string {
  text = text.replace(
    /\[([^\]]*?)\]\(\[\[(.*?)\]\]\)/g,
    (full, description, page) => {
      if (publicNames.has(String(page).toLowerCase())) {
        return `[${description}]({{< ref "/pages/${page}" >}})`;
      }
      return full;
    },
  );
  text = text.replace(/\[\[(.*?)\]\]/g, (full, page) => {
    if (publicNames.has(String(page).toLowerCase())) {
      return `[${page}]({{< ref "/pages/${page}" >}})`;
    }
    return full;
  });
  if (linkFormat === "Without brackets") {
    text = text.replaceAll("[[", "").replaceAll("]]", "");
  }
  return text;
}

function parseNamespaces(
  text: string,
  level: number,
  ctx: RenderContext,
): string {
  return text.replace(
    /{{namespace\s+([^}]+)}}/gi,
    (full, rawNamespace) => {
      const namespace = String(rawNamespace).trim();
      const namespaceLower = namespace.toLowerCase();
      const children = ctx.allPages.filter((page) =>
        page.name.startsWith(`${namespaceLower}/`),
      );

      let content = `**Namespace [[${namespace}]]**\n\n`;
      if (ctx.publicNames.has(namespaceLower)) {
        content = content.replace(
          `[[${namespace}]]`,
          `[${namespace}]({{< ref "/pages/${namespace}" >}})`,
        );
      }

      const indent =
        ctx.settings.bulletHandling === "Convert Bullets"
          ? `${" ".repeat(level * 2)}+ `
          : "";

      for (const page of children) {
        if (!ctx.publicNames.has(page.name)) continue;
        const shortName = page.originalName.replace(`${namespace}/`, "");
        content += `${indent}[${shortName}]({{< ref "/pages/${page.originalName}" >}})\n\n`;
      }
      return content;
    },
  );
}

function secondsToHms(raw: unknown): string {
  const total = Number(raw);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const pad = (n: number) => (n > 9 ? String(n) : `0${n}`);
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function rewriteImages(
  text: string,
  ctx: RenderContext,
  assets: AssetRef[],
): string {
  return text.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g,
    (full, alt, rawDestination) => {
      const destination = String(rawDestination).trim();
      if (destination === "" || /^https?:\/\//i.test(destination)) {
        return full;
      }
      const basename = destination.split("/").pop() ?? destination;
      const outPath = `${ctx.settings.assetsPath.replace(/\/$/, "")}/${basename.toLowerCase()}`;
      if (!assets.some((asset) => asset.outPath === outPath)) {
        assets.push({ ref: destination, outPath });
      }
      return `![${alt}](/${outPath})`;
    },
  );
}

async function renderBlock(
  block: RawBlock,
  previous: RawBlock | undefined,
  ctx: RenderContext,
  assets: AssetRef[],
): Promise<string | undefined> {
  if (block.isMetadata) return undefined;

  let text = block.content;

  const blockRef = EMBED_REF_RE.exec(text) ?? BLOCK_REF_RE.exec(text);
  if (blockRef) {
    const resolved = ctx.resolveBlockRef(blockRef[1]);
    if (resolved !== undefined) text = text.replace(blockRef[0], resolved);
  }

  if (block.marker && !ctx.settings.exportTasks) return undefined;

  text = rewriteImages(text, ctx, assets);

  let before = "";
  let after = "\n";
  if (ctx.settings.bulletHandling === "Convert Bullets") {
    if (block.level > 1) {
      before = `${" ".repeat((block.level - 1) * 2)}+ `;
      if (previous && previous.level === block.level) after = "";
    }
  }
  if (previous && previous.level === block.level) after = "";
  if (text.substring(0, 3) === "```") before = "";
  if (/!\[.*?\]\(.*?\)/.test(text)) before = "";
  text = before + text + after;

  text = parseLinks(text, ctx.publicNames, ctx.settings.linkFormat);
  text = parseNamespaces(text, block.level, ctx);

  text = text.replace(
    /{{youtube-timestamp\s+(\d+)}}/g,
    (_match, timestamp) => `@${secondsToHms(timestamp)}`,
  );

  text = text.replace(/{{youtube(.*?)}}/g, (match) => {
    const youtubeId =
      /(youtu(?:.*\/v\/|.*v=|\.be\/))([A-Za-z0-9_-]{11})/.exec(match);
    return youtubeId ? `{{< youtube ${youtubeId[2]} >}}` : match;
  });

  text = text.replace(/{:height\s*\d*,\s*:width\s*\d*}/g, "");

  text = text.replace(
    /==(.*?)==/gm,
    "{{< logseq/mark >}}$1{{< / logseq/mark >}}",
  );

  text = text.replace(
    /#\+BEGIN_([A-Z]*)[^\n]*\n([\s\S]*?)#\+END_[^\n]*/g,
    "{{< logseq/org$1 >}}$2{{< / logseq/org$1 >}}",
  );

  text = text.replace(/:LOGBOOK:|collapsed:: true/gi, "");
  if (text.includes("CLOCK: [")) {
    text = text.substring(0, text.indexOf("CLOCK: ["));
  }

  const idIndex = text.indexOf("\nid:: ");
  if (idIndex !== -1) text = text.substring(0, idIndex);

  return text;
}

async function renderList(
  blocks: RawBlock[],
  ctx: RenderContext,
  out: RenderResult,
): Promise<void> {
  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    const previous = i > 0 ? blocks[i - 1] : undefined;
    const rendered = await renderBlock(block, previous, ctx, out.assets);
    if (rendered !== undefined) out.body += `\n${rendered}\n`;
    if (block.children && block.children.length > 0) {
      await renderList(block.children, ctx, out);
    }
  }
}

export async function renderPage(
  blocks: RawBlock[],
  ctx: RenderContext,
): Promise<RenderResult> {
  const out: RenderResult = { body: "", assets: [] };
  await renderList(blocks, ctx, out);
  return out;
}
