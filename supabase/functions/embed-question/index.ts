import { getAuthenticatedUserId } from "../_shared/auth.ts";
import { corsHeaders } from "../_shared/cors.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

Deno.serve(async (request: Request): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let userId: string | null;
  try {
    userId = await getAuthenticatedUserId(
      request.headers.get("Authorization"),
    );
  } catch (error) {
    console.error("Could not verify the Supabase user:", error);
    return jsonResponse({ error: "Authentication service unavailable" }, 503);
  }

  if (!userId) {
    return jsonResponse({ error: "Authentication required" }, 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Request body must be valid JSON" }, 400);
  }

  const question =
    typeof body === "object" && body !== null && "question" in body &&
      typeof body.question === "string"
      ? body.question.trim()
      : "";

  if (!question) {
    return jsonResponse({ error: 'A non-empty "question" is required' }, 400);
  }

  const openAiApiKey = Deno.env.get("OPENAI_API_KEY");
  if (!openAiApiKey) {
    console.error("OPENAI_API_KEY is not configured");
    return jsonResponse({ error: "Embedding service is not configured" }, 500);
  }

  try {
    const openAiResponse = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openAiApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: question,
      }),
    });

    if (!openAiResponse.ok) {
      console.error(`OpenAI embedding request returned HTTP ${openAiResponse.status}`);
      return jsonResponse({ error: "Could not generate embedding" }, 502);
    }

    const result: unknown = await openAiResponse.json();
    const embedding =
      typeof result === "object" && result !== null && "data" in result &&
        Array.isArray(result.data) && result.data.length > 0 &&
        typeof result.data[0] === "object" && result.data[0] !== null &&
        "embedding" in result.data[0]
        ? result.data[0].embedding
        : null;

    if (!Array.isArray(embedding)) {
      console.error("OpenAI response did not contain an embedding array");
      return jsonResponse({ error: "Could not generate embedding" }, 502);
    }

    return jsonResponse({ embedding });
  } catch (error) {
    console.error("OpenAI embedding request failed:", error);
    return jsonResponse({ error: "Embedding service unavailable" }, 502);
  }
});
