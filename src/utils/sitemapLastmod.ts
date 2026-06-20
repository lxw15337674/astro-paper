import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type SiteLocale,
} from "../i18n/locales";
import { slugifyStr } from "./slugify";

const PROJECT_ROOT = process.cwd();
const POSTS_ROOT = join(PROJECT_ROOT, "src/content/posts");
const ROUTE_ROOT = join(PROJECT_ROOT, "src/pages");

const POST_EXTENSIONS = new Set([".md", ".mdx"]);
const STATIC_ROUTE_FILES = new Map<string, string>([
  ["/about/", "about.astro"],
  ["/en/about/", "en/about.astro"],
]);

type SitemapLastmodIndex = {
  latest: string;
  byPath: Map<string, string>;
};

type PostRecord = {
  locale: SiteLocale;
  path: string;
  tags: string[];
  lastmod: string;
};

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];

  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return walkFiles(path);
    return entry.isFile() ? [path] : [];
  });
}

function getFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? "";
}

function readScalar(frontmatter: string, key: string): string | undefined {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
}

function readBoolean(frontmatter: string, key: string): boolean {
  return readScalar(frontmatter, key)?.toLowerCase() === "true";
}

function readList(frontmatter: string, key: string): string[] {
  const match = frontmatter.match(
    new RegExp(`^${key}:\\s*\\n([\\s\\S]*?)(?=^\\S|\\Z)`, "m")
  );
  if (!match) return [];

  return match[1]
    .split("\n")
    .map(line => line.match(/^\s*-\s*(.+?)\s*$/)?.[1]?.trim())
    .filter((value): value is string => Boolean(value))
    .map(value => value.replace(/^['"]|['"]$/g, ""));
}

function toIsoDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function newerDate(
  a: string | undefined,
  b: string | undefined
): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function normalizePathname(pathname: string): string {
  const decoded = decodeURI(pathname);
  if (decoded === "/") return decoded;
  return decoded.endsWith("/") ? decoded : `${decoded}/`;
}

function getPostRoute(filePath: string, locale: SiteLocale): string {
  const relativePath = relative(POSTS_ROOT, filePath);
  const parts = relativePath.split(sep);
  const extension = extname(parts[parts.length - 1] ?? "");
  const basename = (parts.pop() ?? "").slice(0, -extension.length);
  const routeSegments =
    parts[0] && isSupportedLocale(parts[0]) ? parts.slice(1) : parts;
  const slugSegments = routeSegments
    .filter(segment => segment && !segment.startsWith("_"))
    .map(segment => slugifyStr(segment));
  const postSlug = [...slugSegments, basename].join("/");
  const localePrefix = locale === DEFAULT_LOCALE ? "" : `/${locale}`;

  return `${localePrefix}/posts/${postSlug}/`;
}

function getPostLocale(filePath: string): SiteLocale {
  const [firstSegment] = relative(POSTS_ROOT, filePath).split(sep);
  return firstSegment && isSupportedLocale(firstSegment)
    ? firstSegment
    : DEFAULT_LOCALE;
}

function collectPosts(): PostRecord[] {
  return walkFiles(POSTS_ROOT)
    .filter(path => POST_EXTENSIONS.has(extname(path)))
    .filter(path => !path.split(sep).some(segment => segment.startsWith("_")))
    .flatMap(path => {
      const content = readFileSync(path, "utf8");
      const frontmatter = getFrontmatter(content);
      if (readBoolean(frontmatter, "draft")) return [];

      const locale = getPostLocale(path);
      const lastmod =
        toIsoDate(readScalar(frontmatter, "modDatetime")) ??
        toIsoDate(readScalar(frontmatter, "pubDatetime"));
      if (!lastmod) return [];

      return [
        {
          locale,
          path: getPostRoute(path, locale),
          tags: readList(frontmatter, "tags"),
          lastmod,
        },
      ];
    });
}

function setLatest(
  map: Map<string, string>,
  path: string,
  lastmod: string | undefined
) {
  if (!lastmod) return;
  const normalizedPath = normalizePathname(path);
  const current = map.get(normalizedPath);
  map.set(normalizedPath, newerDate(current, lastmod) ?? lastmod);
}

function addPostDerivedPages(map: Map<string, string>, posts: PostRecord[]) {
  const latestByLocale = new Map<SiteLocale, string>();

  for (const post of posts) {
    setLatest(map, post.path, post.lastmod);
    latestByLocale.set(
      post.locale,
      newerDate(latestByLocale.get(post.locale), post.lastmod) ?? post.lastmod
    );

    for (const tag of post.tags) {
      const tagPath = `${post.locale === DEFAULT_LOCALE ? "" : `/${post.locale}`}/tags/${slugifyStr(tag)}/`;
      setLatest(map, tagPath, post.lastmod);
    }
  }

  for (const [locale, latest] of latestByLocale) {
    const prefix = locale === DEFAULT_LOCALE ? "" : `/${locale}`;
    for (const path of ["/", "/posts/", "/archives/", "/tags/"]) {
      setLatest(map, `${prefix}${path}`, latest);
    }
  }
}

function addStaticPages(map: Map<string, string>, fallbackLastmod: string) {
  for (const [route, relativePath] of STATIC_ROUTE_FILES) {
    const path = join(ROUTE_ROOT, relativePath);
    if (existsSync(path)) setLatest(map, route, fallbackLastmod);
  }
}

let cachedIndex: SitemapLastmodIndex | undefined;

export function getSitemapLastmodIndex(): SitemapLastmodIndex {
  if (cachedIndex) return cachedIndex;

  const byPath = new Map<string, string>();
  const posts = collectPosts();
  addPostDerivedPages(byPath, posts);

  const latest =
    posts.reduce<string | undefined>(
      (current, post) => newerDate(current, post.lastmod),
      undefined
    ) ?? new Date().toISOString();

  addStaticPages(byPath, latest);

  cachedIndex = { latest, byPath };
  return cachedIndex;
}

export function getSitemapLastmodForUrl(url: string): string {
  const { latest, byPath } = getSitemapLastmodIndex();
  const pathname = normalizePathname(new URL(url).pathname);
  return byPath.get(pathname) ?? latest;
}
