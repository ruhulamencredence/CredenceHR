# Access Control Matrix: কে কোন মডিউলে কী করতে পারে

> স্বয়ংক্রিয়ভাবে তৈরি: `src/types.ts` (`ADMIN_MODULES`, `MODULE_LAYER_OPTIONS`, `EXPLICIT_ONLY_LAYERS`) থেকে। 🔒 = ডিফল্টে বন্ধ, Superadmin টিক দিলে তবেই। Superadmin সবসময় সব পায়।
> মডিউল অনুমতি পায় Admin; কর্মী (`user`) Admin Panel-এ ঢোকে না, শুধু Self Service-এর সুইচ (যেমন `can_view_roster`) পায়।

| মডিউল (Admin Panel) | কী | layer / অনুমতির ধাপ (🔒 = ডিফল্টে বন্ধ, Superadmin টিক দিলে তবেই) |
|---|---|---|
| Admin Dashboard | `admin_dashboard` | শুধু মডিউলের অনুমতি (layer নেই) |
| Reports | `reports` | `read` Read Only<br>`edit_add` Edit<br>`delete_trash` Delete/Trash<br>🔒`permanent_delete` Permanent Delete<br>🔒`submission_status` Budget Submission Status<br>🔒`dispatch_material` Dispatch Material (own)<br>🔒`dispatch_all` Dispatch Material: see all<br>🔒`po_import` P.O Import |
| Projects | `projects` | `read` Read Only<br>`edit_add` Edit/Add<br>`entry_upload` Entry/Upload<br>`delete_trash` Delete/Trash<br>🔒`permanent_delete` Permanent Delete |
| Branches | `branches` | শুধু মডিউলের অনুমতি (layer নেই) |
| MPR Numbers | `mprs` | শুধু মডিউলের অনুমতি (layer নেই) |
| Data Import | `imports` | শুধু মডিউলের অনুমতি (layer নেই) |
| Users | `users` | `read` Read Only<br>`edit_add` Edit/Add<br>`entry_upload` Entry/Upload<br>`delete_trash` Delete/Trash<br>🔒`permanent_delete` Permanent Delete<br>🔒`block_account` Block Account<br>🔒`password_requests` Password requests (Forgot password) |
| Employees | `employees` | `read` Employees (view, add, edit)<br>🔒`employee_delete` Delete employee records |
| Departments | `departments` | `read` Read Only<br>`edit_add` Edit/Add<br>`entry_upload` Entry/Upload<br>`delete_trash` Delete/Trash<br>🔒`permanent_delete` Permanent Delete |
| Remote Attendance | `attendance` | শুধু মডিউলের অনুমতি (layer নেই) |
| Monthly Attendance Report | `attendance_reports` | `read` Attendance Reports<br>🔒`late_list` Late list (who came late) |
| Monthly Leave Application | `leave_applications` | শুধু মডিউলের অনুমতি (layer নেই) |
| Office Attendance | `office_attendance` | `read` Office Attendance<br>🔒`link_pins` Link Device PINs |
| Employee Tracking | `tracking` | `read` Live Map & History<br>`stay_report` Stay Report<br>🔒`live` Live Follow |
| Movement Claims | `claims` | শুধু মডিউলের অনুমতি (layer নেই) |
| Conveyance Bill Claim | `conveyance` | `read` Conveyance Bill Claim<br>🔒`on_behalf` Claim on Behalf |
| Conveyance Disbursement | `disbursement` | শুধু মডিউলের অনুমতি (layer নেই) |
| Approvals | `approvals` | `read` Read Only<br>`edit_add` Edit/Add<br>`entry_upload` Entry/Upload<br>`delete_trash` Delete/Trash<br>🔒`permanent_delete` Permanent Delete |
| Notices | `notices` | শুধু মডিউলের অনুমতি (layer নেই) |
| Holidays (Global Calendar) | `holidays` | শুধু মডিউলের অনুমতি (layer নেই) |
| Payroll | `payroll` | `read` Payroll<br>`payroll_view` View only (Audit / Accounts)<br>🔒`salary_month` Salary Month Setting<br>🔒`salary_hold` Salary Hold / Release<br>🔒`audit_approve` Audit Approve<br>🔒`accounts_pay` Accounts Pay<br>🔒`access_log` Activity Log<br>🔒`salary_bulk_upload` Salary Bulk Upload |
| Asset Management | `asset_management` | শুধু মডিউলের অনুমতি (layer নেই) |
| Vehicle Management | `vehicle_management` | শুধু মডিউলের অনুমতি (layer নেই) |
| Vehicle Maintainer (Ride Bypass) | `vehicle_maintainer` | শুধু মডিউলের অনুমতি (layer নেই) |
| Job Recycle | `recycle` | শুধু মডিউলের অনুমতি (layer নেই) |
| MPR Edit Log | `editlog` | শুধু মডিউলের অনুমতি (layer নেই) |
| Exit / Offboarding | `exit_offboarding` | `read` Exit / Offboarding<br>🔒`exit_dues` Exit — Dues from other modules<br>🔒`exit_pdf` Exit — Clearance & Settlement PDF<br>🔒`exit_clearance_setup` Exit — Clearance Departments setup |
| Performance Management | `performance_management` | শুধু মডিউলের অনুমতি (layer নেই) |
| Recruitment (ATS) | `recruitment` | শুধু মডিউলের অনুমতি (layer নেই) |
| Grievance & Disciplinary | `grievance_disciplinary` | শুধু মডিউলের অনুমতি (layer নেই) |
| HR Analytics | `hr_analytics` | শুধু মডিউলের অনুমতি (layer নেই) |
| Document Vault | `document_vault` | `read` Documents (upload, view, own signature)<br>🔒`sign_request` Request signatures from others<br>🔒`esign_settings` E-Signature settings (OTP, read to the end) |
| HR Operations | `hr_operations` | `read` HR Operations<br>🔒`onboarding_create` Onboarding — Create login<br>🔒`onboarding_review` Onboarding — Review / Reject<br>🔒`onboarding_approve` Onboarding — Approve<br>🔒`reminders_receive` Reminders — receive & view<br>🔒`requisitions` SIM & ID card requisitions — issue / reject |
| Task Management | `task_management` | শুধু মডিউলের অনুমতি (layer নেই) |
| Mobile Bill | `mobile_bill` | `read` Mobile Bill<br>`limit_history` Limit Change History |
| Target Reports | `target_reports` | `read` Target Reports<br>🔒`target_export` Targets — Excel / PDF<br>🔒`target_cancel` Targets — Cancel / Close |
| Mail Administration | `mail_admin` | `read` Mailbox list<br>🔒`mail_open` Open mailboxes (read only)<br>🔒`mail_password` See mailbox passwords<br>🔒`mail_settings` Internal delivery settings<br>🔒`mail_groups` Set up mail groups |
| Duty Roster | `duty_roster` | `read` See shifts and roster<br>🔒`roster_manage` Set shifts and roster |
| Break Time | `break_time` | `read` See break report<br>🔒`break_manage` Break rules, end forgotten breaks |
| User Feedback | `user_feedback` | শুধু মডিউলের অনুমতি (layer নেই) |
