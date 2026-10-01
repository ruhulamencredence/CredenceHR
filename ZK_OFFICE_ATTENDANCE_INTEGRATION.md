# Office Attendance (ZKTeco) — integration guide

Adds a new, separate **"Office Attendance"** Admin Panel module that shows
biometric punches pulled automatically from your office ZKTeco machines —
does not touch the existing project-based `attendance` (Remote Attendance)
table at all.

## 0. Install dependencies

```
npm install node-zklib node-cron
npm install --save-dev @types/node-cron
```

## 1. Database

Run `zk_office_attendance_schema.sql` once against `mpr_tracker_db`.
It adds:
- `all_employees.zk_device_pin` — map each roster employee to their device PIN
  (if `employee_id` already equals the ZK enrollment ID for everyone, you can
  backfill with `UPDATE all_employees SET zk_device_pin = employee_id;`)
- `zk_devices` — one row per physical terminal (name, IP, port)
- `zk_attendance_logs` — raw punch history (source of truth; reports are
  computed from this at query time)

Seed your devices from the screenshot's IP list, e.g.:
```sql
INSERT INTO zk_devices (name, ip_address, port) VALUES
  ('Device 2', '192.168.1.201', 4370),
  ('Device 4', '192.168.88.4', 4370),
  ('Device 5', '192.168.66.10', 4370),
  ('Device 6', '192.168.77.25', 4370);
```

## 2. Add `zkSync.ts`

Drop `zkSync.ts` next to `server.ts`. It exports `syncAllZkDevices`,
`syncZkDevice`, and `startZkSyncSchedule` — a `node-cron`/`setInterval`
combo that runs this daily schedule (server local time):

| Time  | Action |
|-------|--------|
| 08:00–11:00 | Full pull every 15 seconds |
| 15:00 | One extra full pull |
| 17:59–20:00 | Full pull every 15 seconds |
| 02:00 | One extra full pull |

This is deliberately **polling**, not real-time push: `getRealTimeLogs()`
(node-zklib's live-push API) turned out unreliable in testing — punches
like a 6:00pm checkout wave weren't showing up until someone clicked
"Sync Now" by hand. So the schedule now just calls the same function the
"Sync Now" button calls (`syncAllZkDevices`), automatically, every 15
seconds during the two windows above — close enough to instant that a
punch shows up in the app within seconds — plus two extra full pulls
outside them. Each poll re-downloads every device's **entire** log (no
"since date" filter in the ZK protocol), so this trades some extra device
load during the two windows for near-real-time data.
`startZkRealtimeListeners`/`stopZkRealtimeListeners` are still in the
file if real-time push is worth revisiting later, but they're not wired
into the schedule by default.

`syncAllZkDevices` pulls every device **in parallel** — each device gets
its own connection, so one slow or offline device never delays the
others (it used to loop one device at a time; with several devices and a
15s poll interval, that serial wait could easily eat the whole interval
on its own).

## 3. server.ts edits

**Import** (near the other imports, top of file):
```ts
import { syncAllZkDevices, startZkSyncSchedule } from "./zkSync";
```

**Register the module** — find this line (~1052):
```ts
const ADMIN_MODULE_KEYS = ["projects", "mprs", "imports", "reports", "users", "attendance", "attendance_reports", "recycle", "editlog", "notices", "claims", "approvals", "conveyance", "employees", "tracking"] as const;
```
Change to:
```ts
const ADMIN_MODULE_KEYS = ["projects", "mprs", "imports", "reports", "users", "attendance", "attendance_reports", "recycle", "editlog", "notices", "claims", "approvals", "conveyance", "employees", "tracking", "office_attendance"] as const;
```

**Start the cron job** — inside `initDB()`, right after `dbPool = mysql.createPool({...})` finishes successfully (after `isMySQLConnected = true` is set), add:
```ts
startZkSyncSchedule(dbPool);
```

**New endpoints** — add anywhere with the other `/api/...` routes (all gated the same way as your existing modules, via `requireModule("office_attendance")`):

```ts
// --- ZK Devices (device registry management) ---
app.get("/api/zk-devices", authenticateToken, requireModule("office_attendance"), async (req, res) => {
  const rows = await queryDB("SELECT * FROM zk_devices ORDER BY name");
  res.json(rows);
});

app.post("/api/zk-devices", authenticateToken, requireModule("office_attendance"), async (req, res) => {
  const { name, ip_address, port } = req.body;
  const result: any = await queryDB(
    "INSERT INTO zk_devices (name, ip_address, port) VALUES (?, ?, ?)",
    [name, ip_address, port || 4370]
  );
  res.json({ id: result.insertId });
});

app.delete("/api/zk-devices/:id", authenticateToken, requireModule("office_attendance"), async (req, res) => {
  await queryDB("DELETE FROM zk_devices WHERE id = ?", [req.params.id]);
  res.json({ success: true });
});

// Manual "sync now" button
app.post("/api/zk-devices/sync-now", authenticateToken, requireModule("office_attendance"), async (req, res) => {
  const results = await syncAllZkDevices(dbPool);
  res.json(results);
});

// Map an employee to their device PIN (Admin Panel -> Employees row action)
app.put("/api/employees/:id/zk-pin", authenticateToken, requireModule("employees"), async (req, res) => {
  const { zk_device_pin } = req.body;
  await queryDB("UPDATE all_employees SET zk_device_pin = ? WHERE id = ?", [zk_device_pin || null, req.params.id]);
  res.json({ success: true });
});

// --- Office Attendance report ---
// One row per employee per day: first punch = check-in, last punch = check-out,
// plus the raw punch count so an admin can spot a missed punch (odd count).
app.get("/api/office-attendance", authenticateToken, requireModule("office_attendance"), async (req, res) => {
  const { from, to } = req.query as { from?: string; to?: string };
  const dateFrom = from || todayInDhaka();
  const dateTo = to || todayInDhaka();

  const rows = await queryDB(
    `SELECT
       e.id AS employee_id, e.name, e.designation, e.department,
       DATE(l.punch_time) AS attendance_date,
       MIN(l.punch_time) AS check_in_at,
       MAX(l.punch_time) AS check_out_at,
       COUNT(*) AS punch_count
     FROM zk_attendance_logs l
     JOIN all_employees e ON e.zk_device_pin = l.device_user_pin
     WHERE DATE(l.punch_time) BETWEEN ? AND ?
     GROUP BY e.id, DATE(l.punch_time)
     ORDER BY attendance_date DESC, e.name`,
    [dateFrom, dateTo]
  );
  res.json(rows);
});
```

## 4. types.ts edits

```ts
export type AdminModuleKey = 'projects' | 'mprs' | 'imports' | 'reports' | 'users' | 'recycle' | 'editlog' | 'attendance' | 'attendance_reports' | 'notices' | 'claims' | 'approvals' | 'conveyance' | 'employees' | 'tracking' | 'office_attendance';
```
And add to `ADMIN_MODULES`:
```ts
{ key: 'office_attendance', label: 'Office Attendance' },
```

Add an interface for the report row:
```ts
export interface OfficeAttendanceRow {
  employee_id: number;
  name: string;
  designation: string | null;
  department: string | null;
  attendance_date: string;
  check_in_at: string;
  check_out_at: string;
  punch_count: number;
}
```

## 5. AdminPanel.tsx wiring

Same pattern as the existing `tracking` tab (line ~2354):
```tsx
import { OfficeAttendancePanel } from './OfficeAttendancePanel';
// ...
{activeTab === 'office_attendance' && (
  <OfficeAttendancePanel token={token} />
)}
```
and add `'office_attendance'` to the `activeTab` union type (line ~142) and the sidebar tab list, same as every other module.

`OfficeAttendancePanel.tsx` itself is a plain table component — from/to date pickers calling `GET /api/office-attendance`, plus a "Sync Now" button calling `POST /api/zk-devices/sync-now`. I didn't write this component blind since I don't have your existing tab-panel boilerplate (e.g. `EmployeeTrackingPanel.tsx`) in front of me — paste that file's content in your next message and I'll build the matching one so the styling/table conventions line up exactly.

## Notes / gotchas
- `node-zklib` talks raw TCP/UDP to port 4370 — your Express process must run on a machine that can reach `192.168.x.x` (confirmed: yes, since both run on the office LAN).
- If a device is mid-punch-download when someone punches, it's fine — `INSERT IGNORE` + the unique key means the next poll (up to 15s later inside a window) just picks up anything new.
- Employees with no `zk_device_pin` set are silently excluded from the report (the `JOIN` requires a match) — map everyone from Admin Panel -> Employees before relying on this for payroll.
- Device log capacity is limited (older ZKTeco terminals ~50k–100k logs); once `zk_attendance_logs` has ingested them, periodically clearing the device's own log (via the "Attendance Management Program" software, not this pipeline) keeps device performance up — this pipeline doesn't do that automatically.