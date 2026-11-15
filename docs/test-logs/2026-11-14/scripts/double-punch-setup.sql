-- Double punch test data for Tanvir (employee 37, machine PIN 102, user 132).
UPDATE users SET can_use_attendance = 1, can_view_timesheet = 1, can_update_check_out = 0 WHERE id = 132;
DELETE FROM zk_attendance_logs WHERE device_user_pin = '102' AND punch_time >= '2026-11-12 00:00:00';
DELETE FROM attendance WHERE user_id = 132 AND attendance_date >= '2026-11-12';
DELETE FROM approval_requests WHERE source_type = 'attendance' AND source_id NOT IN (SELECT id FROM attendance);
INSERT INTO zk_attendance_logs (device_id, device_user_pin, raw_pin, punch_time) VALUES
  (7, '102', '102', '2026-11-12 09:00:00'), (7, '102', '102', '2026-11-12 18:00:00'),   -- a normal day
  (7, '102', '102', '2026-11-13 09:00:00'),  (7, '102', '102', '2026-11-13 09:01:00'),    -- double punch YESTERDAY (before the rule)
  (7, '102', '102', '2026-11-14 09:00:00'), (7, '102', '102', '2026-11-14 09:01:30'); -- double punch TODAY
INSERT IGNORE INTO user_attendance_projects (user_id, project_id) VALUES (132, 1);  -- Tanvir may check in at Head Office
