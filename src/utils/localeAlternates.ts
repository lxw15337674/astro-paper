import { getRelativeLocaleUrl } from "astro:i18n";
import type { CollectionEntry } from "astro:content";
import config from "@/config";
import {
  DEFAULT_LOCALE,
  ENGLISH_LOCALE,
  LOCALES,
  type SiteLocale,
} from "@/i18n/locales";
import {
  getEntryLocaleFromFilePath,
  getEntryLocaleFromId,
} from "./contentLocale";
import { getPostSlug, getPostUrl } from "./getPostPaths";
import { postFilter } from "./postFilter";
import { getLocaleLangTag } from "@/utils/localeMeta";

export type LocaleAlternate = {
  hreflang: string;
  href: string;
};

function toAbsoluteUrl(path: string): string {
  return new URL(path, config.site.url).href;
}

export function getSharedLocaleAlternates(path: string): LocaleAlternate[] {
  const zhHref = toAbsoluteUrl(getRelativeLocaleUrl(DEFAULT_LOCALE, path));
  const enHref = toAbsoluteUrl(getRelativeLocaleUrl(ENGLISH_LOCALE, path));

  return [
    { hreflang: getLocaleLangTag(DEFAULT_LOCALE), href: zhHref },
    { hreflang: getLocaleLangTag(ENGLISH_LOCALE), href: enHref },
    { hreflang: "x-default", href: zhHref },
  ];
}

function getEntryLocale(entry: CollectionEntry<"posts">): SiteLocale {
  return (
    getEntryLocaleFromFilePath(entry.filePath) ?? getEntryLocaleFromId(entry.id)
  );
}

/**
 * Builds article-level hreflang links only for posts that share the same
 * locale-free slug path across locales. This avoids inventing translation
 * relationships for independent Chinese/English articles.
 */
export function getPostLocaleAlternates(
  post: CollectionEntry<"posts">,
  posts: CollectionEntry<"posts">[]
): LocaleAlternate[] {
  const slug = getPostSlug(post.id, post.filePath);
  const matchingPosts = posts
    .filter(postFilter)
    .filter(
      candidate => getPostSlug(candidate.id, candidate.filePath) === slug
    );

  const entriesByLocale = new Map<SiteLocale, CollectionEntry<"posts">>();

  for (const candidate of matchingPosts) {
    entriesByLocale.set(getEntryLocale(candidate), candidate);
  }

  if (entriesByLocale.size < 2) return [];

  const alternates = LOCALES.flatMap(locale => {
    const localizedPost = entriesByLocale.get(locale);
    if (!localizedPost) return [];

    return [
      {
        hreflang: getLocaleLangTag(locale),
        href: toAbsoluteUrl(
          getPostUrl(localizedPost.id, localizedPost.filePath, locale)
        ),
      },
    ];
  });

  const defaultPost = entriesByLocale.get(DEFAULT_LOCALE);
  if (defaultPost) {
    alternates.push({
      hreflang: "x-default",
      href: toAbsoluteUrl(
        getPostUrl(defaultPost.id, defaultPost.filePath, DEFAULT_LOCALE)
      ),
    });
  }

  return alternates;
}
