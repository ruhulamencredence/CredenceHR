#!/usr/bin/env bash
# Users -> Merge accounts, by API (run merge-seed.cjs first; dev server on :3200).
B=${BASE:-http://localhost:3200}; M="mysql -h127.0.0.1 -ucred -pcredpass admin_ui -N -e"
login() { curl -s $B/api/auth/login -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"$2\"}"; }
tok() { login "$1" "$2" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))'; }
pass=0; fail=0; check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "PASS $1"; else fail=$((fail+1)); echo "FAIL $1: got '$2' want '$3'"; fi; }
IDS=$(node "$(dirname "$0")/merge-seed.cjs"); j() { echo "$IDS" | python3 -c "import sys,json;print(json.load(sys.stdin)['$1'])"; }
KO=$(j karimOld); KN=$(j karimNew); RO=$(j rafiqOld); RN=$(j rafiqNew)
A=$(tok admin@credence.test ProbePass123)
# permission: an Admin with Users but without the "merge_accounts" layer gets 403
$M "UPDATE users SET role='admin' WHERE id=2; DELETE FROM admin_module_permission_layers WHERE user_id=2; DELETE FROM admin_module_permissions WHERE user_id=2; INSERT INTO admin_module_permissions (user_id, module_key) VALUES (2,'users')"
U=$(tok qa.claimant@credence.test ProbePass123)
check "no layer -> candidates 403" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/users/merge/candidates -H "authorization: Bearer $U")" 403
check "no layer -> merge 403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/users/merge -H "authorization: Bearer $U" -H 'content-type: application/json' -d "{\"pairs\":[{\"from\":$KO,\"to\":$KN}]}")" 403
$M "INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) VALUES (2,'users','read'),(2,'users','merge_accounts')"
U=$(tok qa.claimant@credence.test ProbePass123)
check "with layer -> candidates 200" "$(curl -s -o /dev/null -w '%{http_code}' $B/api/users/merge/candidates -H "authorization: Bearer $U")" 200
$M "DELETE FROM admin_module_permission_layers WHERE user_id=2; DELETE FROM admin_module_permissions WHERE user_id=2; UPDATE users SET role='user' WHERE id=2"
# guards
check "superadmin can't be merged away" "$(curl -s -X POST $B/api/users/merge -H "authorization: Bearer $A" -H 'content-type: application/json' -d "{\"pairs\":[{\"from\":1,\"to\":$KN}]}" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["failed"]))')" 1
check "a login linked to an employee can't be merged away" "$(curl -s -X POST $B/api/users/merge -H "authorization: Bearer $A" -H 'content-type: application/json' -d "{\"pairs\":[{\"from\":$RN,\"to\":$KN}]}" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["failed"]))')" 1
# merge Karim (old access + old password) and Rafiq
$M "DELETE FROM hr_action_approval_steps WHERE action_type='qa_merge'; INSERT INTO hr_action_approval_steps (action_type, step_order, label, approver_user_ids) VALUES ('qa_merge', 1, 'HR', '[1,$KO]')"
R=$(curl -s -X POST $B/api/users/merge -H "authorization: Bearer $A" -H 'content-type: application/json' -d "{\"pairs\":[{\"from\":$KO,\"to\":$KN},{\"from\":$RO,\"to\":$RN}],\"access\":\"old\",\"password\":\"old\"}")
echo "   $R"
check "2 merged" "$(echo "$R" | python3 -c 'import sys,json;print(len(json.load(sys.stdin)["merged"]))')" 2
check "old logins deleted" "$($M "SELECT COUNT(*) FROM users WHERE id IN ($KO,$RO)")" 0
check "attendance moved (3)" "$($M "SELECT COUNT(*) FROM attendance WHERE user_id=$KN")" 3
check "own leave moved" "$($M "SELECT COUNT(*) FROM leave_applications WHERE user_id=$KN")" 1
check "leave he approved now shows the kept login" "$($M "SELECT COUNT(*) FROM leave_applications WHERE user_id=2 AND decided_by=$KN")" 1
check "bill claim moved" "$($M "SELECT COUNT(*) FROM bill_claims WHERE user_id=$KN")" 1
check "module access = the old login's" "$($M "SELECT GROUP_CONCAT(module_key ORDER BY module_key) FROM admin_module_permissions WHERE user_id=$KN")" "attendance,leave"
check "role + switches from the old login" "$($M "SELECT CONCAT(role,'/',can_use_chat,'/',can_use_attendance) FROM users WHERE id=$KN")" "admin/1/1"
check "email moved to the kept login" "$($M "SELECT email FROM users WHERE id=$KN")" "karim.old@credence.test"
check "signs in: Employee ID + old password" "$(login MRG-901 OldPass123 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("user",{}).get("id"))')" "$KN"
check "signs in: old email + old password" "$(login karim.old@credence.test OldPass123 | python3 -c 'import sys,json;print(json.load(sys.stdin).get("user",{}).get("id"))')" "$KN"
check "import password no longer works" "$(login MRG-901 ImportPass123 | python3 -c 'import sys,json;print("token" in json.load(sys.stdin))')" "False"
check "employee still linked to the kept login" "$($M "SELECT user_id FROM all_employees WHERE employee_id='MRG-901'")" "$KN"
check "logged" "$(curl -s $B/api/users/merge/log -H "authorization: Bearer $A" | python3 -c 'import sys,json;print(sum(1 for r in json.load(sys.stdin) if r["to_user_id"] in ('$KN','$RN')))')" 2
check "no leftovers pointing at the old login (attendance/leave/claims)" "$($M "SELECT (SELECT COUNT(*) FROM attendance WHERE user_id=$KO)+(SELECT COUNT(*) FROM leave_applications WHERE user_id=$KO OR decided_by=$KO)+(SELECT COUNT(*) FROM bill_claims WHERE user_id=$KO)")" 0
check "approver list inside an HR approval step" "$($M "SELECT approver_user_ids FROM hr_action_approval_steps WHERE action_type='qa_merge'")" "[1,$KN]"
$M "DELETE FROM hr_action_approval_steps WHERE action_type='qa_merge'"
echo "$pass passed, $fail failed"
