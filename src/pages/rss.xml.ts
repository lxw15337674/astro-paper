import rss from "@astrojs/rss";
import { getCollection } from "astro:content";
import { DEFAULT_LOCALE, type SiteLocale } from "@/i18n/locales";
import { filterCollectionByLocale } from "@/utils/contentLocale";
import { getSortedPosts } from "@/utils/getSortedPosts";
import { getPostUrl } from "@/utils/getPostPaths";
import config from "@/config";
import {
  getLocalizedSiteDescription,
  getLocalizedSiteTitle,
} from "@/utils/siteMeta";

export async function buildLocalizedRss(locale: SiteLocale = DEFAULT_LOCALE) {
  const posts = filterCollectionByLocale(await getCollection("posts"), locale);
  const sortedPosts = getSortedPosts(posts);

  return rss({
    title: getLocalizedSiteTitle(locale),
    description: getLocalizedSiteDescription(locale),
    site: config.site.url,
    items: sortedPosts.map(({ data, id, filePath }) => ({
      link: getPostUrl(id, filePath, locale),
      title: data.title,
      description: data.description,
      pubDate: new Date(data.modDatetime ?? data.pubDatetime),
    })),
  });
}

export async function GET() {
  return buildLocalizedRss(DEFAULT_LOCALE);
}
