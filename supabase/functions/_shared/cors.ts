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

function getAllowedOrigins(): string[] {
  const env = Deno.env.get('ALLOWED_ORIGINS');
  if (env) {
    return env.split(',').map((o) => o.trim()).filter(Boolean);
  }
  return DEFAULT_ORIGINS;
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
