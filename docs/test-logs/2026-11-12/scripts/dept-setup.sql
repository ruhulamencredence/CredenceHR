-- Test world for Head of Department + teams (test database only).
UPDATE users u JOIN (SELECT password_hash FROM users WHERE id = 1) a SET u.password_hash = a.password_hash WHERE u.id IN (131,132,135,136,137,138,139,140);
DELETE FROM employee_supervisors WHERE employee_id IN (36,45,46,47,48,50);
DELETE FROM department_team_members; DELETE FROM department_teams;
UPDATE departments SET head_user_id = NULL;
DELETE FROM approval_requests WHERE source_type = 'attendance_correction' AND requested_by IN (131,135,136,137,138,140);
DELETE FROM attendance_corrections WHERE user_id IN (131,135,136,137,138,140);
UPDATE all_employees SET department_id = 1, department = 'Finance' WHERE id IN (36,45,46,47,48,50);
