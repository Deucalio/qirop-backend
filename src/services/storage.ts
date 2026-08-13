import sharp from 'sharp';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import { env } from '../config/env';
import { AppError } from '../utils/apiResponse';

/**
 * Single choke-point for all file I/O, backed by the external FileStore API.
 * The FileStore bearer token lives only here (server-side) and is never sent
 * to the browser. Public display images are exposed via getPublicPreviewUrl;
 * private documents are streamed back through proxyDownload after the caller
 * has checked permissions.
 */
const BASE = env.FILESTORE_URL;
const TOKEN = env.FILESTORE_TOKEN;
const APP_ID = env.FILESTORE_APP_ID;

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}` };
}

function ensureConfigured(): void {
  if (!TOKEN) {
    throw new AppError('File storage is not configured', 503, 'STORAGE_NOT_CONFIGURED');
  }
}

/** Make a filesystem-safe, collision-free filename (cuid-like prefix + sanitized name). */
function uniqueName(originalName: string): string {
  const safe = (originalName || 'file')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/_+/g, '_')
    .slice(-80) || 'file';
  return `${randomUUID()}-${safe}`;
}

/**
 * Automatically optimize and convert uploaded image buffers:
 * - Auto-orients photos based on EXIF camera orientation metadata.
 * - Converts HEIC, HEIF, BMP, TIFF, PNG to web-friendly JPEG.
 * - Resizes large photos to a max 800x800 box (under 100KB), loading fast on mobile data.
 */
export async function optimizeImageBuffer(
  buffer: Buffer,
  originalName: string,
  contentType?: string,
): Promise<{ buffer: Buffer; name: string; contentType: string }> {
  const isImage =
    (contentType && contentType.startsWith('image/')) ||
    /\.(heic|heif|png|jpe?g|webp|gif|bmp|tiff)$/i.test(originalName);

  if (!isImage) {
    return { buffer, name: originalName, contentType: contentType || 'application/octet-stream' };
  }

  try {
    const processed = await sharp(buffer)
      .rotate()
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    const baseName = originalName.replace(/\.[^/.]+$/, '') || 'photo';
    return {
      buffer: processed,
      name: `${baseName}.jpg`,
      contentType: 'image/jpeg',
    };
  } catch {
    return { buffer, name: originalName, contentType: contentType || 'application/octet-stream' };
  }
}

/** Upload a buffer to `dir`, returning the stored virtual path. */
export async function uploadFile(
  rawBuffer: Buffer,
  originalName: string,
  dir: string,
  rawContentType?: string,
): Promise<string> {
  ensureConfigured();
  const { buffer, name, contentType } = await optimizeImageBuffer(rawBuffer, originalName, rawContentType);
  const form = new FormData();
  const blob = new Blob([buffer as unknown as ArrayBuffer], contentType ? { type: contentType } : undefined);
  form.append('file', blob, uniqueName(name));
  form.append('path', dir);

  const res = await fetch(`${BASE}/files/upload`, { method: 'POST', headers: authHeaders(), body: form });
  if (!res.ok) {
    throw new AppError(`File upload failed (${res.status})`, 502, 'UPLOAD_FAILED');
  }
  const json = (await res.json()) as { file?: { path?: string } };
  if (!json.file?.path) throw new AppError('File upload returned no path', 502, 'UPLOAD_FAILED');
  return json.file.path;
}

/** Upload multiple files to `dir` in one batch request via FileStore API. */
export async function uploadFilesBatch(
  files: Array<{ buffer: Buffer; originalName: string; contentType?: string }>,
  dir: string,
): Promise<string[]> {
  if (files.length === 0) return [];
  ensureConfigured();
  const form = new FormData();
  for (const f of files) {
    const opt = await optimizeImageBuffer(f.buffer, f.originalName, f.contentType);
    const blob = new Blob([opt.buffer as unknown as ArrayBuffer], opt.contentType ? { type: opt.contentType } : undefined);
    form.append('files[]', blob, uniqueName(opt.name));
  }
  form.append('path', dir);

  const res = await fetch(`${BASE}/files/batch-upload`, { method: 'POST', headers: authHeaders(), body: form });
  if (!res.ok) {
    throw new AppError(`Batch file upload failed (${res.status})`, 502, 'UPLOAD_FAILED');
  }
  const json = (await res.json()) as {
    uploaded?: Array<{ path?: string }>;
    failed?: Array<{ name?: string }>;
  };
  if (json.failed && json.failed.length > 0) {
    const partialPaths = (json.uploaded ?? []).map((u) => u.path).filter((p): p is string => Boolean(p));
    if (partialPaths.length > 0) {
      await deleteFilesBatch(partialPaths).catch(() => undefined);
    }
    throw new AppError('One or more files failed during batch upload', 502, 'UPLOAD_FAILED');
  }
  const paths = (json.uploaded ?? []).map((u) => u.path).filter((p): p is string => Boolean(p));
  if (paths.length !== files.length) {
    if (paths.length > 0) {
      await deleteFilesBatch(paths).catch(() => undefined);
    }
    throw new AppError(`Batch upload returned ${paths.length} paths for ${files.length} files`, 502, 'UPLOAD_FAILED');
  }
  return paths;
}

/** Delete a stored file. Missing files are treated as already-gone (no throw). */
export async function deleteFile(path: string | null | undefined): Promise<void> {
  if (!path) return;
  ensureConfigured();
  const res = await fetch(`${BASE}/files`, {
    method: 'DELETE',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  if (!res.ok && res.status !== 404) {
    // eslint-disable-next-line no-console
    console.warn(`FileStore delete failed for ${path}: ${res.status}`);
  }
}

/** Delete multiple stored files in one batch request. Missing files are ignored. */
export async function deleteFilesBatch(paths: (string | null | undefined)[]): Promise<void> {
  const validPaths = paths.filter((p): p is string => Boolean(p && typeof p === 'string' && p.trim()));
  if (validPaths.length === 0) return;
  ensureConfigured();
  try {
    const res = await fetch(`${BASE}/files/batch`, {
      method: 'DELETE',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths: validPaths }),
    });
    if (!res.ok && res.status !== 404) {
      // eslint-disable-next-line no-console
      console.warn(`FileStore batch delete failed (${res.status}) for paths:`, validPaths);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('FileStore batch delete error:', err);
  }
}

/** FileStore has no in-place update: upload the new file, then delete the old one. */
export async function replaceFile(
  oldPath: string | null | undefined,
  buffer: Buffer,
  originalName: string,
  dir: string,
  contentType?: string,
): Promise<string> {
  const newPath = await uploadFile(buffer, originalName, dir, contentType);
  if (oldPath) await deleteFile(oldPath).catch(() => undefined);
  return newPath;
}

/** Public, token-less preview URL served through our backend same-origin proxy. */
export function getPublicPreviewUrl(path: string): string {
  if (!path) return '';
  if (path.startsWith('/api/media/preview')) return path;
  return `/api/media/preview?path=${encodeURIComponent(path)}`;
}

/** getPublicPreviewUrl but null-safe (for optional stored paths). */
export function publicUrl(path: string | null | undefined): string | null {
  return path ? getPublicPreviewUrl(path) : null;
}

/**
 * Stream a public image preview back to the client via our server.
 * Ensures images are served same-origin (bypassing third-party domain/DNS blocks on mobile carriers).
 */
export async function proxyPublicPreview(path: string, res: Response): Promise<void> {
  ensureConfigured();
  const upstream = await fetch(
    `${BASE}/files/preview?path=${encodeURIComponent(path)}&app=${encodeURIComponent(APP_ID)}`,
  );
  if (!upstream.ok) {
    throw new AppError('Image not found', upstream.status === 404 ? 404 : 502, 'DOWNLOAD_FAILED');
  }
  const contentType = upstream.headers.get('content-type') ?? 'image/jpeg';
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.send(buffer);
}

/**
 * Stream a private file back to the caller using the server-side token.
 * The caller MUST have already authorized the requester.
 */
export async function proxyDownload(
  path: string,
  res: Response,
  dispositionType: 'inline' | 'attachment' = 'attachment',
): Promise<void> {
  ensureConfigured();
  const upstream = await fetch(
    `${BASE}/files/download?path=${encodeURIComponent(path)}&disposition=${dispositionType}`,
    { headers: authHeaders() },
  );
  if (!upstream.ok) {
    throw new AppError('File not found', upstream.status === 404 ? 404 : 502, 'DOWNLOAD_FAILED');
  }
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  const disposition = upstream.headers.get('content-disposition');
  if (disposition) res.setHeader('Content-Disposition', disposition);
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.send(buffer);
}

/**
 * Read a stored file into memory, for embedding rather than streaming — a PDF
 * needs the bytes inline, not a URL, because the renderer cannot fetch.
 *
 * Returns null instead of throwing: a missing logo should cost a document its
 * letterhead, not fail the whole print run.
 */
export async function fetchFileBuffer(
  path: string | null | undefined,
): Promise<{ buffer: Buffer; contentType: string } | null> {
  if (!path) return null;
  try {
    ensureConfigured();
    const upstream = await fetch(
      `${BASE}/files/download?path=${encodeURIComponent(path)}&disposition=inline`,
      { headers: authHeaders() },
    );
    if (!upstream.ok) return null;
    return {
      buffer: Buffer.from(await upstream.arrayBuffer()),
      contentType: upstream.headers.get('content-type') ?? 'application/octet-stream',
    };
  } catch {
    return null;
  }
}
