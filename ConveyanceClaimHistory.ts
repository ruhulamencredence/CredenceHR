/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Conveyance Bill Claim edit trail (user_claim_history, see server.ts).
//
// A claim can be edited until its lock Layer approves it, and again after a
// Return or a Reject with "Allow re-claim" (ConveyanceBillClaimRoutes.ts). Each
// submit / edit / resubmit / return / reject is stored with the claim as it
// stood right after it (a snapshot), so an approver can be shown exactly what
// changed since they (or the Layer before them) last looked: the snapshot at
// the last Return/Reject — or the first submission — against the latest one.
//
// Also decides whether a claim may still be edited (claimEditState), since the
// employee's list, the edit route and the approvers' screens all need the same
// answer.

import { dhakaDate, type PolicyValues } from "./BillClaimPolicy";

type QueryDB = (sql: string, params?: any[]) => Promise<any>;

export interface ClaimSnapshot {
  from_date: string;
  to_date: string;
  amount: number;
  description: string | null;
  file_name: string | null;
  items: { category_name: string; bill_date: string; amount: number; description: string | null }[];
  refs: { claim_id: number; amount: number }[];
}

export type ClaimHistoryAction = "submitted" | "edited" | "resubmitted" | "returned" | "rejected";

export async function claimSnapshot(queryDB: QueryDB, claimId: number): Promise<ClaimSnapshot | null> {
  const rows: any[] = (await queryDB("SELECT from_date, to_date, amount, description, file_name FROM user_claims WHERE id = ?", [claimId])) || [];
  if (!rows.length) return null;
  const uc = rows[0];
  const items: any[] =
    (await queryDB("SELECT category_name, bill_date, amount, description FROM user_claim_items WHERE user_claim_id = ? ORDER BY bill_date, id", [claimId])) || [];
  const refs: any[] = (await queryDB("SELECT claim_id, amount FROM user_claim_references WHERE user_claim_id = ? ORDER BY claim_id", [claimId])) || [];
  return {
    from_date: dhakaDate(uc.from_date),
    to_date: dhakaDate(uc.to_date),
    amount: Number(uc.amount),
    description: uc.description ?? null,
    file_name: uc.file_name ?? null,
    items: items.map((i) => ({ category_name: i.category_name, bill_date: dhakaDate(i.bill_date), amount: Number(i.amount), description: i.description ?? null })),
    refs: refs.map((r) => ({ claim_id: Number(r.claim_id), amount: Number(r.amount) }))
  };
}

export async function recordClaimHistory(
  queryDB: QueryDB,
  claimId: number,
  action: ClaimHistoryAction,
  actor: { id: number; name: string } | null,
  reason: string | null
): Promise<void> {
  try {
    const snap = await claimSnapshot(queryDB, claimId);
    const v: any[] = (await queryDB("SELECT version FROM user_claims WHERE id = ?", [claimId])) || [];
    await queryDB(
      "INSERT INTO user_claim_history (user_claim_id, action, actor_id, actor_name, reason, version, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [claimId, action, actor?.id ?? null, actor?.name ?? null, reason, Number(v[0]?.version || 1), snap ? JSON.stringify(snap) : null]
    );
  } catch (err: any) {
    // The trail is a review aid; never fail the action because of it.
    console.warn(`⚠️ Could not record history for Conveyance Bill Claim #${claimId}: ${err.message}`);
  }
}

const money = (n: number) => `৳${Number(n).toLocaleString("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** What changed from `a` to `b`, one short line each. */
export function diffSnapshots(a: ClaimSnapshot, b: ClaimSnapshot): string[] {
  const out: string[] = [];
  if (a.from_date !== b.from_date || a.to_date !== b.to_date) out.push(`Dates: ${a.from_date} – ${a.to_date} → ${b.from_date} – ${b.to_date}`);
  // Bills are matched by date + category (several on the same key are added up).
  const group = (s: ClaimSnapshot) => {
    const m = new Map<string, number>();
    for (const i of s.items) {
      const k = `${i.bill_date} · ${i.category_name}`;
      m.set(k, Math.round(((m.get(k) || 0) + i.amount) * 100) / 100);
    }
    return m;
  };
  const ga = group(a);
  const gb = group(b);
  for (const [k, v] of gb) {
    if (!ga.has(k)) out.push(`Added bill ${k}: ${money(v)}`);
    else if (Math.abs(ga.get(k)! - v) > 0.005) out.push(`Bill ${k}: ${money(ga.get(k)!)} → ${money(v)}`);
  }
  for (const [k, v] of ga) if (!gb.has(k)) out.push(`Removed bill ${k}: ${money(v)}`);
  const refKey = (s: ClaimSnapshot) => s.refs.map((r) => `${r.claim_id}:${r.amount}`).join(",");
  if (refKey(a) !== refKey(b)) out.push(`Check-in/out references: ${a.refs.length} → ${b.refs.length}`);
  if ((a.description || "") !== (b.description || "")) out.push("Description changed");
  if ((a.file_name || "") !== (b.file_name || "")) out.push(b.file_name ? (a.file_name ? "Attachment replaced" : "Attachment added") : "Attachment removed");
  if (Math.abs(a.amount - b.amount) > 0.005) out.push(`Claim total: ${money(a.amount)} → ${money(b.amount)}`);
  return out;
}

export interface ClaimChangeInfo {
  // e.g. "Resubmitted after Return" / "Edited by the employee"
  note: string | null;
  changes: string[];
}

/**
 * For each claim: what changed since the last Return/Reject (or since it was
 * first submitted, when it has been edited before anyone acted on it).
 * Claims with no edits get no entry.
 */
export async function claimChangesFor(queryDB: QueryDB, claimIds: number[]): Promise<Map<number, ClaimChangeInfo>> {
  const out = new Map<number, ClaimChangeInfo>();
  if (!claimIds.length) return out;
  let rows: any[] = [];
  try {
    rows =
      (await queryDB(
        `SELECT user_claim_id, action, reason, snapshot_json FROM user_claim_history WHERE user_claim_id IN (${claimIds.map(() => "?").join(",")}) ORDER BY id`,
        claimIds
      )) || [];
  } catch {
    return out;
  }
  const by = new Map<number, any[]>();
  for (const r of rows) (by.get(Number(r.user_claim_id)) || by.set(Number(r.user_claim_id), []).get(Number(r.user_claim_id))!).push(r);
  for (const [id, list] of by) {
    const latest = list[list.length - 1];
    let baseIdx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].action === "returned" || list[i].action === "rejected") {
        baseIdx = i;
        break;
      }
    }
    if (baseIdx < 0) baseIdx = list.findIndex((r) => r.action === "submitted");
    if (baseIdx < 0 || baseIdx === list.length - 1) continue;
    let a: ClaimSnapshot | null = null;
    let b: ClaimSnapshot | null = null;
    try {
      a = JSON.parse(list[baseIdx].snapshot_json || "null");
      b = JSON.parse(latest.snapshot_json || "null");
    } catch {
      continue;
    }
    if (!a || !b) continue;
    const base = list[baseIdx];
    const note =
      base.action === "returned"
        ? `Resubmitted after Return${base.reason ? ` ("${base.reason}")` : ""}`
        : base.action === "rejected"
          ? `Resubmitted after Reject${base.reason ? ` ("${base.reason}")` : ""}`
          : "Edited by the employee after submitting";
    out.set(id, { note, changes: diffSnapshots(a, b) });
  }
  return out;
}

export type ClaimEditMode = "pending" | "returned" | "reclaim";

/**
 * Whether the claimant may still edit (or withdraw) this claim, per the Bill
 * Claim Policy's "edit until Layer N approves":
 *   pending, its request still at Layer <= N        -> editable
 *   returned to the employee                          -> editable
 *   rejected with "Allow re-claim"                    -> editable
 *   anything else (Layer N approved, approved, final reject) -> locked
 */
export function claimEditState(
  uc: any,
  request: any | null,
  policy: PolicyValues
): { editable: boolean; mode: ClaimEditMode | null; reason: string | null } {
  const lockLayer = Math.max(1, Number(policy.edit_lock_layer) || 1);
  if (uc.status === "approved") return { editable: false, mode: null, reason: "Approved — the bill has been made, so it can't be changed." };
  if (uc.status === "rejected") {
    return Number(uc.reclaim_allowed)
      ? { editable: true, mode: "reclaim", reason: null }
      : { editable: false, mode: null, reason: "Rejected — this is final." };
  }
  if (uc.edit_state === "returned") return { editable: true, mode: "returned", reason: null };
  if (!request || (request.status === "pending" && Number(request.current_step) <= lockLayer)) {
    return { editable: true, mode: "pending", reason: null };
  }
  return {
    editable: false,
    mode: null,
    reason: `Locked — Layer ${lockLayer === 1 ? "1 (Supervisor)" : lockLayer} has approved it. Ask the approver to Return it if it needs a change.`
  };
}

/** The (one) approval request of each claim, newest first wins. */
export async function claimRequests(queryDB: QueryDB, claimIds: number[]): Promise<Map<number, any>> {
  const out = new Map<number, any>();
  if (!claimIds.length) return out;
  const rows: any[] =
    (await queryDB(
      `SELECT * FROM approval_requests WHERE source_type = 'user_claim' AND source_id IN (${claimIds.map(() => "?").join(",")}) ORDER BY id`,
      claimIds
    )) || [];
  for (const r of rows) out.set(Number(r.source_id), r);
  return out;
}
