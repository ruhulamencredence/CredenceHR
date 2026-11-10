// hrServiceStatus.ts
// An Employee's service status (probation / confirmed / contract / separated)
// when HR hasn't set one in Service Details (employee_service). Read from
// what the record actually says — Job Status, Employment Category or Job
// Base containing "Probation", "Contract", "Permanent"… — and nothing is
// guessed: "Job Base" usually holds a place (Head Office / Project), which
// used to make everyone without Service Details show as "On Probation".
// Empty string = not known (no badge).
export function fallbackServiceStatus(e: { is_active?: any; job_status?: any; employment_category?: any; job_base?: any }): string {
  if (Number(e.is_active ?? 1) === 0) return "separated";
  const text = [e.job_status, e.employment_category, e.job_base]
    .map((v) => String(v ?? "").toLowerCase())
    .join(" ");
  if (/probation/.test(text)) return "probation";
  if (/contract/.test(text)) return "contract";
  if (/permanent|confirm|regular/.test(text)) return "confirmed";
  return "";
}
