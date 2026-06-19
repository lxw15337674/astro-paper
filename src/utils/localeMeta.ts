import { DEFAULT_LOCALE, ENGLISH_LOCALE } from "@/i18n/locales";
import { getAssetPath } from "@/utils/withBase";

const LOCALE_LANG_TAGS: Record<string, string> = {
  [DEFAULT_LOCALE]: "zh-CN",
  [ENGLISH_LOCALE]: "en",
};

export function getLocaleLangTag(locale: string): string {
  return LOCALE_LANG_TAGS[locale] ?? locale;
}

export function getLocalizedRssPath(locale: string): string {
  return getAssetPath(locale === ENGLISH_LOCALE ? "en/rss.xml" : "rss.xml");
}
