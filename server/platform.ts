import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { ROOT } from './db';

const exec = promisify(execFile);
export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';

const windowsExtensions = ['', '.exe', '.cmd', '.bat'];
export function findProgram(name: string, fallbacks: string[] = []): string | null {
  const exts = isWindows ? windowsExtensions : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  for (const p of fallbacks) {
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

export function popplerBinary(name: 'pdftotext' | 'pdftoppm'): string {
  const p = findProgram(name, [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`]);
  if (!p)
    throw Error(
      `Reading this file type needs poppler (${name}). Install it with your system's package manager, then upload again.`,
    );
  return p;
}

export function pythonBinary(): string | null {
  const venv = path.join(
    ROOT,
    '.venv',
    isWindows ? 'Scripts' : 'bin',
    isWindows ? 'python.exe' : 'python',
  );
  if (fs.existsSync(venv)) return venv;
  return (
    findProgram('python3', ['/usr/bin/python3', '/opt/homebrew/bin/python3']) ||
    findProgram('python', [])
  );
}

export function sofficeBinary(): string | null {
  return findProgram('soffice', [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    path.join(
      process.env['ProgramFiles'] || 'C:\\Program Files',
      'LibreOffice',
      'program',
      'soffice.exe',
    ),
    path.join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'LibreOffice',
      'program',
      'soffice.exe',
    ),
  ]);
}

export async function ocrPdfText(file: string): Promise<string> {
  if (isMac) {
    const ocr = path.join(ROOT, 'scripts', 'ocr');
    if (!fs.existsSync(ocr)) {
      const swiftc = findProgram('swiftc', ['/usr/bin/swiftc', '/usr/local/bin/swiftc']);
      if (!swiftc)
        throw Error(
          'Scanned PDF text needs the OCR helper, and swiftc is not available to build it.',
        );
      await exec(swiftc, [path.join(ROOT, 'scripts', 'ocr.swift'), '-o', ocr], { timeout: 600000 });
    }
    const out = await exec(ocr, [file], { maxBuffer: 100 * 1024 * 1024, timeout: 600000 });
    return out.stdout;
  }
  const pdftoppm = popplerBinary('pdftoppm');
  const tesseract = findProgram('tesseract', [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Tesseract-OCR', 'tesseract.exe'),
  ]);
  if (!tesseract)
    throw Error(
      'Scanned PDF text needs an OCR tool. On macOS it is built in; elsewhere install tesseract and make sure it is on the PATH.',
    );
  const dir = path.join(ROOT, 'data', 'tmp', 'ocr-' + path.basename(file, path.extname(file)));
  fs.mkdirSync(dir, { recursive: true });
  try {
    await exec(pdftoppm, ['-r', '150', '-png', file, path.join(dir, 'page')], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 600000,
    });
    const pages = fs
      .readdirSync(dir)
      .filter((f) => /^page-\d+\.png$/.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    let text = '';
    for (const page of pages) {
      const out = await exec(tesseract, [path.join(dir, page), 'stdout'], {
        maxBuffer: 30 * 1024 * 1024,
        timeout: 120000,
      });
      text += `\n[Page ${Number(page.match(/\d+/)![0])}]\n${out.stdout}`;
    }
    return text.trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function ocrImageText(file: string): Promise<string> {
  if (isMac) {
    const ocr = path.join(ROOT, 'scripts', 'ocr');
    if (!fs.existsSync(ocr)) {
      const swiftc = findProgram('swiftc', ['/usr/bin/swiftc', '/usr/local/bin/swiftc']);
      if (!swiftc)
        throw Error('Image text needs the OCR helper, and swiftc is not available to build it.');
      await exec(swiftc, [path.join(ROOT, 'scripts', 'ocr.swift'), '-o', ocr], { timeout: 600000 });
    }
    const out = await exec(ocr, [file], { maxBuffer: 30 * 1024 * 1024, timeout: 120000 });
    return out.stdout;
  }
  const tesseract = findProgram('tesseract', [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Tesseract-OCR', 'tesseract.exe'),
  ]);
  if (!tesseract)
    throw Error(
      'Image text needs an OCR tool. On macOS it is built in; elsewhere install tesseract and make sure it is on the PATH.',
    );
  const out = await exec(tesseract, [file, 'stdout'], {
    maxBuffer: 30 * 1024 * 1024,
    timeout: 120000,
  });
  return `[Image]\n${out.stdout}`;
}

// .cmd and .bat shims need the Windows command interpreter; quote every token so
// paths with spaces and prompts pass through safely.
export function agentSpawn(bin: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (isWindows && /\.(cmd|bat)$/i.test(bin)) {
    const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replaceAll('"', '\\"')}"` : s);
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', [bin, ...args].map(quote).join(' ')],
      {
        ...options,
        windowsVerbatimArguments: true,
      },
    );
  }
  return spawn(bin, args, options);
}
