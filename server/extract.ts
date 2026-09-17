import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import { ROOT } from './db';
import { pythonBinary, popplerBinary, ocrPdfText, ocrImageText } from './platform';
const exec = promisify(execFile);
export const extensions = new Set([
  '.pdf',
  '.docx',
  '.pptx',
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.html',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.heic',
]);
export async function extract(file: string, name: string) {
  const ext = path.extname(name).toLowerCase();
  if (!extensions.has(ext))
    throw Error(`Unsupported file type ${ext}. Use PDF, DOCX, PPTX, text, or an image.`);
  let text = '';
  if (ext === '.pdf') {
    const r = await exec(popplerBinary('pdftotext'), [file, '-'], {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 120000,
    });
    const pages = r.stdout.split('\f');
    if (!pages.at(-1)?.trim()) pages.pop();
    if (pages.some((p) => p.trim().length < 20)) {
      text = await ocrPdfText(file);
    } else text = pages.map((p, i) => `\n[Page ${i + 1}]\n${p}`).join('\n');
  } else if (ext === '.docx') {
    text = '[Document]\n' + (await mammoth.extractRawText({ path: file })).value;
  } else if (ext === '.pptx') {
    const python = pythonBinary();
    if (!python) throw Error('PPTX text needs Python 3. Install it, then upload again.');
    const r = await exec(python, [path.join(ROOT, 'scripts', 'extract_slides.py'), file], {
      maxBuffer: 100 * 1024 * 1024,
      timeout: 120000,
    });
    text = r.stdout;
  } else if (['.png', '.jpg', '.jpeg', '.webp', '.heic'].includes(ext)) {
    text = await ocrImageText(file);
  } else {
    text = fs.readFileSync(file, 'utf8');
    if (ext === '.html')
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]*>/g, ' ');
    text = '[Text]\n' + text;
  }
  if (text.trim().length < 30) {
    if (['.pdf', '.docx', '.pptx', '.png', '.jpg', '.jpeg', '.webp', '.heic'].includes(ext))
      return '[Visual source]\nThis source has no usable text layer. Inspect the attached visual assets and cite the specific asset for visual evidence.';
    throw Error('Not enough readable text. Try a clearer scan or a text-based file.');
  }
  return text;
}
