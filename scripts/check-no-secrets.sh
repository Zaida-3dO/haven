#!/usr/bin/env bash
#
# Fails if anything that must stay out of a public repo has been committed.
#
# This is a structural check, not a pattern-matching one: gitleaks already
# hunts for credential-shaped strings. What this catches is the mistake that
# actually happened on the old dashboard — a real `config.json` (holding a
# live API key) and an `apps.json` mapping the entire internal network,
# committed because nothing said they shouldn't be.
#
# See docs/SECURITY.md.

set -euo pipefail

fail=0
note() { printf '::error::%s\n' "$1"; fail=1; }

tracked() { git ls-files --error-unmatch "$1" >/dev/null 2>&1; }

# 1. Real config files. The repo ships `*.example.json` only.
while IFS= read -r f; do
  case "$f" in
    *.example.json) continue ;;
  esac
  note "Real config committed: $f — only config/*.example.json belongs in the repo."
done < <(git ls-files 'config/*.json')

# 2. Environment files. Only `.env.example` is allowed.
while IFS= read -r f; do
  [ "$f" = ".env.example" ] && continue
  note "Environment file committed: $f"
done < <(git ls-files '.env' '.env.*')

# 3. Databases, keys and certificates.
while IFS= read -r f; do
  note "Credential or database file committed: $f"
done < <(git ls-files '*.db' '*.pem' '*.key' 'certs/*')

# 4. Private assets — floor plans and photos of the flat.
while IFS= read -r f; do
  note "Private asset committed: $f — these stay out of a public repo."
done < <(git ls-files 'assets/private/*' 'uploads/*')

# 5. Private RFC 1918 addresses in tracked files. The example config uses
#    `.invalid` hostnames precisely so this stays clean.
if git grep -nIE '(^|[^0-9.])(192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})' \
     -- ':!scripts/check-no-secrets.sh' ':!docs/SECURITY.md' >/tmp/haven-ips 2>/dev/null; then
  echo "Private LAN addresses found in tracked files:" >&2
  cat /tmp/haven-ips >&2
  note "Remove the LAN addresses above — a public app registry maps your internal network."
fi

if [ "$fail" -ne 0 ]; then
  echo >&2
  echo "Secret/PII check FAILED. See docs/SECURITY.md for what belongs where." >&2
  exit 1
fi

echo "Secret/PII check passed — no real config, credentials or private assets tracked."
