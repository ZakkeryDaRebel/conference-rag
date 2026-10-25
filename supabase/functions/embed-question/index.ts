import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { requireAuth } from "../_shared/auth.ts";

const CACHE_SIMILARITY_THRESHOLD = 0.94;
const MAX_QUESTION_LENGTH = 2_000;

function normalizeQuestion(question: string): string {
  return question
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/u, "");
}

function parseEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    return value;
  }
  // PostgREST may serialize the pgvector value as its textual form.
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "number")) {
        return parsed;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function getSupabaseSecretKey(): string | null {
  const rawKeys = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!rawKeys) return null;

  try {
    const keys = JSON.parse(rawKeys) as Record<string, unknown>;
    const key = keys.default ?? Object.values(keys)[0];
    return typeof key === "string" ? key : null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Verify authenticated user
  const authResult = await requireAuth(req);
  if ("error" in authResult) return authResult.error;

  try {
    const body = await req.json();
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseSecretKey = getSupabaseSecretKey();

    // Readiness probes must not create a cache entry or spend on an embedding.
    if (body?.action === "health-check") {
      let cacheReady = false;
      if (supabaseUrl && supabaseSecretKey) {
        const healthClient = createClient(supabaseUrl, supabaseSecretKey);
        const { error } = await healthClient
          .from("question_embedding_cache")
          .select("normalized_question")
          .limit(1);
        cacheReady = !error;
      }
      const ready = Boolean(Deno.env.get("OPENAI_API_KEY") && cacheReady);
      return new Response(JSON.stringify({ ready }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { question } = body ?? {};

    if (!question || typeof question !== "string") {
      return new Response(
        JSON.stringify({ error: "Missing or invalid 'question' field" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return new Response(
        JSON.stringify({ error: `Question must be ${MAX_QUESTION_LENGTH} characters or fewer` }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const normalizedQuestion = normalizeQuestion(question);
    if (!normalizedQuestion) {
      return new Response(
        JSON.stringify({ error: "Question must contain letters or numbers" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!supabaseUrl || !supabaseSecretKey) {
      return new Response(
        JSON.stringify({ error: "Supabase secret key is not configured for question caching" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // This server-only client uses the project's secret API key. It can access
    // the shared cache while direct browser access remains blocked by grants/RLS.
    const supabase = createClient(supabaseUrl, supabaseSecretKey);

    // First try exact-normalized text, then a conservative trigram match.
    const { data: cachedMatches, error: cacheLookupError } = await supabase.rpc(
      "find_cached_question_embedding",
      {
        p_normalized_question: normalizedQuestion,
        p_min_similarity: CACHE_SIMILARITY_THRESHOLD,
      },
    );

    if (cacheLookupError) {
      console.error("Question embedding cache lookup failed:", cacheLookupError.message);
      return new Response(
        JSON.stringify({ error: "Question cache is unavailable; run scripts/07_create_question_cache.py" }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } else if (cachedMatches?.length) {
      const match = cachedMatches[0];
      const cachedEmbedding = parseEmbedding(match.embedding);

      if (!cachedEmbedding) {
        console.error("Question embedding cache returned an invalid vector");
      } else {
        return new Response(
          JSON.stringify({
            embedding: cachedEmbedding,
            cached: true,
            cache_similarity: match.similarity,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openaiKey) {
      return new Response(
        JSON.stringify({ error: "OPENAI_API_KEY not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Call OpenAI Embeddings API
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: question,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return new Response(
        JSON.stringify({ error: err.error?.message || "OpenAI API error" }),
        {
          status: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const data = await response.json();
    const embedding = data.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== 1536) {
      return new Response(JSON.stringify({ error: "OpenAI returned an invalid embedding" }), {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: cacheInsertError } = await supabase.rpc("record_question_embedding", {
      p_question: question,
      p_normalized_question: normalizedQuestion,
      p_embedding: embedding,
    });
    if (cacheInsertError) {
      console.error("Question embedding cache insert failed:", cacheInsertError.message);
      return new Response(
        JSON.stringify({ error: "The embedding was generated but could not be saved to the question cache" }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(JSON.stringify({ embedding, cached: false }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
