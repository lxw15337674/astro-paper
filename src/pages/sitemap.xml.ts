import config from "@/config";
import { getSitemapLastmodIndex } from "@/utils/sitemapLastmod";

export function GET() {
  const sitemapUrl = new URL("sitemap-0.xml", config.site.url).toString();
  const { latest } = getSitemapLastmodIndex();

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>` +
      `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      `<sitemap><loc>${sitemapUrl}</loc><lastmod>${latest}</lastmod></sitemap>` +
      `</sitemapindex>`,
    {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
      },
    }
  );
}
