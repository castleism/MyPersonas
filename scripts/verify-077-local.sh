#!/usr/bin/env bash
# Local-only 077 apply/readback helper. Never talks to production.
# Exits 2 when psql is missing. Does not apply a linked database.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
sql="$root/MyPersonas.Online_v0/sql-updates/077-mobile-private-draft-workflow.sql"

if [[ ! -f "$sql" ]]; then
  echo "077 SQL is missing at $sql"
  exit 4
fi

if ! grep -q 'check (publishing_enabled = false)' "$sql"; then
  echo "077 lost the publishing_enabled=false constraint."
  exit 5
fi

if command -v psql >/dev/null 2>&1 && [[ -n "${DATABASE_URL:-}" ]]; then
  if [[ "$DATABASE_URL" == *supabase.co* || "$DATABASE_URL" == *mypersonas* ]]; then
    echo "Refusing to apply 077 to a hosted/production-looking DATABASE_URL."
    exit 6
  fi
  echo "Would apply 077 to the local DATABASE_URL only. This script stops before a linked apply."
  echo "Review $sql, then run: psql \"\$DATABASE_URL\" -v ON_ERROR_STOP=1 -f \"$sql\""
  echo "Read back: select publishing_enabled from public.persona_content_packages limit 1;"
  exit 0
fi

echo "psql + local DATABASE_URL are not available. 077 remains unapplied."
echo "This checkout will not invent a production apply."
exit 2
