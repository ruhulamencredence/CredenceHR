-- After ot-api.mjs: a few more days waiting for approval, for the screens.
SET @p = (SELECT id FROM projects ORDER BY id LIMIT 1);
DELETE FROM attendance WHERE user_id = 138 AND attendance_date = '2026-11-05';
INSERT INTO attendance (user_id, project_id, attendance_date, check_in_at, check_out_at) VALUES (138, @p, '2026-11-05', '2026-11-05 09:00:00', '2026-11-05 20:40:00');
SET @t = (SELECT id FROM site_attendance_teams WHERE name = 'OT Test Guards');
INSERT INTO site_attendance_sheets (team_id, attendance_date, status, submitted_by) VALUES (@t, '2026-11-10', 'approved', 132);
SET @s = LAST_INSERT_ID();
INSERT INTO site_attendance_entries (sheet_id, team_id, employee_id, attendance_date, status, in_time, out_time, confirmed) VALUES
 (@s, @t, 40, '2026-11-10', 'present', '08:00', '21:05', 1), (@s, @t, 38, '2026-11-10', 'present', '08:55', '20:35', 1);
UPDATE ot_settings SET approver_mode = 'either';
