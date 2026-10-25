// Browser-only: turn the first pages of a PDF invoice into JPEGs for invoice readers
// that accept images but not PDFs (e.g. Groq vision models).

/** Returns base64 JPEG strings (no data: prefix), one per page. */
export async function pdfToJpegs(file: File, maxPages = 2, maxWidth = 1600): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();

  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const images: string[] = [];
  try {
    const doc = await task.promise;
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const scale = Math.min(2, maxWidth / page.getViewport({ scale: 1 }).width);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      await page.render({ canvas, viewport }).promise;
      images.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
    }
  } finally {
    await task.destroy();
  }
  return images;
}
