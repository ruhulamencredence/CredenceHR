#!/usr/bin/env bash
# AI Assistant: "X department-এ কয়টা SIM" -> sim_list (dev server on :3200).
B=${BASE:-http://localhost:3200}
tok() { curl -s $B/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"ProbePass123\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }
ask() { curl -s $B/api/assistant/chat -H "authorization: Bearer $1" -H 'content-type: application/json' -d "{\"message\":\"$2\"}" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("reply") or d)'; }
A=$(tok admin@credence.test); U=$(tok qa.claimant@credence.test); pass=0; fail=0
check() { if echo "$2" | grep -q "$3"; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1: $2"; fi; }
check "MIS by short form" "$(ask $A 'mis department er koto gula sim deya ache sim details report dao')" "Management Information Systems (MIS) — SIM"
check "HR word match" "$(ask $A 'HR department e koyta sim')" "HR & Admin — SIM"
check "not given filter" "$(ask $A 'kon sim gula kauke deya hoy nai sim list')" "Not given to anyone"
check "operator filter" "$(ask $A 'gp sim koto gula')" "Operator: gp"
check "own SIM stays own" "$(ask $A 'amar sim er limit koto')" "আপনার নামে"
check "no module -> no access" "$(ask $U 'mis department er koto gula sim deya ache')" "অনুমতি"
echo "$pass passed, $fail failed"
