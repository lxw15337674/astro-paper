import { GET } from "../../../posts/[...slug]/index.png.ts";
import { ENGLISH_LOCALE } from "@/i18n/locales";
import { getPostOgPaths } from "@/utils/localeStaticPaths";

export { GET };

export async function getStaticPaths() {
  return getPostOgPaths(ENGLISH_LOCALE);
}
