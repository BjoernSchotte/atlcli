export interface PdfRuntimeFontAsset {
  fileName: string;
  family:
    | "Source Sans 3"
    | "Source Serif 4"
    | "Source Code Pro"
    | "Noto Sans Symbols2"
    | "Noto Emoji";
  style: "normal" | "italic";
  weight: 400 | 600 | 700;
  sourceUrl: string;
  sha256: string;
}

const SOURCE_SANS_COMMIT = "ed1808970eb3c7301c9a523bee26473ba0bb62fa";
const SOURCE_SERIF_COMMIT = "2823e993c53fca27c5c8749f529b56a5a7c77b6b";
const SOURCE_CODE_PRO_COMMIT = "d3f1a5962cde503f9409c21e58527611d4a19ef1";
const NOTO_FONTS_COMMIT = "ffebf8c1ee449e544955a7e813c54f9b73848eac";
const GOOGLE_FONTS_COMMIT = "9fab8b6cc7b2f20376914fd765d918c698c66d75";

function adobeRaw(repo: string, commit: string, fileName: string): string {
  return `https://raw.githubusercontent.com/adobe-fonts/${repo}/${commit}/TTF/${fileName}`;
}

function notoRaw(fileName: string): string {
  return `https://raw.githubusercontent.com/notofonts/noto-fonts/${NOTO_FONTS_COMMIT}/hinted/ttf/NotoSansSymbols2/${fileName}`;
}

function googleFontsRaw(path: string): string {
  return `https://raw.githubusercontent.com/google/fonts/${GOOGLE_FONTS_COMMIT}/${path}`;
}

const fonts: readonly PdfRuntimeFontAsset[] = [
  { fileName: "SourceSans3-Regular.ttf", family: "Source Sans 3", style: "normal", weight: 400, sourceUrl: adobeRaw("source-sans", SOURCE_SANS_COMMIT, "SourceSans3-Regular.ttf"), sha256: "4644c81b86ec9caaa76b634889968ed3c4f4f52f054855933acc7c2b21e53b0f" },
  { fileName: "SourceSans3-It.ttf", family: "Source Sans 3", style: "italic", weight: 400, sourceUrl: adobeRaw("source-sans", SOURCE_SANS_COMMIT, "SourceSans3-It.ttf"), sha256: "192afd78f0f54a3c69eaf02d43f4d9a821e9d6110e41d3d25d61a7385cd580e4" },
  { fileName: "SourceSans3-Semibold.ttf", family: "Source Sans 3", style: "normal", weight: 600, sourceUrl: adobeRaw("source-sans", SOURCE_SANS_COMMIT, "SourceSans3-Semibold.ttf"), sha256: "a3f4f8dcf343a8f24dc61951de93f3ba1558b15cd250ba24af8a40e957081b7d" },
  { fileName: "SourceSans3-Bold.ttf", family: "Source Sans 3", style: "normal", weight: 700, sourceUrl: adobeRaw("source-sans", SOURCE_SANS_COMMIT, "SourceSans3-Bold.ttf"), sha256: "9214b9d95e4231c609802815c2646c98174e2102d0d37f88978a7f8e71006e6a" },
  { fileName: "SourceSerif4-Regular.ttf", family: "Source Serif 4", style: "normal", weight: 400, sourceUrl: adobeRaw("source-serif", SOURCE_SERIF_COMMIT, "SourceSerif4-Regular.ttf"), sha256: "e5a4ee6a3d87bb9024796be390c6771e2a0eb1883dae25effaf57ca01668e24b" },
  { fileName: "SourceSerif4-It.ttf", family: "Source Serif 4", style: "italic", weight: 400, sourceUrl: adobeRaw("source-serif", SOURCE_SERIF_COMMIT, "SourceSerif4-It.ttf"), sha256: "9d2950a8f1da66e21502c35d646a1d2148e79f9ea43fd2158cf02f5232e7f430" },
  { fileName: "SourceSerif4-Semibold.ttf", family: "Source Serif 4", style: "normal", weight: 600, sourceUrl: adobeRaw("source-serif", SOURCE_SERIF_COMMIT, "SourceSerif4-Semibold.ttf"), sha256: "36db62940cb5728b12b1802476dc7fcf4c6c519a7bdd476ba23a4e555fc4655f" },
  { fileName: "SourceSerif4-Bold.ttf", family: "Source Serif 4", style: "normal", weight: 700, sourceUrl: adobeRaw("source-serif", SOURCE_SERIF_COMMIT, "SourceSerif4-Bold.ttf"), sha256: "7cf4f4e1ad74f45058d5bc61716b82560442fbdcd9d3654d2dea96bf6c683d86" },
  { fileName: "SourceCodePro-Regular.ttf", family: "Source Code Pro", style: "normal", weight: 400, sourceUrl: adobeRaw("source-code-pro", SOURCE_CODE_PRO_COMMIT, "SourceCodePro-Regular.ttf"), sha256: "74bd80d3e42a08517cd7e1108ba3d86f2da29ac0f3065be95e0357956ab9db37" },
  { fileName: "SourceCodePro-Bold.ttf", family: "Source Code Pro", style: "normal", weight: 700, sourceUrl: adobeRaw("source-code-pro", SOURCE_CODE_PRO_COMMIT, "SourceCodePro-Bold.ttf"), sha256: "b2095e0d657e6d28dc32444a9dacabab0c9241d0bf39d96371756cc9bdbc3a5f" },
  { fileName: "NotoSansSymbols2-Regular.ttf", family: "Noto Sans Symbols2", style: "normal", weight: 400, sourceUrl: notoRaw("NotoSansSymbols2-Regular.ttf"), sha256: "630846d528dbe4c4981370a4d0a9475a1fd1491a129bb411f8e157cdb5de13c6" },
  { fileName: "NotoEmoji-wght.ttf", family: "Noto Emoji", style: "normal", weight: 400, sourceUrl: googleFontsRaw("ofl/notoemoji/NotoEmoji%5Bwght%5D.ttf"), sha256: "de6c18832938afc99caf132b39d6a30a19bac7f2e812e28db2535b4608d27551" },
];

export const PDF_RUNTIME_ASSETS = Object.freeze({
  fonts,
  licenses: Object.freeze([
    { fileName: "LICENSE-Source-Sans-3.txt" },
    { fileName: "LICENSE-Source-Serif-4.txt" },
    { fileName: "LICENSE-Source-Code-Pro.txt" },
    { fileName: "LICENSE-Noto-Sans-Symbols-2.txt" },
    { fileName: "LICENSE-Noto-Emoji.txt" },
  ]),
  compilerLicense: Object.freeze({ fileName: "LICENSE" }),
});
