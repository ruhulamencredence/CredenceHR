-- =====================================================================
-- ZK Office Attendance — schema patch
-- Run this once against mpr_tracker_db (phpMyAdmin / mysql CLI).
-- Kept SEPARATE from the existing project-based `attendance` table on
-- purpose (that one is GPS/project check-in; this one is raw biometric
-- punches from the office ZKTeco machines).
-- =====================================================================

-- Maps a company roster row (all_employees) to the PIN/UserID that was
-- enrolled on the ZKTeco device(s). Defaults to NULL — you fill this in
-- once per employee from Admin Panel -> Employees (or bulk via SQL if
-- employee_id already equals the device PIN for most people).
ALTER TABLE all_employees
  ADD COLUMN zk_device_pin VARCHAR(20) NULL UNIQUE AFTER employee_id;

-- Registry of the physical ZKTeco terminals (from the "Attendance
-- Management Program" device list — Device Name/IP/Port/Serial Number).
-- Add one row per device you want auto-synced.
CREATE TABLE IF NOT EXISTS zk_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  ip_address VARCHAR(45) NOT NULL,
  port INT NOT NULL DEFAULT 4370,
  serial_number VARCHAR(100) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_synced_at TIMESTAMP NULL DEFAULT NULL,
  last_sync_status VARCHAR(255) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_device_ip_port (ip_address, port)
);

-- Raw punch log pulled straight off the devices — one row per punch, never
-- summarized/overwritten. "Office Attendance" reports (first punch of the
-- day = check-in, last punch = check-out) are computed FROM this table at
-- query time, so re-syncing is always safe/idempotent.
CREATE TABLE IF NOT EXISTS zk_attendance_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  device_id INT NOT NULL,
  device_user_pin VARCHAR(20) NOT NULL,
  punch_time DATETIME NOT NULL,
  verify_mode INT NULL,
  work_code INT NULL,
  synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_device_pin_time (device_id, device_user_pin, punch_time),
  FOREIGN KEY (device_id) REFERENCES zk_devices(id) ON DELETE CASCADE,
  INDEX idx_pin_time (device_user_pin, punch_time)
);
