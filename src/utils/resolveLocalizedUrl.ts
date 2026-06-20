import { getRelativeLocaleUrl } from "astro:i18n";
import type { CollectionEntry } from "astro:content";
import config from "@/config";
import { DEFAULT_LOCALE, LOCALES, type SiteLocale } from "@/i18n/locales";
import {
  filterCollectionByLocale,
  getEntryLocaleFromFilePath,
  getEntryLocaleFromId,
} from "@/utils/contentLocale";
import { getPostSlug, getPostUrl } from "@/utils/getPostPaths";
import { getUniqueTags } from "@/utils/getUniqueTags";
import { postFilter } from "@/utils/postFilter";
import { slugifyAll } from "@/utils/slugify";

const SHARED_ROUTE_PATHS = new Set([
  "/",
  "/about",
  "/archives",
  "/posts",
  "/search",
  "/tags",
]);

type ResolveLocalizedUrlOptions = {
  pathWithoutLocale: string;
  sourceLocale: SiteLocale;
  targetLocale: SiteLocale;
  posts: CollectionEntry<"posts">[];
};

function normalizeRoutePath(path: string): string {
  const rawPathname = path.split(/[?#]/)[0] ?? "/";
  const pathname = decodeRoutePath(rawPathname);
  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const withoutTrailingSlash =
    withLeadingSlash.endsWith("/") && withLeadingSlash !== "/"
      ? withLeadingSlash.slice(0, -1)
      : withLeadingSlash;

  return withoutTrailingSlash || "/";
}

function decodeRoutePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function toLocaleUrl(locale: SiteLocale, path: string): string {
  const routePath = normalizeRoutePath(path);
  return getRelativeLocaleUrl(locale, routePath === "/" ? "" : routePath);
}

function getPostEntryLocale(entry: CollectionEntry<"posts">): SiteLocale {
  return (
    getEntryLocaleFromFilePath(entry.filePath) ?? getEntryLocaleFromId(entry.id)
  );
}

function getVisiblePosts(posts: CollectionEntry<"posts">[]) {
  return posts.filter(postFilter);
}

function getPageCount(itemCount: number): number {
  return Math.max(1, Math.ceil(itemCount / config.posts.perPage));
}

function resolvePaginatedPostsUrl(
  pathWithoutLocale: string,
  targetLocale: SiteLocale,
  posts: CollectionEntry<"posts">[]
): string | undefined {
  const pageNumber = Number(pathWithoutLocale.match(/^\/posts\/(\d+)$/)?.[1]);
  if (!Number.isInteger(pageNumber) || pageNumber < 2) return undefined;

  const targetPostCount = filterCollectionByLocale(
    getVisiblePosts(posts),
    targetLocale
  ).length;
  const targetPageCount = getPageCount(targetPostCount);

  return toLocaleUrl(
    targetLocale,
    pageNumber <= targetPageCount ? `/posts/${pageNumber}` : "/posts"
  );
}

function findPostByRouteSlug(
  posts: CollectionEntry<"posts">[],
  locale: SiteLocale,
  routeSlug: string
): CollectionEntry<"posts"> | undefined {
  return posts.find(
    post =>
      getPostEntryLocale(post) === locale &&
      normalizeRoutePath(getPostSlug(post.id, post.filePath)) ===
        normalizeRoutePath(routeSlug)
  );
}

function findTranslatedPost(
  sourcePost: CollectionEntry<"posts"> | undefined,
  targetLocale: SiteLocale,
  posts: CollectionEntry<"posts">[]
): CollectionEntry<"posts"> | undefined {
  const translationKey = sourcePost?.data.translationKey;
  if (!translationKey) return undefined;

  return getVisiblePosts(posts).find(
    post =>
      getPostEntryLocale(post) === targetLocale &&
      post.data.translationKey === translationKey
  );
}

function resolvePostUrl({
  pathWithoutLocale,
  sourceLocale,
  targetLocale,
  posts,
}: ResolveLocalizedUrlOptions): string | undefined {
  const postSlug = pathWithoutLocale.match(/^\/posts\/(.+)$/)?.[1];
  if (!postSlug) return undefined;

  const sourcePost = findPostByRouteSlug(posts, sourceLocale, `/${postSlug}`);
  const translatedPost = findTranslatedPost(sourcePost, targetLocale, posts);

  if (!translatedPost) {
    return toLocaleUrl(targetLocale, "/posts");
  }

  return getPostUrl(translatedPost.id, translatedPost.filePath, targetLocale);
}

function resolveTagUrl(
  pathWithoutLocale: string,
  targetLocale: SiteLocale,
  posts: CollectionEntry<"posts">[]
): string | undefined {
  const tagMatch = pathWithoutLocale.match(/^\/tags\/([^/]+)(?:\/(\d+))?$/);
  const tag = tagMatch?.[1];
  if (!tag) return undefined;

  const targetPosts = filterCollectionByLocale(
    getVisiblePosts(posts),
    targetLocale
  );
  const targetTags = new Set(getUniqueTags(targetPosts).map(({ tag }) => tag));

  if (!targetTags.has(tag)) {
    return toLocaleUrl(targetLocale, "/tags");
  }

  const pageNumber = Number(tagMatch[2]);
  if (!Number.isInteger(pageNumber) || pageNumber < 2) {
    return toLocaleUrl(targetLocale, `/tags/${tag}`);
  }

  const tagPostCount = targetPosts.filter(({ data }) =>
    slugifyAll(data.tags).includes(tag)
  ).length;
  const targetPageCount = getPageCount(tagPostCount);

  return toLocaleUrl(
    targetLocale,
    pageNumber <= targetPageCount
      ? `/tags/${tag}/${pageNumber}`
      : `/tags/${tag}`
  );
}

function resolveSharedUrl(
  pathWithoutLocale: string,
  targetLocale: SiteLocale
): string | undefined {
  if (SHARED_ROUTE_PATHS.has(pathWithoutLocale)) {
    return toLocaleUrl(targetLocale, pathWithoutLocale);
  }

  if (pathWithoutLocale.match(/^\/posts\/.+$/)) {
    return toLocaleUrl(targetLocale, "/posts");
  }

  return undefined;
}

export function resolveLocalizedUrl({
  pathWithoutLocale,
  sourceLocale,
  targetLocale,
  posts,
}: ResolveLocalizedUrlOptions): string {
  const normalizedPath = normalizeRoutePath(pathWithoutLocale);

  if (!LOCALES.includes(sourceLocale) || !LOCALES.includes(targetLocale)) {
    return toLocaleUrl(DEFAULT_LOCALE, "/");
  }

  return (
    resolvePaginatedPostsUrl(normalizedPath, targetLocale, posts) ??
    resolvePostUrl({
      pathWithoutLocale: normalizedPath,
      sourceLocale,
      targetLocale,
      posts,
    }) ??
    resolveTagUrl(normalizedPath, targetLocale, posts) ??
    resolveSharedUrl(normalizedPath, targetLocale) ??
    toLocaleUrl(targetLocale, "/")
  );
}
