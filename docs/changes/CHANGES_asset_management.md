# Asset Management Module — What Was Added

## গুরুত্বপূর্ণ নোট
আপনার আপলোড করা zip-এ পুরো ফ্রন্টএন্ড (`src/components/`, `src/lib/`,
`types.ts` ইত্যাদি) ছিল না — শুধু `src/App.tsx` (shell) আর ব্যাকএন্ডের
রুট ফাইলগুলো ছিল। তাই ব্যাকএন্ড সম্পূর্ণভাবে wire করে দেওয়া হয়েছে
(server.ts-এ import/register করা আছে, আলাদা করে কিছু করার দরকার নেই),
কিন্তু ফ্রন্টএন্ড কম্পোনেন্টগুলো আপনার আসল প্রজেক্টে **নিজে বসাতে হবে**
নিচের নির্দেশনা অনুযায়ী — কারণ `ProfilePage.tsx`, `AdminPanel.tsx`,
`types.ts`, `GlobalSidebar.tsx` — এই ফাইলগুলো এই zip-এ ছিলই না।

---

## ✅ ব্যাকএন্ড (সম্পূর্ণ, আর কিছু করার দরকার নেই)

1. **`AssetManagementRoutes.ts`** (নতুন ফাইল) — পুরো Asset Management API:
   - Employee self-service: `GET/POST /api/assets/my*`, `POST /api/assets/requisitions`, `GET /api/assets/requisitions/my`
   - Line Manager approval: `GET /api/assets/requisitions/for-manager-approval`, `PUT /api/assets/requisitions/:id/manager-decision`
   - IT/Admin: `GET/POST/PUT /api/assets`, `GET /api/assets/requisitions`, `PUT .../admin-decision`, `POST .../fulfill`, `PUT /api/assets/assignments/:id/return`
2. **`server.ts`** — import + `registerAssetManagementRoutes(...)` কল করা হয়েছে, `ensureAssetManagementSchema(dbPool)` কে `ensureSchemaMigrations()`-এর ভেতর কল করা হয়েছে (তাই সার্ভার রিস্টার্ট করলেই টেবিল নিজে থেকে তৈরি হয়ে যাবে — কোনো ম্যানুয়াল SQL লাগবে না), এবং `ADMIN_MODULE_KEYS`-এ `"asset_management"` যোগ করা হয়েছে।
3. **`Alerts.ts`** — `AlertType`-এ `"asset_requisition"` যোগ করা হয়েছে (নতুন রিকুয়েস্ট/স্ট্যাটাস পরিবর্তনে বেল আইকনে নোটিফিকেশন যাবে)।
4. **`schema.sql`** — `assets`, `asset_requisitions`, `asset_assignments` টেবিল ফ্রেশ ইনস্টলের জন্য যোগ করা হয়েছে (ইতিমধ্যে চলা DB-এর জন্য `ensureAssetManagementSchema` নিজেই self-heal করবে)।

**একটাই অতিরিক্ত ধাপ:** Admin Panel -> Users -> Module Access থেকে যাকে
IT/Admin বানাতে চান তাকে `asset_management` মডিউল গ্রান্ট করুন (Superadmin
স্বয়ংক্রিয়ভাবে পাবে)।

## ✅ ফ্রন্টএন্ড (নতুন ফাইল — নিজের প্রজেক্টে কপি করে বসান)

- `src/components/AssetManagement.tsx` — Employee Profile-এর ট্যাব (My Assets / New Requisition / Requisition Status)।
- `src/components/AssetManagementAdmin.tsx` — Admin Panel-এর ট্যাব (Inventory + IT/Admin Approvals + Fulfill/Dispatch)।
- `src/components/AssetManagerApprovals.tsx` — Line Manager-দের জন্য ছোট widget (নিজের অধীনস্থদের pending রিকুয়েস্ট)।

### `ProfilePage.tsx`-এ যোগ করুন (Employee Profile)
```tsx
import { AssetManagement } from './AssetManagement';
// ... existing tabs (Personal Data, Change Password ইত্যাদি) এর পাশে:
<Tab label="Asset Management">
  <AssetManagement />
</Tab>
```

### `AdminPanel.tsx`-এ যোগ করুন (IT/Admin)
```tsx
import { AssetManagementAdmin } from './AssetManagementAdmin';
// অন্য মডিউল ট্যাবগুলোর (Payroll, Conveyance ইত্যাদি) মতোই, module='asset_management' চেক করে:
{userModules.includes('asset_management') && (
  <Tab label="Asset Management">
    <AssetManagementAdmin />
  </Tab>
)}
```

### `types.ts`-এ যোগ করুন
```ts
// AdminModuleKey union-এ 'asset_management' যোগ করুন (server.ts-এর
// ADMIN_MODULE_KEYS-এর সাথে হুবহু মিলতে হবে):
export type AdminModuleKey = ... | 'asset_management';
```

### Line Manager Approval widget কোথায় বসাবেন
`AssetManagerApprovals.tsx` কোনো নির্দিষ্ট মডিউল-এর সাথে বাঁধা না — যে
কেউ কারো Direct Supervisor হলেই এটা তার জন্য দেখাবে (খালি থাকলে কিছু
রেন্ডার করে না)। Self Service মেনুতে "Leave Approvals"-এর পাশে বসানো
যেতে পারে, অথবা Dashboard-এর উপরে।

```tsx
import { AssetManagerApprovals } from './AssetManagerApprovals';
<AssetManagerApprovals />
```

---

## Approval Workflow (যা document-এ চাওয়া হয়েছিল)
```
Submitted (pending)
   -> Line Manager Approved (manager_approved)   [employee_supervisors থেকে অটো-রিজলভড; ম্যানেজার না থাকলে স্কিপ]
   -> IT/Admin Approved (approved)                [requireModule('asset_management')]
   -> Dispatched (dispatched)                     [IT/Admin একটা নির্দিষ্ট আইটেম বেছে হ্যান্ডওভার করে]
   -> Employee "Accept & Acknowledge" করে
   -> Fulfilled (fulfilled)                       [Return হলে]
Rejected — যেকোনো ধাপে (Line Manager বা IT/Admin)
```
