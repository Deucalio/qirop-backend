import multer from 'multer';
import { AppError } from '../utils/apiResponse';

/**
 * Multer with in-memory storage: it only parses the multipart request into
 * `req.file.buffer` — nothing is written to this server's disk. The buffer is
 * forwarded straight to the FileStore service (see services/storage.ts).
 */
const storage = multer.memoryStorage();

const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif']);

/** Images only, ≤ 2 MB (logos, avatars, student photos). */
export const imageUpload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.has(file.mimetype)) cb(null, true);
    else cb(new AppError('Only image files (png, jpg, webp, gif) are allowed', 422, 'INVALID_FILE_TYPE'));
  },
});

/** Any file type, ≤ 10 MB (homework attachments, and later documents). */
export const attachmentUpload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
});
