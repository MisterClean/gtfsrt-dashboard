// Applied to the page AND worker responses, because workers do not inherit a
// page's policy. The only remote hosts are the public transit archive and the
// optional basemap. Production hosting needs these same headers; see docs/hosting.md.
export const contentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self' https://storage.googleapis.com/parquet.gtfsrt.io/ https://tiles.openfreemap.org",
  "worker-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export const securityHeaders = {
  'Content-Security-Policy': contentSecurityPolicy,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'X-Frame-Options': 'DENY',
};
