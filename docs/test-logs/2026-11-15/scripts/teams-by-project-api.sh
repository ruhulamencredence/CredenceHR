#!/usr/bin/env bash
# Departments -> team: members from any department, new-joiner rules (dev server on :3200).
B=${BASE:-http://localhost:3200}; M="mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e"
pass=0; fail=0; check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1: got '$2' want '$3'"; fi; }
IDS=$(node "$(dirname "$0")/teams-seed.cjs"); j() { echo "$IDS" | python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }
INV=$(j inv); ACC=$(j acc); G1=$(j g1); G2=$(j g2); G3=$(j g3); B1=$(j b1); B2=$(j b2); U1=$(j u1); A1=$(j a1)
A=$(curl -s $B/api/auth/login -H 'content-type: application/json' -d '{"email":"admin@credence.test","password":"ProbePass123"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
get() { curl -s $B/api/departments/$1/teams -H "authorization: Bearer $A"; }
put() { curl -s -o /dev/null -w '%{http_code}' -X PUT $B/api/departments/$INV/teams -H "authorization: Bearer $A" -H 'content-type: application/json' -d "$1"; }
P=$(get $INV)
check "pool has every department's people" "$(echo "$P" | python3 -c "import sys,json;d=json.load(sys.stdin);print(sum(1 for p in d['pool'] if p['employee_code'] and p['employee_code'].startswith('INV-')))")" 7
check "pool carries work station + department" "$(echo "$P" | python3 -c "import sys,json;d=json.load(sys.stdin);p=[x for x in d['pool'] if x['id']==$A1][0];print(p['branch'],'|',p['department'],'|',p['team_name'])")" "Gulshan Tower | Accounts QA | Accounts QA team"
# save: Gulshan + Banani people, Faruk from Accounts, new joiners at Gulshan Tower (Inventory) and Uttara (any department)
check "save team with another department's person + rules" "$(put "{\"head_user_id\":null,\"teams\":[{\"name\":\"Store team\",\"supervisor_user_id\":1,\"everyone_else\":false,\"member_ids\":[$G1,$G2,$G3,$B1,$B2,$A1],\"auto\":[{\"branch\":\"Gulshan Tower\",\"department_id\":$INV},{\"branch\":\"Uttara Project\",\"department_id\":null}]}]}")" 200
TEAM=$($M "SELECT id FROM department_teams WHERE department_id=$INV")
check "6 members saved" "$($M "SELECT COUNT(*) FROM department_team_members WHERE team_id=$TEAM")" 6
check "Faruk left the Accounts team" "$($M "SELECT COUNT(*) FROM department_team_members m JOIN department_teams t ON t.id=m.team_id WHERE m.employee_id=$A1 AND t.department_id=$ACC")" 0
check "2 new-joiner rules" "$($M "SELECT COUNT(*) FROM department_team_auto WHERE team_id=$TEAM")" 2
RULE_AT=$($M "SELECT MIN(created_at) FROM department_team_auto WHERE team_id=$TEAM")
check "GET shows Faruk as a member" "$(get $INV | python3 -c "import sys,json;d=json.load(sys.stdin);print($A1 in d['teams'][0]['member_ids'])")" True
# Faruk's request now goes to this team's Supervisor (user 1 -> use a login for him)
$M "DELETE FROM users WHERE email='faruk.qa@credence.test'; INSERT INTO users (name,email,password_hash,role) VALUES ('Faruk Hossain','faruk.qa@credence.test','x','user'); UPDATE all_employees SET user_id=(SELECT id FROM users WHERE email='faruk.qa@credence.test') WHERE id=$A1"
check "Faruk's Supervisor = the Store team's (cross-department)" "$(curl -s "$B/api/debug/supervisor-resolution?email=faruk.qa@credence.test" -H "authorization: Bearer $A" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("team_supervisor_user_id"))')" 1
# new joiners
sleep 1
$M "INSERT INTO all_employees (employee_id,name,designation,department,department_id,branch,branch_id,is_active,company_id) VALUES
 ('INV-08','New Gulshan Store','Store Keeper','Inventory QA',$INV,'Gulshan Tower',(SELECT id FROM branches WHERE branch_name='Gulshan Tower'),1,(SELECT MIN(id) FROM companies)),
 ('INV-09','New Gulshan Accounts','Accountant','Accounts QA',$ACC,'Gulshan Tower',(SELECT id FROM branches WHERE branch_name='Gulshan Tower'),1,(SELECT MIN(id) FROM companies)),
 ('INV-10','New Uttara Accounts','Accountant','Accounts QA',$ACC,'Uttara Project',(SELECT id FROM branches WHERE branch_name='Uttara Project'),1,(SELECT MIN(id) FROM companies)),
 ('INV-11','New Banani Store','Store Keeper','Inventory QA',$INV,'Banani Site',(SELECT id FROM branches WHERE branch_name='Banani Site'),1,(SELECT MIN(id) FROM companies))"
get $INV >/dev/null
inteam() { $M "SELECT COUNT(*) FROM department_team_members m JOIN all_employees e ON e.id=m.employee_id WHERE m.team_id=$TEAM AND e.employee_id='$1'"; }
check "new joiner at Gulshan, Inventory -> added" "$(inteam INV-08)" 1
check "new joiner at Gulshan, Accounts -> not (rule is Inventory only)" "$(inteam INV-09)" 0
check "new joiner at Uttara, any department -> added" "$(inteam INV-10)" 1
check "new joiner at Banani -> not (no rule)" "$(inteam INV-11)" 0
check "older Uttara employee (joined before the rule) -> not" "$($M "SELECT COUNT(*) FROM department_team_members WHERE team_id=$TEAM AND employee_id=$U1")" 0
# taken out by hand stays out
N8=$($M "SELECT id FROM all_employees WHERE employee_id='INV-08'"); N10=$($M "SELECT id FROM all_employees WHERE employee_id='INV-10'")
check "save without INV-08" "$(put "{\"head_user_id\":null,\"teams\":[{\"id\":$TEAM,\"name\":\"Store team\",\"supervisor_user_id\":1,\"everyone_else\":false,\"member_ids\":[$G1,$G2,$G3,$B1,$B2,$A1,$N10],\"auto\":[{\"branch\":\"Gulshan Tower\",\"department_id\":$INV},{\"branch\":\"Uttara Project\",\"department_id\":null}]}]}")" 200
get $INV >/dev/null
check "INV-08 not re-added after being taken out" "$(inteam INV-08)" 0
check "an unchanged rule keeps its date" "$($M "SELECT MIN(created_at) FROM department_team_auto WHERE team_id=$TEAM")" "$RULE_AT"
check "save with one rule removed" "$(put "{\"head_user_id\":null,\"teams\":[{\"id\":$TEAM,\"name\":\"Store team\",\"supervisor_user_id\":1,\"everyone_else\":false,\"member_ids\":[$G1],\"auto\":[{\"branch\":\"Gulshan Tower\",\"department_id\":$INV}]}]}")" 200
check "rule removed" "$($M "SELECT GROUP_CONCAT(branch) FROM department_team_auto WHERE team_id=$TEAM")" "Gulshan Tower"
check "unknown employee id refused" "$(put "{\"head_user_id\":null,\"teams\":[{\"id\":$TEAM,\"name\":\"Store team\",\"supervisor_user_id\":1,\"member_ids\":[99999999]}]}")" 400
echo "$pass passed, $fail failed"
