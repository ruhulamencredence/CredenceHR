-- HR quick reports test data (test database admin_ui). Dates are relative
-- to today, so the expected numbers hold on any day after the 2nd.
UPDATE all_employees SET religion = NULL;
UPDATE all_employees SET religion = 'Islam' WHERE id IN (36, 45, 48, 50, 40);
UPDATE all_employees SET religion = 'muslim' WHERE id = 37;            -- spelled differently -> Islam
UPDATE all_employees SET religion = 'Hindu' WHERE id IN (46, 39);      -- 39 is not active -> not counted
UPDATE all_employees SET religion = 'Christian' WHERE id = 47;
UPDATE all_employees SET religion = 'Buddhist' WHERE id = 49;          -- 38 Rumana: not recorded
-- Joiners this month: Rumana (HR) and Jahid (Admin)
UPDATE all_employees SET joining_date = CURDATE() WHERE id = 38;
UPDATE all_employees SET joining_date = DATE_FORMAT(CURDATE(), '%Y-%m-01') WHERE id = 40;
-- Service: everyone confirmed long ago, then the cases
DELETE FROM hr_employee_service WHERE employee_id IN (36,37,38,39,40,45,46,47,48,49,50);
INSERT INTO hr_employee_service (employee_id, service_status, confirmation_date)
  SELECT id, 'confirmed', '2020-01-01' FROM all_employees WHERE id IN (36,38,39,40,45,49,50);
INSERT INTO hr_employee_service (employee_id, service_status, probation_end_date) VALUES
  (37, 'probation', CURDATE() + INTERVAL 9 DAY),     -- due soon
  (48, 'probation', CURDATE() - INTERVAL 11 DAY),    -- overdue
  (46, 'probation', CURDATE() + INTERVAL 60 DAY);    -- not yet (outside 30 days)
INSERT INTO hr_employee_service (employee_id, service_status, confirmation_date) VALUES (47, 'confirmed', CURDATE()); -- confirmed this month
-- Onboarding for Rumana: 2 done, 1 pending, 1 n/a -> 2 of 3
DELETE FROM hr_onboarding_items WHERE employee_id IN (38, 40);
INSERT INTO hr_onboarding_items (employee_id, task_key, label, status) VALUES
  (38, 'qa1', 'ID card', 'done'), (38, 'qa2', 'Email', 'done'), (38, 'qa3', 'Laptop', 'pending'), (38, 'qa4', 'SIM', 'na');
-- Transfers
DELETE FROM employee_transfers WHERE reason LIKE 'QA %';
INSERT INTO employee_transfers (employee_id, from_department_name, to_department_name, from_designation, to_designation, effective_date, reason, applied) VALUES
  (48, 'Finance', 'MIS', 'Officer, Accounts', 'Officer, Accounts', DATE_FORMAT(CURDATE(), '%Y-%m-01'), 'QA team change', 1),
  (40, 'Admin', 'Transport', 'Peon', 'Security Guard', LAST_DAY(CURDATE()), 'QA new site', 0),
  (36, 'HR', 'Finance', NULL, NULL, '2025-06-01', 'QA old', 1);
-- Exits
DELETE FROM exit_clearance_items WHERE exit_id IN (SELECT id FROM exit_requests WHERE reason LIKE 'QA %');
DELETE FROM exit_requests WHERE reason LIKE 'QA %';
INSERT INTO exit_requests (user_id, exit_type, reason, notice_date, last_working_day, status) VALUES
  (132, 'resignation', 'QA Got a better offer', DATE_FORMAT(CURDATE(), '%Y-%m-01'), CURDATE() + INTERVAL 8 DAY, 'clearance'),
  (136, 'resignation', 'QA Higher study abroad', CURDATE(), CURDATE() + INTERVAL 22 DAY, 'pending'),
  (139, 'resignation', 'QA family relocation', DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01'), LAST_DAY(CURDATE() - INTERVAL 1 MONTH), 'settled'),
  (137, 'termination', 'QA misconduct', DATE_FORMAT(CURDATE(), '%Y-%m-01'), CURDATE() + INTERVAL 45 DAY, 'pending'),
  (140, 'resignation', 'QA changed mind', CURDATE(), CURDATE() + INTERVAL 30 DAY, 'cancelled');
INSERT INTO exit_clearance_items (exit_id, department, item_label, is_cleared)
  SELECT e.id, 'IT', CONCAT('Item ', n.n), n.n <= 3 FROM exit_requests e JOIN (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) n WHERE e.reason = 'QA Got a better offer';
INSERT INTO exit_clearance_items (exit_id, department, item_label, is_cleared)
  SELECT e.id, 'IT', CONCAT('Item ', n.n), 1 FROM exit_requests e JOIN (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) n WHERE e.reason = 'QA family relocation';
