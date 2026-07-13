import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Exact first-page logo fingerprints from the canonical customer hardcopies.
// Detection is visual-template evidence only. It never derives A2000 style/color/qty.
const VISUAL_BRANDS = Object.freeze([
  {
    code: 'VERSONA',
    signature: '78000000f4000000fedfdb4afeecd7f2fa6eddf7b24ffb55e40000007c000000',
    maxHammingDistance: 12
  },
  {
    code: 'ITSFASHION',
    signature: '0000000028302200ff3ffff8e72ffff8e72ffff8f72ffff80000888800000000',
    maxHammingDistance: 12
  }
]);

function readToken(buffer, state) {
  let index = state.index;
  while (index < buffer.length) {
    const byte = buffer[index];
    if (byte === 35) {
      while (index < buffer.length && buffer[index] !== 10 && buffer[index] !== 13) index += 1;
      continue;
    }
    if (byte === 9 || byte === 10 || byte === 13 || byte === 32) {
      index += 1;
      continue;
    }
    break;
  }

  const start = index;
  while (index < buffer.length) {
    const byte = buffer[index];
    if (byte === 9 || byte === 10 || byte === 13 || byte === 32 || byte === 35) break;
    index += 1;
  }

  state.index = index;
  return buffer.subarray(start, index).toString('ascii');
}

export function parsePpm(buffer) {
  const state = { index: 0 };
  const magic = readToken(buffer, state);
  const width = Number(readToken(buffer, state));
  const height = Number(readToken(buffer, state));
  const max = Number(readToken(buffer, state));

  if (magic !== 'P6' || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || max !== 255) {
    throw new Error('UNSUPPORTED_PPM');
  }

  while (state.index < buffer.length && [9, 10, 13, 32].includes(buffer[state.index])) state.index += 1;
  const pixels = buffer.subarray(state.index);
  const expected = width * height * 3;

  if (pixels.length < expected) {
    throw new Error(`TRUNCATED_PPM:${pixels.length}/${expected}`);
  }

  return { width, height, pixels: pixels.subarray(0, expected) };
}

export function perceptualSignatureFromPpm(buffer, gridWidth = 32, gridHeight = 8) {
  const { width, height, pixels } = parsePpm(buffer);
  const values = [];

  for (let gy = 0; gy < gridHeight; gy += 1) {
    const y0 = Math.floor((gy * height) / gridHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / gridHeight));

    for (let gx = 0; gx < gridWidth; gx += 1) {
      const x0 = Math.floor((gx * width) / gridWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / gridWidth));
      let weighted = 0;
      let count = 0;

      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * width + x) * 3;
          const red = pixels[offset];
          const green = pixels[offset + 1];
          const blue = pixels[offset + 2];
          weighted += (299 * red) + (587 * green) + (114 * blue);
          count += 1;
        }
      }

      values.push(weighted / (1000 * Math.max(count, 1)));
    }
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const bits = values.map(value => value < mean ? 1 : 0);
  let signature = '';

  for (let index = 0; index < bits.length; index += 4) {
    const nibble = (
      (bits[index] << 3)
      | (bits[index + 1] << 2)
      | (bits[index + 2] << 1)
      | bits[index + 3]
    );
    signature += nibble.toString(16);
  }

  return signature;
}

export function hammingDistanceHex(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (!a || a.length !== b.length) return Number.POSITIVE_INFINITY;

  let distance = 0;
  for (let index = 0; index < a.length; index += 1) {
    const xor = Number.parseInt(a[index], 16) ^ Number.parseInt(b[index], 16);
    distance += ((xor >> 0) & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return distance;
}

export function identifyVisualBrandBySignature(signature) {
  const matches = VISUAL_BRANDS
    .map(brand => ({
      ...brand,
      distance: hammingDistanceHex(signature, brand.signature)
    }))
    .filter(brand => brand.distance <= brand.maxHammingDistance)
    .sort((left, right) => left.distance - right.distance);

  if (!matches.length) return null;
  if (matches.length > 1 && matches[0].distance === matches[1].distance) return null;

  return {
    code: matches[0].code,
    signature,
    distance: matches[0].distance,
    evidence: 'FIRST_PAGE_EMBEDDED_IMAGE_PERCEPTUAL_FINGERPRINT'
  };
}

async function extractFirstPagePpmImages(buffer) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a2000-pdf-brand-'));
  const pdfPath = path.join(dir, 'source.pdf');
  const root = path.join(dir, 'image');

  try {
    await fs.writeFile(pdfPath, buffer);
    await execFileAsync('pdfimages', ['-f', '1', '-l', '1', pdfPath, root], {
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024
    });

    const files = (await fs.readdir(dir))
      .filter(name => /^image-\d+\.ppm$/i.test(name))
      .sort();

    const images = [];
    for (const file of files) {
      const bytes = await fs.readFile(path.join(dir, file));
      images.push({
        file,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        bytes
      });
    }
    return images;
  } catch {
    return [];
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function detectPdfVisualBrandFromBuffer(buffer) {
  const images = await extractFirstPagePpmImages(buffer);

  for (const image of images) {
    try {
      const signature = perceptualSignatureFromPpm(image.bytes);
      const identified = identifyVisualBrandBySignature(signature);
      if (identified) {
        return {
          ...identified,
          image_sha256: image.sha256,
          image_file: image.file
        };
      }
    } catch {
      // Non-PPM or malformed image. Continue with other embedded images.
    }
  }

  return null;
}

export async function annotatePdfTextWithVisualBrand(text, buffer) {
  const rawText = String(text || '');
  if (/\[A2000_PDF_VISUAL_BRAND:/i.test(rawText)) return rawText;

  const visualBrand = await detectPdfVisualBrandFromBuffer(buffer);
  if (!visualBrand) return rawText;

  return (
    `${rawText}\n`
    + `[A2000_PDF_VISUAL_BRAND:${visualBrand.code}:${visualBrand.signature}]\n`
  );
}
