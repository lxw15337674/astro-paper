import { getRelativeLocaleUrl } from "astro:i18n";
import config from "@/config";
import { DEFAULT_LOCALE, ENGLISH_LOCALE } from "@/i18n/locales";
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
