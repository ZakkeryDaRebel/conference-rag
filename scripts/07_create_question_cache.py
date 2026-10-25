"""Create the shared question/embedding cache and its restricted RPCs.

Usage:
    python scripts/07_create_question_cache.py

The script reads only SUPABASE_DB_URL from config.secret.json. The table is
global (no user_id); its contents are available to Edge Functions, while the
top-five RPC exposes only question counts to authenticated users.
"""

import json
import sys


SCHEMA_STATEMENTS = (
    "CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions",
    """
    CREATE TABLE IF NOT EXISTS public.question_embedding_cache (
      normalized_question text PRIMARY KEY,
      question text NOT NULL,
      embedding vector(1536) NOT NULL,
      asked_count bigint NOT NULL DEFAULT 1 CHECK (asked_count > 0)
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS question_embedding_cache_question_trgm_idx
      ON public.question_embedding_cache
      USING gin (normalized_question gin_trgm_ops)
    """,
    "ALTER TABLE public.question_embedding_cache ENABLE ROW LEVEL SECURITY",
    "REVOKE ALL ON TABLE public.question_embedding_cache FROM PUBLIC, anon, authenticated",
    "GRANT SELECT, INSERT, UPDATE ON TABLE public.question_embedding_cache TO service_role",
    """
    CREATE OR REPLACE FUNCTION public.find_cached_question_embedding(
      p_normalized_question text,
      p_min_similarity real DEFAULT 0.94
    )
    RETURNS TABLE (
      question text,
      normalized_question text,
      embedding vector(1536),
      similarity real
    )
    LANGUAGE sql
    VOLATILE
    SECURITY INVOKER
    SET search_path = public, extensions
    AS $function$
      WITH candidate AS MATERIALIZED (
        SELECT cache.normalized_question
        FROM public.question_embedding_cache AS cache
        WHERE cache.normalized_question = p_normalized_question
          OR (
            length(p_normalized_question) >= 30
            AND cache.normalized_question % p_normalized_question
            AND similarity(cache.normalized_question, p_normalized_question)
              >= p_min_similarity
          )
        ORDER BY similarity(cache.normalized_question, p_normalized_question) DESC
        LIMIT 1
        FOR UPDATE
      )
      UPDATE public.question_embedding_cache AS cache
      SET asked_count = cache.asked_count + 1
      FROM candidate
      WHERE cache.normalized_question = candidate.normalized_question
      RETURNING
        cache.question,
        cache.normalized_question,
        cache.embedding,
        similarity(cache.normalized_question, p_normalized_question);
    $function$
    """,
    """
    CREATE OR REPLACE FUNCTION public.record_question_embedding(
      p_question text,
      p_normalized_question text,
      p_embedding vector(1536)
    )
    RETURNS void
    LANGUAGE sql
    VOLATILE
    SECURITY INVOKER
    SET search_path = public
    AS $function$
      INSERT INTO public.question_embedding_cache AS existing (
        question, normalized_question, embedding, asked_count
      )
      VALUES (p_question, p_normalized_question, p_embedding, 1)
      ON CONFLICT (normalized_question) DO UPDATE
        SET asked_count = existing.asked_count + 1;
    $function$
    """,
    "REVOKE ALL ON FUNCTION public.find_cached_question_embedding(text, real) FROM PUBLIC, anon, authenticated",
    "GRANT EXECUTE ON FUNCTION public.find_cached_question_embedding(text, real) TO service_role",
    "REVOKE ALL ON FUNCTION public.record_question_embedding(text, text, vector) FROM PUBLIC, anon, authenticated",
    "GRANT EXECUTE ON FUNCTION public.record_question_embedding(text, text, vector) TO service_role",
    """
    CREATE OR REPLACE FUNCTION public.get_top_questions()
    RETURNS TABLE (question text, asked_count bigint)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = ''
    AS $function$
      SELECT cache.question, cache.asked_count
      FROM public.question_embedding_cache AS cache
      WHERE auth.uid() IS NOT NULL
      ORDER BY cache.asked_count DESC, cache.normalized_question ASC
      LIMIT 5;
    $function$
    """,
    "REVOKE ALL ON FUNCTION public.get_top_questions() FROM PUBLIC, anon",
    "GRANT EXECUTE ON FUNCTION public.get_top_questions() TO authenticated",
)


def load_database_url():
    try:
        with open("config.secret.json", "r", encoding="utf-8") as config_file:
            config = json.load(config_file)
    except FileNotFoundError:
        print("config.secret.json was not found in the project directory.")
        return None
    except json.JSONDecodeError:
        print("config.secret.json is not valid JSON.")
        return None

    database_url = config.get("SUPABASE_DB_URL")
    if not database_url:
        print("Add SUPABASE_DB_URL to config.secret.json before running this script.")
        return None
    return database_url


def main():
    database_url = load_database_url()
    if not database_url:
        return 1

    try:
        import psycopg
        from psycopg.conninfo import conninfo_to_dict
    except ImportError:
        print("Missing dependency: install requirements with `pip install -r requirements.txt`.")
        return 1

    try:
        conninfo = conninfo_to_dict(database_url)
        conninfo.setdefault("sslmode", "require")
        with psycopg.connect(**conninfo, connect_timeout=20) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = 0")
                cursor.execute("SET search_path = public, extensions")
                for statement in SCHEMA_STATEMENTS:
                    cursor.execute(statement)
        print("✅ Question embedding cache and restricted RPCs are ready.")
        print("   UI RPC: get_top_questions() returns only the top five question counts.")
        return 0
    except Exception as error:
        print(f"❌ Could not create the question embedding cache: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
