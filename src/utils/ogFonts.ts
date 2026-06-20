import { fontData, experimental_getFontFileURL } from "astro:assets";
import type { FontData } from "astro:assets";
import { getFontPathByWeight } from "@/utils/getFontPathByWeight";

const CJK_FONT_PATH = "public/fonts/wqy-zenhei-subset.ttf";

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

async function loadLocalFont(path: string): Promise<ArrayBuffer> {
  const fs = await import("node:fs/promises");
  const nodePath = await import("node:path");
  const buffer = await fs.readFile(nodePath.resolve(process.cwd(), path));
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  );
}

export async function loadOgFonts(url: URL): Promise<LoadedFont[]> {
  const fonts = fontData["--font-google-sans-code"];
  const [regularData, boldData, cjkRegularData, cjkBoldData] = await Promise.all([
    loadAstroFont(fonts, 400, url),
    loadAstroFont(fonts, 700, url),
    loadLocalFont(CJK_FONT_PATH),
    loadLocalFont(CJK_FONT_PATH),
  ]);

  return [
    {
      name: "Google Sans Code",
      data: regularData,
      weight: 400,
      style: "normal",
    },
    {
      name: "Google Sans Code",
      data: boldData,
      weight: 700,
      style: "normal",
    },
    {
      name: "WenQuanYi Zen Hei",
      data: cjkRegularData,
      weight: 400,
      style: "normal",
    },
    {
      name: "WenQuanYi Zen Hei",
      data: cjkBoldData,
      weight: 700,
      style: "normal",
    },
  ];
}

export const OG_FONT_FAMILY = '"WenQuanYi Zen Hei", "Google Sans Code"';
