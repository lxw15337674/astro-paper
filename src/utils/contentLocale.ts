import type { CollectionEntry } from "astro:content";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type SiteLocale,
} from "@/i18n/locales";

export function getEntryLocaleFromId(id: string): SiteLocale {
  const [firstSegment] = id.split("/");
  return firstSegment && isSupportedLocale(firstSegment)
    ? firstSegment
    : DEFAULT_LOCALE;
}

export function getEntryLocaleFromFilePath(
  filePath: string | undefined
): SiteLocale | undefined {
  if (!filePath) return undefined;

  const segments = filePath.split("/").filter(Boolean);
  const contentIndex = segments.findIndex(
    segment => segment === "posts" || segment === "pages"
  );
  const localeSegment = segments[contentIndex + 1];

  return localeSegment && isSupportedLocale(localeSegment)
    ? localeSegment
    : undefined;
}

export function stripLocalePrefix(value: string): string {
  const segments = value.split("/").filter(Boolean);
  if (segments.length > 0 && isSupportedLocale(segments[0])) {
    return segments.slice(1).join("/");
  }
  return segments.join("/");
}

export function filterCollectionByLocale<
  T extends CollectionEntry<"posts"> | CollectionEntry<"pages">,
>(entries: T[], locale: string | undefined = DEFAULT_LOCALE): T[] {
  return entries.filter(entry => {
    const entryLocale =
      getEntryLocaleFromFilePath(entry.filePath) ??
      getEntryLocaleFromId(entry.id);

    return entryLocale === locale;
  });
}

export function getLocalizedPageId(
  slug: string,
  locale: string | undefined = DEFAULT_LOCALE
): string {
  return `${locale}/${slug}`;
}
