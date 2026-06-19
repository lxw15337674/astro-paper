import { getCollection, type CollectionEntry } from "astro:content";
import type { GetStaticPathsOptions } from "astro";
import config from "@/config";
import { type SiteLocale } from "@/i18n/locales";
import { filterCollectionByLocale } from "@/utils/contentLocale";
import { getSortedPosts } from "@/utils/getSortedPosts";
import { getUniqueTags } from "@/utils/getUniqueTags";
import { slugifyAll } from "@/utils/slugify";
import { getPostSlug } from "@/utils/getPostPaths";

export async function getPostsForLocale(
  locale: SiteLocale,
  options?: { includeDrafts?: boolean }
) {
  const { includeDrafts = true } = options ?? {};
  const posts = await getCollection("posts", ({ data }) =>
    includeDrafts ? true : !data.draft
  );

  return filterCollectionByLocale(posts, locale);
}

export async function getPaginatedPostPaths(
  locale: SiteLocale,
  { paginate }: GetStaticPathsOptions
) {
  const posts = await getPostsForLocale(locale, { includeDrafts: false });
  return paginate(getSortedPosts(posts), { pageSize: config.posts.perPage });
}

export async function getTagPaginatedPaths(
  locale: SiteLocale,
  { paginate }: GetStaticPathsOptions
) {
  const posts = await getPostsForLocale(locale, { includeDrafts: false });
  const tags = getUniqueTags(posts);

  return tags.flatMap(({ tag, tagName }) => {
    const tagPosts = getSortedPosts(
      posts.filter(({ data }) => slugifyAll(data.tags).includes(tag))
    );

    return paginate(tagPosts, {
      params: { tag },
      props: { tagName },
      pageSize: config.posts.perPage,
    });
  });
}

type AdjacentPost = {
  id: string;
  title: string;
  filePath: string | undefined;
} | null;

export async function getPostDetailPaths(locale: SiteLocale) {
  const posts = await getPostsForLocale(locale);
  const sortedPosts = getSortedPosts(posts);

  return sortedPosts.map((post, index) => ({
    params: { slug: getPostSlug(post.id, post.filePath) },
    props: {
      post,
      prevPost: toAdjacentPost(sortedPosts[index - 1]),
      nextPost: toAdjacentPost(sortedPosts[index + 1]),
    },
  }));
}

export async function getPostOgPaths(locale: SiteLocale) {
  if (!config.features.dynamicOgImage) {
    return [];
  }

  const posts = (await getPostsForLocale(locale)).filter(
    ({ data }) => !data.draft && !data.ogImage
  );

  return posts.map(post => ({
    params: { slug: getPostSlug(post.id, post.filePath) },
    props: post,
  }));
}

function toAdjacentPost(
  post: CollectionEntry<"posts"> | undefined
): AdjacentPost {
  if (!post) return null;

  return {
    id: post.id,
    title: post.data.title,
    filePath: post.filePath,
  };
}
