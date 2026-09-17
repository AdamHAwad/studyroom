import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { DATA, ROOT, id, put, all, get } from './db';
import { pythonBinary, popplerBinary, sofficeBinary } from './platform';
import { pathToFileURL } from 'node:url';
import type { Source } from '../src/types';
const exec = promisify(execFile);
async function visualPages(pdf: string): Promise<Set<number> | null> {
  const python = pythonBinary();
  if (!python) return null;
  try {
    const r = await exec(python, [path.join(ROOT, 'scripts/pdf-visuals.py'), pdf], {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 60000,
    });
    return new Set(JSON.parse(r.stdout));
  } catch {
    return null;
  }
}

export type Asset = {
  id: string;
  sourceId: string;
  courseId: string;
  locator: string;
  path: string;
  width: number;
  height: number;
  kind: string;
  name: string;
};
export async function extractAssets(source: Source) {
  const dir = path.join(DATA, 'assets', source.id);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(source.name).toLowerCase();
  let candidates: { path: string; locator: string; name: string }[] = [];
  const warnings: string[] = [];
  if (ext === '.pdf') {
    const relevant = await visualPages(source.path);
    await exec(
      popplerBinary('pdftoppm'),
      ['-scale-to', '1400', '-png', source.path, path.join(dir, 'page')],
      {
        timeout: 600000,
        maxBuffer: 1024 * 1024 * 10,
      },
    );
    candidates = fs
      .readdirSync(dir)
      .filter(
        (f) => /^page-\d+\.png$/.test(f) && (!relevant || relevant.has(Number(f.match(/\d+/)![0]))),
      )
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => ({
        path: path.join(dir, f),
        locator: `Page ${Number(f.match(/\d+/)![0])}`,
        name: f,
      }));
  } else if (ext === '.docx' || ext === '.pptx') {
    // Render full pages to preserve charts, SmartArt, drawn arrows, and grouped shapes.
    const office = sofficeBinary();
    if (office) {
      const profile = path.join(dir, 'office-profile');
      try {
        await exec(
          office,
          [
            '-env:UserInstallation=' + pathToFileURL(profile).href,
            '--headless',
            '--convert-to',
            'pdf',
            '--outdir',
            dir,
            source.path,
          ],
          { timeout: 180000, maxBuffer: 5 * 1024 * 1024 },
        );
        const pdf = path.join(dir, path.basename(source.path, path.extname(source.path)) + '.pdf');
        if (!fs.existsSync(pdf)) throw Error('Office conversion produced no PDF');
        const relevant = await visualPages(pdf);
        await exec(
          popplerBinary('pdftoppm'),
          ['-scale-to', '1400', '-png', pdf, path.join(dir, 'rendered')],
          {
            timeout: 600000,
            maxBuffer: 10 * 1024 * 1024,
          },
        );
        candidates = fs
          .readdirSync(dir)
          .filter(
            (f) =>
              /^rendered-\d+\.png$/.test(f) &&
              (!relevant || relevant.has(Number(f.match(/\d+/)![0]))),
          )
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .map((f) => ({
            path: path.join(dir, f),
            locator: `${ext === '.pptx' ? 'Slide' : 'Rendered page'} ${Number(f.match(/\d+/)![0])}`,
            name: f,
          }));
      } catch {
        warnings.push(
          'Full-page document rendering failed. Embedded pictures are available, but a PDF export may preserve diagrams more accurately.',
        );
      }
    }
    if (!candidates.length) {
      const python = pythonBinary();
      if (!python)
        throw Error(
          'Reading graphics from this file type needs Python 3. Install it, then upload again.',
        );
      const r = await exec(python, [path.join(ROOT, 'scripts', 'assets.py'), source.path, dir], {
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120000,
      });
      const result = JSON.parse(r.stdout);
      candidates = result.assets;
      warnings.push(...result.warnings);
    }
  } else if (['.png', '.jpg', '.jpeg', '.webp', '.heic'].includes(ext)) {
    candidates = [{ path: source.path, locator: 'Image', name: source.name }];
  }
  const assets: Asset[] = [];
  for (const candidate of candidates) {
    try {
      const image = sharp(candidate.path, { limitInputPixels: 100000000 });
      const meta = await image.metadata();
      if ((meta.width || 0) < 60 || (meta.height || 0) < 60) {
        warnings.push(`Small image omitted: ${candidate.name}`);
        continue;
      }
      const assetId = id(),
        dest = path.join(dir, assetId + '.png');
      const info = await image
        .rotate()
        .resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true })
        .png()
        .toFile(dest);
      const asset: Asset = {
        id: assetId,
        sourceId: source.id,
        courseId: source.courseId,
        locator: candidate.locator,
        path: dest,
        width: info.width,
        height: info.height,
        kind: ext === '.pdf' ? 'page' : 'embedded-image',
        name: candidate.name,
      };
      put('assets', asset);
      assets.push(asset);
    } catch {
      warnings.push(
        `Image could not be decoded: ${candidate.name}. Provide a PNG or PDF export if it matters.`,
      );
    }
  }
  return { assets, warnings };
}
export async function materializeImage(image: any, sourceIds: string[]) {
  if (!image) return null;
  const asset = get<Asset>('assets', image.assetId);
  if (!asset || !sourceIds.includes(asset.sourceId))
    throw Error('Generated image is not part of these materials.');
  if (image.side === 'question' && image.revealsAnswer)
    throw Error('A question image was marked as revealing the answer.');
  let cropId: string | undefined;
  if (image.crop) {
    const [x, y, w, h] = image.crop as number[];
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.001 || y + h > 1.001)
      throw Error('Image crop is outside the source image.');
    const left = Math.round(x * asset.width),
      top = Math.round(y * asset.height);
    const width = Math.min(Math.round(w * asset.width), asset.width - left),
      height = Math.min(Math.round(h * asset.height), asset.height - top);
    if (width < 30 || height < 30) throw Error('Image crop is too small to read.');
    cropId = id();
    const dest = path.join(DATA, 'assets', asset.sourceId, cropId + '.png');
    await sharp(asset.path).extract({ left, top, width, height }).png().toFile(dest);
    put('crops', { id: cropId, assetId: asset.id, path: dest });
  }
  return { ...image, cropId, sourceId: asset.sourceId, locator: asset.locator };
}
