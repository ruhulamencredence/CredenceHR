-- Approval Details access test data (run after quick-setup.sql).
-- HR action: a pending separation of Rafiq (user 138), approver Nasrin (139).
DELETE FROM hr_actions WHERE reason LIKE 'QA details%';
INSERT INTO hr_actions (employee_id, action_type, effective_date, status, applied, current_step, total_steps, chain_json, history_json, from_json, to_json, reason, remarks, created_by)
VALUES (48, 'separation', CURDATE(), 'pending', 0, 1, 1, '[{"label":"HR Manager","approver_ids":[139]}]', '[]',
        '{"gross_salary":40000,"designation":"Officer, Accounts"}', '{"gross_salary":0,"designation":"(leaves)"}',
        'QA details: performance', 'Terminate quietly, do not tell him yet', 1);
-- Exits: Sadia's termination opened by HR (Superadmin), Tanvir's own resignation.
UPDATE exit_requests SET requested_by = 1 WHERE reason = 'QA misconduct';
UPDATE exit_requests SET requested_by = 132 WHERE reason = 'QA Got a better offer';
DELETE FROM exit_clearance_items WHERE item_label = 'QA laptop';
INSERT INTO exit_clearance_items (exit_id, department, item_label, is_cleared, approver_user_id)
  SELECT id, 'IT', 'QA laptop', 0, 139 FROM exit_requests WHERE reason = 'QA misconduct';
-- Passwords for the test accounts
UPDATE users u JOIN (SELECT password_hash FROM users WHERE id = 1) a SET u.password_hash = a.password_hash WHERE u.id IN (132, 133, 137, 138, 139);
