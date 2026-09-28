import { buildFrontMatter } from "./frontmatter";
import { renderPage } from "./render";
import { AssetRef, OutputFile, RawBlock, RawPage, Settings } from "./types";

const EMOJI_RE =
  /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|[\u2011-\u26FF]|\uD83E[\uDD10-\uDDFF])/g;

export function outputPath(page: RawPage, settings: Settings): string {
  const directory = page.journal ? settings.journalPath : settings.pagesPath;
  const name = page.originalName.replace(EMOJI_RE, "");
  return `${directory.replace(/\/$/, "")}/${name}.md`;
}

export function isPublicPage(page: RawPage): boolean {
  const value = page.properties["public"];
  return value === true || value === "true";
}

export interface CollectOptions {
  pages: RawPage[];
  settings: Settings;
  getBlocks: (page: RawPage) => Promise<RawBlock[]>;
  resolveBlockRef: (uuid: string) => string | undefined;
  isPublic?: (page: RawPage) => boolean;
}

export interface CollectResult {
  files: OutputFile[];
  assets: AssetRef[];
}

export async function collect(options: CollectOptions): Promise<CollectResult> {
  const isPublic = options.isPublic ?? isPublicPage;
  const publicPages = options.pages.filter(isPublic);
  const publicNames = new Set(publicPages.map((page) => page.name.toLowerCase()));
  const files: OutputFile[] = [];
  const assets: AssetRef[] = [];

  for (const page of publicPages) {
    const blocks = await options.getBlocks(page);
    const frontMatter = buildFrontMatter({ page, settings: options.settings });
    const rendered = await renderPage(blocks, {
      settings: options.settings,
      publicNames,
      allPages: options.pages,
      resolveBlockRef: options.resolveBlockRef,
    });
    files.push({
      path: outputPath(page, options.settings),
      content: `${frontMatter}\n${rendered.body}`,
    });
    for (const asset of rendered.assets) {
      if (!assets.some((item) => item.outPath === asset.outPath)) {
        assets.push(asset);
      }
    }
  }

  return { files, assets };
}
