import { fontData, experimental_getFontFileURL } from "astro:assets";
import type { FontData } from "astro:assets";
import { getFontPathByWeight } from "@/utils/getFontPathByWeight";

const PRIMARY_FONT_FAMILY = "Google Sans Code";
const CJK_FONT_FAMILY = "Noto Sans SC";

const PRIMARY_FONT_DATA = "--font-google-sans-code";
const CJK_FONT_DATA = "--font-noto-sans-sc";

type LoadedFont = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: "normal";
};

async function loadAstroFont(
  fonts: FontData[],
  weight: 400 | 700,
  url: URL
): Promise<ArrayBuffer> {
  const fontPath = getFontPathByWeight(fonts, weight);
  if (fontPath === undefined) {
    throw new Error(`Cannot find Astro font path for weight ${weight}.`);
  }
  return fetch(experimental_getFontFileURL(fontPath, url)).then(res =>
    res.arrayBuffer()
  );
}

export async function loadOgFonts(url: URL): Promise<LoadedFont[]> {
  const primaryFonts = fontData[PRIMARY_FONT_DATA];
  const cjkFonts = fontData[CJK_FONT_DATA];

  if (!primaryFonts || !cjkFonts) {
    throw new Error("Cannot find configured OG font data.");
  }

  const [regularData, boldData, cjkRegularData, cjkBoldData] =
    await Promise.all([
      loadAstroFont(primaryFonts, 400, url),
      loadAstroFont(primaryFonts, 700, url),
      loadAstroFont(cjkFonts, 400, url),
      loadAstroFont(cjkFonts, 700, url),
    ]);

  return [
    {
      name: PRIMARY_FONT_FAMILY,
      data: regularData,
      weight: 400,
      style: "normal",
    },
    {
      name: PRIMARY_FONT_FAMILY,
      data: boldData,
      weight: 700,
      style: "normal",
    },
    {
      name: CJK_FONT_FAMILY,
      data: cjkRegularData,
      weight: 400,
      style: "normal",
    },
    {
      name: CJK_FONT_FAMILY,
      data: cjkBoldData,
      weight: 700,
      style: "normal",
    },
  ];
}

export const OG_FONT_FAMILY = `"${PRIMARY_FONT_FAMILY}", "${CJK_FONT_FAMILY}"`;
