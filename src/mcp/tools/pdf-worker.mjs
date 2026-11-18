// Runs in a worker thread (see pdf-text.ts). Plain .mjs so it can be traced into the Next build and loaded by path.
import { parentPort, workerData } from 'node:worker_threads';
import { getDocumentProxy } from 'unpdf';

const { bytes, maxPages, maxChars, options } = workerData;
try {
  const pdf = await getDocumentProxy(bytes, options);
  if (pdf.numPages > maxPages) {
    parentPort.postMessage({ ok: false, reason: 'too_many_pages', pages: pdf.numPages });
  } else {
    let text = '';
    for (let i = 1; i <= pdf.numPages && text.length < maxChars; i++) {
      const page = await pdf.getPage(i);
      text += (await page.getTextContent()).items.map((it) => ('str' in it ? it.str + (it.hasEOL ? '\n' : '') : '')).join('') + '\n';
    }
    parentPort.postMessage({ ok: true, text: text.slice(0, maxChars) });
  }
} catch {
  parentPort.postMessage({ ok: false, reason: 'failed' });
}
