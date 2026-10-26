#!/usr/bin/env bash
# Runs the QA suites (docs/test-logs/2026-10-25/scripts) one after another,
# each against a brand-new empty database and a freshly started server, so
# no suite leans on what another left behind. Used by the "QA tests"
# workflow (.github/workflows/qa-tests.yml); runs the same on a laptop with
# a local MariaDB/MySQL:
#
#   DB_HOST=127.0.0.1 DB_USER=root DB_PASSWORD=... bash tests/qa/run-all.sh
#
# It DROPS and re-creates the database named mpr_tracker_db — never point it
# at a server holding real data.
#
# Needs: mysql client (logged in via ~/.my.cnf), Node >= 22, Playwright + Chromium (PLAYWRIGHT_FROM
# points at the folder that has it), pdftoppm (poppler-utils).
# Results: one JSON per suite and the server log in $QA_OUT.
# Suites: all of them, or only those named in $QA_SUITES (space separated).
set -u
cd "$(dirname "$0")/../.."
S=docs/test-logs/2026-10-25/scripts
export DB_NAME=mpr_tracker_db # the suites read the database by this name
export PORT=${PORT:-3100} BASE=${BASE:-http://localhost:${PORT:-3100}}
export ADMIN_NAME=${ADMIN_NAME:-System Admin} ADMIN_EMAIL=${ADMIN_EMAIL:-admin@credence.test} ADMIN_PASSWORD=${ADMIN_PASSWORD:-AdminPass123}
export JWT_SECRET=${JWT_SECRET:-qa-only-secret-not-for-production}
export MAIL_ENCRYPTION_KEY=${MAIL_ENCRYPTION_KEY:-0000000000000000000000000000000000000000000000000000000000000000}
export ESIGN_SEAL_KEY=${ESIGN_SEAL_KEY:-qa-only-seal-key}
export NODE_ENV=${NODE_ENV:-development}
QA_OUT=${QA_OUT:-qa-results}
mkdir -p "$QA_OUT"
# The suites call plain `mysql`: its login comes from ~/.my.cnf or the
# MYSQL_HOST / MYSQL_TCP_PORT / MYSQL_PWD variables (the workflow writes one).
mysql_() { mysql "$@"; }

SERVER_PID=""
stop_server() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null && wait "$SERVER_PID" 2>/dev/null
  SERVER_PID=""
  for _ in $(seq 1 20); do curl -s -o /dev/null "$BASE/" || break; sleep 0.5; done
}
trap stop_server EXIT
fresh() {
  stop_server
  mysql_ -e "DROP DATABASE IF EXISTS $DB_NAME; CREATE DATABASE $DB_NAME CHARACTER SET utf8mb4"
  ./node_modules/.bin/tsx server.ts >> "$QA_OUT/server.log" 2>&1 &
  SERVER_PID=$!
  # Ready once the workspace answers (tables made, company seeded).
  for _ in $(seq 1 120); do curl -sf -o /dev/null "$BASE/api/public/workspaces/credence" && break; sleep 1; done
  # The server makes the tables, the company and the Superadmin; the suites
  # also expect the usual departments.
  for _ in $(seq 1 30); do mysql_ -N "$DB_NAME" -e "SELECT 1 FROM departments LIMIT 0" >/dev/null 2>&1 && break; sleep 1; done
  mysql_ "$DB_NAME" -e "INSERT IGNORE INTO departments (id, name) VALUES (1,'Admin'),(2,'Finance'),(3,'HR'),(4,'MIS'),(5,'Transport')"
}

# name | needs a fresh server | command
SUITES=(
  "unit|1|ONB_TEST_BASE=$BASE ONB_TEST_ADMIN_EMAIL=$ADMIN_EMAIL ONB_TEST_ADMIN_PASSWORD=$ADMIN_PASSWORD npm run -s test:onboarding && ONB_TEST_BASE=$BASE ONB_TEST_ADMIN_EMAIL=$ADMIN_EMAIL ONB_TEST_ADMIN_PASSWORD=$ADMIN_PASSWORD npm run -s test:hr-linkage && npm run -s test:fingerprint"
  "bangla-excel|0|npx tsx $S/qa-bangla-excel.mts $QA_OUT/bangla-excel.json"
  "bangla-esign|0|npx tsx $S/qa-bangla-esign.mts $QA_OUT/esign-bangla.pdf"
  "concurrency|1|node $S/qa-concurrency.mjs $QA_OUT/concurrency.json"
  "companies|1|node $S/qa-companies.mjs $QA_OUT/companies.json"
  "group-hr|1|node $S/qa-group-hr.mjs $QA_OUT/group-hr.json"
  "dates|1|node $S/qa-dates.mjs $QA_OUT/dates.json"
  "month-reconcile|1|node $S/qa-month-reconcile.mjs $QA_OUT/month-reconcile"
  "supervisor-chain|1|node $S/supervisor-chain.mjs $QA_OUT/supervisor-chain.json"
  "e2e-forms|1|node $S/qa-e2e-forms.mjs $QA_OUT/e2e"
  "bangla-pdf|1|node $S/qa-bangla-pdf.mjs $QA_OUT/bangla-pdf"
  "bigdata|1|N=${BIGDATA_N:-2000} node $S/qa-bigdata.mjs $QA_OUT/bigdata.json"
)

failed=()
for entry in "${SUITES[@]}"; do
  IFS='|' read -r name needs cmd <<< "$entry"
  if [ -n "${QA_SUITES:-}" ] && [[ " $QA_SUITES " != *" $name "* ]]; then continue; fi
  echo "::group::$name"
  [ "$needs" = 1 ] && fresh
  out=$(bash -c "$cmd" 2>&1); code=$?
  echo "$out" > "$QA_OUT/$name.log"
  echo "$out" | grep -aE '^(PASS|FAIL|INFO|SUMMARY|# (pass|fail|skipped))|not ok' | tail -80
  # A suite fails on a non-zero exit, on "FAIL" lines or on a SUMMARY with failures.
  if [ $code -ne 0 ] || echo "$out" | grep -qE '^FAIL |"FAIL":[1-9]|# fail [1-9]'; then failed+=("$name"); echo "::error::$name failed"; fi
  echo "::endgroup::"
done
stop_server
if [ ${#failed[@]} -gt 0 ]; then echo "Failed suites: ${failed[*]}"; exit 1; fi
echo "All QA suites passed."
