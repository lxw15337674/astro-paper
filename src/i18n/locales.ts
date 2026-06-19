export const LOCALES = ["zh-cn", "en"] as const;

export type SiteLocale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: SiteLocale = "zh-cn";
export const ENGLISH_LOCALE: SiteLocale = "en";

const localeSet = new Set<string>(LOCALES);

export function isSupportedLocale(value: string): value is SiteLocale {
  return localeSet.has(value);
}
