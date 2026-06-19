import { buildLocalizedRss } from "../rss.xml";
import { ENGLISH_LOCALE } from "@/i18n/locales";

export async function GET() {
  return buildLocalizedRss(ENGLISH_LOCALE);
}
