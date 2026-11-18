import { inflateSync } from 'node:zlib';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export const PDF_MAX_PAGES = 100;
export const PDF_MAX_CHARS = 200_000;
/** Total inflated size allowed across all Flate streams of one PDF. */
export const PDF_INFLATE_BUDGET = 64 * 1024 * 1024;
export const PDF_WORKER_TIMEOUT_MS = 10_000;
// isEvalSupported is a real pdf.js option missing from unpdf's types; the worker passes it as plain data.
const PDF_OPTIONS = { verbosity: 0, isEvalSupported: false, disableFontFace: true };
const WORKER_FILE = path.join(process.cwd(), 'src/mcp/tools/pdf-worker.mjs'); // traced into the build by next.config.ts

export type PdfText =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_many_pages'; pages: number }
  | { ok: false; reason: 'expands' }
  | { ok: false; reason: 'failed' };

/**
 * True when the Flate streams of the PDF inflate to more than `budget` bytes in total. Fails closed on size.
 * Streams inside object streams are streams too, so they are covered. A corrupt stream is skipped (pdf.js will fail on it).
 * A filter list with FlateDecode twice is inflated twice.
 */
export function pdfExpandsTooMuch(bytes: Uint8Array, budget = PDF_INFLATE_BUDGET): boolean {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let left = budget;
  for (let at = buf.indexOf('stream'); at !== -1; at = buf.indexOf('stream', at + 6)) {
    if (at >= 3 && buf.toString('latin1', at - 3, at) === 'end') continue;
    const dict = buf.toString('latin1', Math.max(buf.lastIndexOf('obj', at), at - 4096, 0), at);
    const passes = dict.split('/FlateDecode').length - 1;
    if (!passes) continue;
    let start = at + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = buf.indexOf('endstream', start);
    if (end === -1) continue;
    let data: Buffer = buf.subarray(start, end);
    for (let p = 0; p < passes; p++) {
      if (left < 1) return true;
      try {
        data = inflateSync(data, { maxOutputLength: left });
      } catch (e) {
        if ((e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') return true;
        break;
      }
      left -= data.length;
    }
  }
  return false;
}

/** Extracts in a worker thread with a memory cap and a hard timeout. Any failure is "failed". */
export function extractInWorker(bytes: Uint8Array, opts: { timeoutMs?: number; file?: string } = {}): Promise<PdfText> {
  return new Promise((resolve) => {
    let worker: Worker | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (r: PdfText) => {
      clearTimeout(timer);
      void worker?.terminate();
      resolve(r);
    };
    try {
      worker = new Worker(opts.file ?? WORKER_FILE, {
        workerData: { bytes: new Uint8Array(bytes), maxPages: PDF_MAX_PAGES, maxChars: PDF_MAX_CHARS, options: PDF_OPTIONS },
        resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
      });
      timer = setTimeout(() => done({ ok: false, reason: 'failed' }), opts.timeoutMs ?? PDF_WORKER_TIMEOUT_MS);
      worker.once('message', (m: PdfText) => done(m));
      worker.once('error', () => done({ ok: false, reason: 'failed' }));
      worker.once('exit', () => done({ ok: false, reason: 'failed' })); // no-op after a message
    } catch {
      done({ ok: false, reason: 'failed' });
    }
  });
}

/** Text of a PDF, at most PDF_MAX_PAGES pages and PDF_MAX_CHARS characters. The caller applies its own byte limit. */
export async function extractPdfText(bytes: Uint8Array): Promise<PdfText> {
  if (pdfExpandsTooMuch(bytes)) return { ok: false, reason: 'expands' };
  return extractInWorker(bytes);
}
