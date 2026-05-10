/** Shared CORS helpers for all edge functions.
 *
 *  Allowed origins are read from the ALLOWED_ORIGINS env var (comma-separated).
 *  Defaults to localhost dev servers if not set.
 *
 *  Set in Supabase:
 *    supabase secrets set ALLOWED_ORIGINS="https://your-domain.com,http://localhost:5173"
 */

const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
];

/** Always allowed — these origins are exclusive to native Capacitor apps. A
 *  regular browser refuses to set them as the Origin header for cross-site
 *  requests, so they can't be claimed by a malicious web page. The JWT auth
 *  check in each function is the real security boundary; the CORS allowlist
 *  just lets the preflight succeed so the actual call goes through.
 *    capacitor://localhost — iOS Capacitor WebView
 *    https://localhost     — Android Capacitor when androidScheme: 'https'
 *    http://localhost      — Android Capacitor when androidScheme: 'http' */
const NATIVE_ORIGINS = [
  'capacitor://localhost',
  'https://localhost',
  'http://localhost',
];

function getAllowedOrigins(): string[] {
  const env = Deno.env.get('ALLOWED_ORIGINS');
  const fromEnv = env
    ? env.split(',').map((o) => o.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;
  return [...fromEnv, ...NATIVE_ORIGINS];
}

/** Check whether the request's Origin header is allowed. */
export function isOriginAllowed(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  return getAllowedOrigins().includes(origin);
}

/** Return CORS headers scoped to the request origin (if allowed). */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  const allowed = getAllowedOrigins();

  return {
    'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

/** Standard preflight response. */
export function handlePreflight(req: Request): Response {
  return new Response('ok', { headers: corsHeaders(req) });
}
