import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import * as authController from './auth.controller';
import { loginSchema, changePasswordSchema } from './auth.schema';
import { validateBody } from '../../middleware/validate';
import { requireAuth } from '../../middleware/requireAuth';

// Throttle login attempts to slow down credential-stuffing / brute force.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // per IP per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: { message: 'Too many login attempts. Please try again later.', code: 'RATE_LIMITED' },
  },
});

export const authRouter = Router();

authRouter.post('/login', loginLimiter, validateBody(loginSchema), authController.login);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', requireAuth, authController.me);
authRouter.post(
  '/change-password',
  requireAuth,
  validateBody(changePasswordSchema),
  authController.changePassword,
);
