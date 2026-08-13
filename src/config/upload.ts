import multer from 'multer';
import { AppError } from '../utils/apiResponse';

/**
 * Multer with in-memory storage: it only parses the multipart request into
 * `req.file.buffer` — nothing is written to this server's disk. The buffer is
 * forwarded straight to the FileStore service (see services/storage.ts).
 */
const storage = multer.memoryStorage();

const ALLOWED_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  'image/bmp',
  'image/tiff',
]);

/** Images only, ≤ 15 MB (accepts high-res mobile camera / iPhone HEIC photos before backend optimization). */
export const imageUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
    if (ALLOWED_IMAGE_MIME.has(mime) || ['heic', 'heif', 'jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext || '')) {
      cb(null, true);
    } else {
      cb(new AppError('Only image files (png, jpg, webp, heic, gif) are allowed', 422, 'INVALID_FILE_TYPE'));
    }
  },
});

/** Any file type, ≤ 15 MB (homework attachments, and documents). */
export const attachmentUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
});

/** Receipt images & expense vouchers, ≤ 15 MB, max 10 files per request. */
export const receiptUpload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const ext = (file.originalname || '').split('.').pop()?.toLowerCase();
    if (ALLOWED_IMAGE_MIME.has(mime) || ['heic', 'heif', 'jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext || '')) {
      cb(null, true);
    } else {
      cb(new AppError('Only image files (png, jpg, webp, heic, gif) are allowed', 422, 'INVALID_FILE_TYPE'));
    }
  },
});
