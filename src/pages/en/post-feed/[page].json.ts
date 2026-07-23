import type { APIContext } from "astro";
import { ENGLISH_LOCALE } from "@/i18n/locales";
import { getHomePostFeedPaths, type HomePostFeed } from "@/utils/homePostFeed";

type Props = { feed: HomePostFeed };

export async function getStaticPaths() {
  return getHomePostFeedPaths(ENGLISH_LOCALE);
}

export async function GET({ props }: APIContext) {
  return new Response(JSON.stringify((props as Props).feed), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
