import { getCollection } from "astro:content";
import type { SiteLocale } from "@/i18n/locales";
import { filterCollectionByLocale } from "@/utils/contentLocale";
import { getPostUrl } from "@/utils/getPostPaths";
import { getSortedPosts } from "@/utils/getSortedPosts";

export const HOME_POSTS_PER_LOAD = 20;

export type HomePost = {
  title: string;
  description: string;
  url: string;
  pubDatetime: string;
  modDatetime: string | null;
  timezone: string | undefined;
};

export type HomePostFeed = {
  posts: HomePost[];
  hasMore: boolean;
};

export async function getHomePosts(locale: SiteLocale) {
  const posts = filterCollectionByLocale(await getCollection("posts"), locale);
  return getSortedPosts(posts);
}

export function toHomePostFeed(
  posts: Awaited<ReturnType<typeof getHomePosts>>,
  locale: SiteLocale,
  page: number
): HomePostFeed {
  const start = (page - 1) * HOME_POSTS_PER_LOAD;
  const pagePosts = posts.slice(start, start + HOME_POSTS_PER_LOAD);

  return {
    posts: pagePosts.map(({ id, filePath, data }) => ({
      title: data.title,
      description: data.description,
      url: getPostUrl(id, filePath, locale),
      pubDatetime: data.pubDatetime.toISOString(),
      modDatetime: data.modDatetime?.toISOString() ?? null,
      timezone: data.timezone,
    })),
    hasMore: start + HOME_POSTS_PER_LOAD < posts.length,
  };
}

export async function getHomePostFeedPaths(locale: SiteLocale) {
  const posts = await getHomePosts(locale);
  const pageCount = Math.ceil(posts.length / HOME_POSTS_PER_LOAD);

  return Array.from({ length: Math.max(0, pageCount - 1) }, (_, index) => {
    const page = index + 2;
    return {
      params: { page: String(page) },
      props: { feed: toHomePostFeed(posts, locale, page) },
    };
  });
}
