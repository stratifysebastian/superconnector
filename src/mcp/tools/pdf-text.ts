import { getDocumentProxy } from 'unpdf';

export const PDF_MAX_PAGES = 100;
export const PDF_MAX_CHARS = 200_000;
// isEvalSupported is a real pdf.js option missing from unpdf's types; a variable skips the excess-property check.
const PDF_OPTIONS = { verbosity: 0, isEvalSupported: false, disableFontFace: true };

export type PdfText = { ok: true; text: string } | { ok: false; reason: 'too_many_pages'; pages: number } | { ok: false; reason: 'failed' };

/** Text of a PDF, at most PDF_MAX_PAGES pages and PDF_MAX_CHARS characters. The caller applies its own byte limit. */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  try {
    // shortcut: pdf.js runs in-process, so a decompression bomb can still use a lot of memory; upgrade is a worker with a hard timeout.
    const pdf = await getDocumentProxy(new Uint8Array(bytes), PDF_OPTIONS);
    if (pdf.numPages > PDF_MAX_PAGES) return { ok: false, reason: 'too_many_pages', pages: pdf.numPages };
    let text = '';
    for (let i = 1; i <= pdf.numPages && text.length < PDF_MAX_CHARS; i++) {
      const page = await pdf.getPage(i);
      text += (await page.getTextContent()).items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('') + '\n';
    }
    return { ok: true, text: text.slice(0, PDF_MAX_CHARS) };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
