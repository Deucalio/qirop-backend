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

/** Upload a buffer to `dir`, returning the stored virtual path. */
export async function uploadFile(
  buffer: Buffer,
  originalName: string,
  dir: string,
  contentType?: string,
): Promise<string> {
  ensureConfigured();
  const form = new FormData();
  const blob = new Blob([buffer as unknown as ArrayBuffer], contentType ? { type: contentType } : undefined);
  form.append('file', blob, uniqueName(originalName));
  form.append('path', dir);

  const res = await fetch(`${BASE}/files/upload`, { method: 'POST', headers: authHeaders(), body: form });
  if (!res.ok) {
    throw new AppError(`File upload failed (${res.status})`, 502, 'UPLOAD_FAILED');
  }
  const json = (await res.json()) as { file?: { path?: string } };
  if (!json.file?.path) throw new AppError('File upload returned no path', 502, 'UPLOAD_FAILED');
  return json.file.path;
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

/** Public, token-less preview URL for an image (safe to put in <img src>). Scoped by app id. */
export function getPublicPreviewUrl(path: string): string {
  return `${BASE}/files/preview?path=${encodeURIComponent(path)}&app=${encodeURIComponent(APP_ID)}`;
}

/** getPublicPreviewUrl but null-safe (for optional stored paths). */
export function publicUrl(path: string | null | undefined): string | null {
  return path ? getPublicPreviewUrl(path) : null;
}

/**
 * Stream a private file back to the caller using the server-side token.
 * The caller MUST have already authorized the requester.
 */
export async function proxyDownload(path: string, res: Response): Promise<void> {
  ensureConfigured();
  const upstream = await fetch(`${BASE}/files/download?path=${encodeURIComponent(path)}`, { headers: authHeaders() });
  if (!upstream.ok) {
    throw new AppError('File not found', upstream.status === 404 ? 404 : 502, 'DOWNLOAD_FAILED');
  }
  res.setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/octet-stream');
  const disposition = upstream.headers.get('content-disposition');
  if (disposition) res.setHeader('Content-Disposition', disposition);
  const buffer = Buffer.from(await upstream.arrayBuffer());
  res.send(buffer);
}
