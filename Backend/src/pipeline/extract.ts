import { extractText, getDocumentProxy } from "unpdf";

export interface Extracted {
  method: "pdf-text-layer" | "plain-text" | "html-text";
  totalPages: number;
  pages: { n: number; text: string }[];
}

/** The file type cannot be read in local mode. Terminal: retrying will not help. */
export class UnsupportedError extends Error {}

const NEEDS_TEXTRACT = "Textract or a converter, which local mode does not have";

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|table|section)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'");
}

/** Local extraction. On AWS this step becomes Textract (LAYOUT + TABLES) with the same output shape. */
export async function extract(body: Buffer, ext: string): Promise<Extracted> {
  switch (ext) {
    case "pdf": {
      const pdf = await getDocumentProxy(new Uint8Array(body));
      const { totalPages, text } = await extractText(pdf, { mergePages: false });
      const pages = text.map((t, i) => ({ n: i + 1, text: t }));
      if (!pages.some(p => p.text.trim())) throw new UnsupportedError("This PDF has no text layer (scanned image); it needs " + NEEDS_TEXTRACT + ".");
      return { method: "pdf-text-layer", totalPages, pages };
    }
    case "txt": case "md": case "csv": {
      // A form feed marks a page break; otherwise the file is one page.
      const parts = body.toString("utf8").split("\f");
      return { method: "plain-text", totalPages: parts.length, pages: parts.map((t, i) => ({ n: i + 1, text: t })) };
    }
    case "html": case "htm":
      return { method: "html-text", totalPages: 1, pages: [{ n: 1, text: htmlToText(body.toString("utf8")) }] };
    default:
      throw new UnsupportedError(`.${ext || "?"} files need ${NEEDS_TEXTRACT}. Local mode reads PDF (with a text layer), TXT, MD, CSV and HTML.`);
  }
}
