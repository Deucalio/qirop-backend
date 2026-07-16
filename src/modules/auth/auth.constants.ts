/** Name of the httpOnly cookie that carries the session JWT. */
export const AUTH_COOKIE = 'qirop_token';

/** Cookie lifetime in ms (kept in sync with JWT_EXPIRES_IN default of 7d). */
export const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
