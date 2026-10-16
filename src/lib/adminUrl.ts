// Admin Panel tab <-> browser address (/admin/departments, /admin/hr-operations…).
// The tab key itself is the page name, with "_" written as "-" in the address.
// Not used inside the native mobile app, where the page is served from files.

export const ADMIN_URL_PREFIX = '/admin/';

export const adminUrlEnabled = () => {
  try {
    return !(window as any).Capacitor?.isNativePlatform?.();
  } catch {
    return true;
  }
};

export const adminTabToPath = (tab: string) => `${ADMIN_URL_PREFIX}${tab.replace(/_/g, '-')}`;

// "/admin/hr-operations" -> "hr_operations"; anything else -> null.
export const adminPathToTab = (pathname: string): string | null => {
  const m = /^\/admin\/([a-z0-9-]+)\/?$/i.exec(pathname);
  return m ? m[1].toLowerCase().replace(/-/g, '_') : null;
};

export const openedOnAdminUrl = () => adminUrlEnabled() && adminPathToTab(window.location.pathname) !== null;

// Tabs an address may name — anything else is ignored.
export const ADMIN_TAB_KEYS = new Set<string>(["dashboard", "reports_insights", "data_import", "projects", "branches", "mprs", "imports", "reports", "users", "employees", "departments", "attendance", "attendance_reports", "leave_applications", "office_attendance", "tracking", "recycle", "editlog", "notices", "claims", "approvals", "conveyance", "bill_claim_policy", "disbursement", "holidays", "asset_management", "vehicle_management", "permanent_delete_log", "companies", "devices", "active_users", "exit_offboarding", "performance_management", "recruitment", "grievance_disciplinary", "hr_analytics", "document_vault", "hr_operations", "task_management", "mobile_bill", "target_reports", "mail_admin", "duty_roster"]);
