import { useTranslations } from "@/i18n";
import config from "@/config";

export function getLocalizedSiteTitle(
  locale: string | undefined = config.site.lang
): string {
  return useTranslations(locale).home.heroTitle;
}

export function getLocalizedSiteDescription(
  locale: string | undefined = config.site.lang
): string {
  return useTranslations(locale).home.intro;
}
