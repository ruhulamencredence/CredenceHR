-- Test world for the overtime / guard checks (test database only).
-- Accounts get the Superadmin's test password (ProbePass123).
UPDATE users u JOIN (SELECT password_hash FROM users WHERE id = 1) a SET u.password_hash = a.password_hash WHERE u.id IN (132,136,137,138,139,140);
-- start clean
DELETE FROM ot_entries; DELETE FROM ot_rates; DELETE FROM ot_settings; DELETE FROM ot_payroll_changes;
DELETE FROM guard_relief; DELETE FROM guard_post_needs; DELETE FROM guard_posts;
DELETE FROM duty_roster WHERE roster_date BETWEEN '2026-11-01' AND '2026-12-31';
DELETE FROM duty_shifts WHERE code IN ('G','GD','GN','S12');
UPDATE all_employees SET gets_ot = 0;
UPDATE users SET can_view_my_ot = 0, can_approve_team_ot = 0;
DELETE FROM attendance WHERE attendance_date BETWEEN '2026-11-01' AND '2026-11-30' AND user_id IN (137,138);
DELETE FROM employee_supervisors WHERE employee_id IN (40,38,47,48);
DELETE FROM site_attendance_teams WHERE name = 'OT Test Guards';
DELETE FROM admin_module_permission_layers WHERE user_id IN (139,140);
DELETE FROM admin_module_permissions WHERE user_id IN (139,140);
DELETE FROM duty_roster_department_access WHERE user_id = 139;
-- Rafiq (48, Finance) reports to Imran (46, login 136) — his Team Supervisor.
INSERT INTO employee_supervisors (employee_id, supervisor_id, effective_date, is_direct) VALUES (48, 46, '2026-01-01', 1), (47, 46, '2026-01-01', 1);
-- Guards: Jahid (40) and Rumana (38) have no login — the site supervisor Tanvir (132) marks them.
UPDATE all_employees SET designation = 'Security Guard' WHERE id IN (38, 40);
INSERT INTO site_attendance_teams (name, supervisor_user_id, is_active) VALUES ('OT Test Guards', 132, 1);
SET @t = LAST_INSERT_ID();
DELETE FROM site_attendance_members WHERE employee_id IN (38, 40);
INSERT INTO site_attendance_members (team_id, employee_id) VALUES (@t, 40), (@t, 38);
-- Nasrin (139): Duty Roster — read, roster_manage, ot_approve, guard_posts; Payroll — read, ot_rules, salary_amounts.
INSERT INTO admin_module_permissions (user_id, module_key) VALUES (139, 'duty_roster'), (139, 'payroll');
INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) VALUES
 (139,'duty_roster','read'),(139,'duty_roster','roster_manage'),(139,'duty_roster','ot_approve'),(139,'duty_roster','guard_posts'),
 (139,'payroll','read'),(139,'payroll','ot_rules'),(139,'payroll','salary_amounts');
-- Kamal (140): Duty Roster read + Payroll read only (none of the new layers).
INSERT INTO admin_module_permissions (user_id, module_key) VALUES (140, 'duty_roster'), (140, 'payroll');
INSERT INTO admin_module_permission_layers (user_id, module_key, layer_key) VALUES (140,'duty_roster','read'),(140,'payroll','read');
