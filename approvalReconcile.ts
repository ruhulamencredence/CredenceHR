/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Who is a pending request waiting on" can change after it was filed: the
// employee gets a new Supervisor, a Department's Supervisor changes, an
// approver is blocked / set inactive / leaves, or a Template Layer gets new
// people. Whatever makes such a change calls requestApprovalReconcile();
// server.ts's reconcilePendingApprovals then moves every pending request to
// whoever should have it now (and tells them). Debounced, so a burst of
// saves runs it once. It also runs on a timer (server.ts).

let handler: (() => Promise<unknown>) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function setApprovalReconcileHandler(fn: () => Promise<unknown>) {
  handler = fn;
}

export function requestApprovalReconcile(delayMs = 1500) {
  if (!handler) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void handler?.().catch((err: any) => console.warn("⚠️ Approval reconcile failed: " + err?.message));
  }, delayMs);
}
