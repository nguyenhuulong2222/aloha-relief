import type { MiddlewareHandler } from "hono";

/**
 * Security headers. PayPal's v6 SDK loads from *.paypal.com and opens a popup, which needs
 * Cross-Origin-Opener-Policy: same-origin-allow-popups (as in PayPal's v6 sample integration).
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://*.paypal.com https://*.paypalobjects.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.paypal.com https://*.paypalobjects.com",
  "connect-src 'self' https://*.paypal.com https://*.paypalobjects.com",
  "frame-src https://*.paypal.com",
  "font-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header("Content-Security-Policy", CSP);
  c.header("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
};
