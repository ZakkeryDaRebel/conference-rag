"""Create the pgvector cosine index using a PostgreSQL connection.

Usage:
    Add "SUPABASE_DB_URL" to config.secret.json, then run:
    python scripts/06_create_vector_index.py

Copy the URI from Supabase Dashboard > Connect > Session pooler. Replace
the password placeholder and URL-encode special characters in the password.
The script reads only the SUPABASE_DB_URL key from config.secret.json.
"""

import json
import sys


INDEX_NAME = "sentence_embeddings_embedding_hnsw_idx"


def main():
    try:
        with open("config.secret.json", "r", encoding="utf-8") as config_file:
            connection_uri = json.load(config_file).get("SUPABASE_DB_URL")
    except FileNotFoundError:
        print("config.secret.json was not found in the project directory.")
        return 1
    except json.JSONDecodeError:
        print("config.secret.json is not valid JSON.")
        return 1

    if not connection_uri:
        print("Add a SUPABASE_DB_URL entry to config.secret.json before running this script.")
        return 1

    try:
        import psycopg
        from psycopg.conninfo import conninfo_to_dict
    except ImportError:
        print("Missing dependency: install requirements with `pip install -r requirements.txt`.")
        return 1

    try:
        conninfo = conninfo_to_dict(connection_uri)
        # Require TLS even if the copied URI does not specify it.
        conninfo.setdefault("sslmode", "require")

        # CONCURRENTLY must run outside a transaction block. Autocommit also
        # makes the one-off statement independent of a long-lived transaction.
        with psycopg.connect(**conninfo, connect_timeout=20, autocommit=True) as conn:
            with conn.cursor() as cur:
                cur.execute("SET statement_timeout = 0")

                cur.execute(
                    """
                    SELECT index_class.relname, pg_index.indisvalid
                    FROM pg_class AS table_class
                    JOIN pg_namespace AS table_ns
                      ON table_ns.oid = table_class.relnamespace
                    JOIN pg_index
                      ON pg_index.indrelid = table_class.oid
                    JOIN pg_class AS index_class
                      ON index_class.oid = pg_index.indexrelid
                    WHERE table_ns.nspname = 'public'
                      AND table_class.relname = 'sentence_embeddings'
                      AND index_class.relname = %s
                    """,
                    (INDEX_NAME,),
                )
                existing = cur.fetchone()

                if existing and existing[1]:
                    print(f"✅ {INDEX_NAME} already exists and is valid.")
                    return 0

                if existing:
                    print("Removing an invalid index left by an earlier interrupted build...")
                    cur.execute(f"DROP INDEX CONCURRENTLY IF EXISTS public.{INDEX_NAME}")

                print("Building the cosine HNSW index; this may take a few minutes...")
                cur.execute(
                    f"""
                    CREATE INDEX CONCURRENTLY IF NOT EXISTS {INDEX_NAME}
                    ON public.sentence_embeddings
                    USING hnsw (embedding vector_cosine_ops)
                    """
                )

                cur.execute(
                    """
                    SELECT pg_index.indisvalid
                    FROM pg_class AS index_class
                    JOIN pg_namespace AS index_ns
                      ON index_ns.oid = index_class.relnamespace
                    JOIN pg_index
                      ON pg_index.indexrelid = index_class.oid
                    WHERE index_ns.nspname = 'public'
                      AND index_class.relname = %s
                    """,
                    (INDEX_NAME,),
                )
                result = cur.fetchone()
                if not result or not result[0]:
                    print("❌ The index command finished, but PostgreSQL does not report a valid index.")
                    return 1

                print(f"✅ Created and verified {INDEX_NAME}.")
                return 0
    except Exception as exc:
        # Do not print the connection URI or password.
        print(f"❌ Index creation failed: {exc}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
