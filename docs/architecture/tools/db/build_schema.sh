#!/bin/bash
# খালি ডাটাবেসে সার্ভার একবার চালিয়ে সব টেবিল বানায় (schema.sql + সব ensure*Schema),
# টেবিলের সংখ্যা স্থির হলে সার্ভার বন্ধ করে। DB_* env লাগে (সার্ভারের মতোই)।
set -u
cd "$(dirname "$0")/../../../.."
LOG="${RUNNER_TEMP:-/tmp}/docs-schema-server.log"
PORT="${DOCS_SCHEMA_PORT:-3990}" setsid npx tsx server.ts > "$LOG" 2>&1 &
PID=$!
stop() { kill -- -$PID 2>/dev/null; sleep 1; kill -9 -- -$PID 2>/dev/null; }
count() { node -e '
const m=require("mysql2/promise");(async()=>{const c=await m.createConnection({host:process.env.DB_HOST||"localhost",user:process.env.DB_USER||"root",password:process.env.DB_PASSWORD||"",port:+process.env.DB_PORT||3306});
const [r]=await c.query("select count(*) n from information_schema.columns where table_schema=?",[process.env.DB_NAME||"mpr_tracker_db"]);console.log(r[0].n);await c.end()})().catch(()=>console.log(0))'; }
last=-1; same=0
for i in $(seq 1 120); do
  sleep 3
  n=$(count)
  if [ "$n" -gt 0 ] && [ "$n" = "$last" ]; then same=$((same+1)); else same=0; fi
  last=$n
  [ $same -ge 4 ] && break
  grep -q "Falling back to in-memory" "$LOG" && { echo "সার্ভার ডাটাবেসে ঢুকতে পারেনি:"; grep "MySQL Connection failed" "$LOG"; stop; exit 1; }
  kill -0 $PID 2>/dev/null || { echo "server exited"; tail -30 "$LOG"; exit 1; }
done
stop
[ "$last" -gt 0 ] || { echo "কোনো টেবিল তৈরি হয়নি"; tail -30 "$LOG"; exit 1; }
echo "schema ready: $last columns"
