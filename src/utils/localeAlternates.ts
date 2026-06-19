import { getRelativeLocaleUrl } from "astro:i18n";
import config from "@/config";
import {
  DEFAULT_LOCALE,
  ENGLISH_LOCALE,
  type SiteLocale,
} from "@/i18n/locales";

export type LocaleAlternate = {
  hreflang: SiteLocale | "x-default";
  href: string;
};

function toAbsoluteUrl(path: string): string {
  return new URL(path, config.site.url).href;
}

export function getSharedLocaleAlternates(path: string): LocaleAlternate[] {
  const zhHref = toAbsoluteUrl(getRelativeLocaleUrl(DEFAULT_LOCALE, path));
  const enHref = toAbsoluteUrl(getRelativeLocaleUrl(ENGLISH_LOCALE, path));

  return [
    { hreflang: DEFAULT_LOCALE, href: zhHref },
    { hreflang: ENGLISH_LOCALE, href: enHref },
    { hreflang: "x-default", href: zhHref },
  ];
}
