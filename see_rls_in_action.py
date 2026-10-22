import json
from supabase import create_client

with open("config.public.json", encoding="utf-8") as f:
    public = json.load(f)

client = create_client(
    public["SUPABASE_URL"],
    public["SUPABASE_PUBLISHABLE_KEY"],
)

# The anon role has a public SELECT policy on page_views.
result = client.table("page_views").select("*").limit(5).execute()
print(f"page_views: {len(result.data)} rows")

# The anon role has no SELECT policy for sentence_embeddings.
result = client.table("sentence_embeddings").select("*").limit(5).execute()
print(f"sentence_embeddings: {len(result.data)} rows (expected: 0)")