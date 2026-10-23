// Supabase client requests from browser apps send these headers during CORS
// preflight. The wildcard is suitable here because the function authenticates
// each caller with their Supabase user token and does not use cookie credentials.
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
