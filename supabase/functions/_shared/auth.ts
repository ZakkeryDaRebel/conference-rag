type PublishableKeyMap = Record<string, unknown>;

function getPublishableKey(): string {
  const rawKeys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  if (!rawKeys) {
    throw new Error("SUPABASE_PUBLISHABLE_KEYS is not configured");
  }

  let keys: PublishableKeyMap;
  try {
    keys = JSON.parse(rawKeys) as PublishableKeyMap;
  } catch {
    throw new Error("SUPABASE_PUBLISHABLE_KEYS is not valid JSON");
  }

  const defaultKey = keys.default;
  const firstKey = Object.values(keys).find(
    (value): value is string => typeof value === "string",
  );
  const key = typeof defaultKey === "string" ? defaultKey : firstKey;

  if (!key) {
    throw new Error("No publishable key is configured");
  }

  return key;
}

/** Verify the bearer token with Supabase Auth and return its user's ID. */
export async function getAuthenticatedUserId(
  authorizationHeader: string | null,
): Promise<string | null> {
  const match = authorizationHeader?.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!supabaseUrl) {
    throw new Error("SUPABASE_URL is not configured");
  }

  const response = await fetch(
    `${supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        apikey: getPublishableKey(),
        Authorization: `Bearer ${match[1]}`,
      },
    },
  );

  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) {
    throw new Error(`Supabase Auth returned HTTP ${response.status}`);
  }

  const user: unknown = await response.json();
  if (
    typeof user !== "object" || user === null ||
    !("id" in user) || typeof user.id !== "string"
  ) {
    return null;
  }

  return user.id;
}
