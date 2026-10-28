# Wiring the new Payroll tabs into PayrollModule.tsx

Four new panels now exist:
- AttendanceOvertimeSummaryPanel.tsx  ("Attendance & OT")
- PayslipManagementPanel.tsx          ("Payslips")
- LoanAdvanceManagementPanel.tsx      ("Loans & Advances")
- BonusIncentiveManagementPanel.tsx   ("Bonus & Incentive")

1. Imports:

```ts
import { AttendanceOvertimeSummaryPanel } from './AttendanceOvertimeSummaryPanel';
import { PayslipManagementPanel } from './PayslipManagementPanel';
import { LoanAdvanceManagementPanel } from './LoanAdvanceManagementPanel';
import { BonusIncentiveManagementPanel } from './BonusIncentiveManagementPanel';
```

2. Widen the tab type:

```ts
const [activeTab, setActiveTab] = useState<
  'dashboard' | 'list' | 'attendance' | 'payslips' | 'loans' | 'bonus' | 'setup'
>('dashboard');
```

3. Add four tab buttons (same pattern as the existing ones):

```tsx
<button onClick={() => setActiveTab('attendance')} className={/* same className pattern */}>Attendance & OT</button>
<button onClick={() => setActiveTab('payslips')} className={/* ... */}>Payslips</button>
<button onClick={() => setActiveTab('loans')} className={/* ... */}>Loans & Advances</button>
<button onClick={() => setActiveTab('bonus')} className={/* ... */}>Bonus & Incentive</button>
```

4. Add the four branches to the tab-content routing:

```tsx
) : activeTab === 'attendance' ? (
  <AttendanceOvertimeSummaryPanel token={token} />
) : activeTab === 'payslips' ? (
  <PayslipManagementPanel token={token} />
) : activeTab === 'loans' ? (
  <LoanAdvanceManagementPanel token={token} />
) : activeTab === 'bonus' ? (
  <BonusIncentiveManagementPanel token={token} />
```

## Things that still need backend work (not just frontend)

These four panels were built to run entirely on EXISTING PayrollRoutes.ts
endpoints — no schema or route changes needed for Attendance & OT, Payslips
(view/download/bulk-PDF), Loans & Advances, or Bonus & Incentive. Two real
gaps carry over from earlier, plus one new one surfaced by this batch:

1. **Email Payslips** (`PayslipManagementPanel.tsx`) — calls
   `POST /api/payroll/:id/email` and `POST /api/payroll/email-bulk`, which
   don't exist yet, and no SMTP/nodemailer is configured anywhere in the
   project.

2. **Loan "Requests & Approvals"** (`LoanAdvanceManagementPanel.tsx`) —
   `employee_advances.status` only has `active`/`completed`, no
   `pending`/`rejected`, and there's no employee-facing "submit a request"
   endpoint. So on this page, an Admin creating an advance directly *is*
   the approval step (consistent with the module already being
   Admin/`payroll`-permission-gated). If you want employees to submit
   their own requests for later Admin approve/reject, that needs a new
   table + flow modeled on `ConveyanceBillClaimRoutes.ts`'s
   `/api/user-claims` (pending -> `/decision` with approve/reject).

3. **Bonus before payroll is generated** (`BonusIncentiveManagementPanel.tsx`) —
   this page can only attach a bonus to a payroll run that already exists
   for the selected month (via `PUT /api/payroll/:id`). Employees who don't
   have a run yet for that month are called out separately in the UI. If
   you want to "stage" a bonus before Run Payroll's Step 3 picks it up
   automatically, that needs a small new table (e.g. `pending_bonuses`)
   and a read in the wizard's attendance-summary step.

Happy to build any of these three backend pieces next if you want the
buttons to be fully live rather than showing a clear "not wired up yet"
message.