// Runs the one-time "existing HR Operations accounts get Quick reports" step.
import mysql from "mysql2/promise";
import { ensureHrQuickReportsSchema } from "../../../../HrQuickReports";
const pool = mysql.createPool({ host: "127.0.0.1", user: "cred", password: "credpass", database: "admin_ui" });
await ensureHrQuickReportsSchema(pool);
await pool.end();
