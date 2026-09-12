/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Approve Applications / generic Approval workflow — the global ORDERED
// approval chain (Admin Panel -> Approvals config), the Admin-side approvals
// list + act, the recipient-side "My Approvals" list + act, and the Dynamic
// Approval Engine's Templates + Template Assignments (which request types
// route through a Template's per-step approvers instead of the old single
// global chain). Split out of server.ts on purpose — server.ts is already
// ~9,000+ lines in one file, so this moves out as-is (no logic changes) the
// same way Personal Data, Users, Holidays, Conveyance Bill Claims, and
// Attendance already were. Registered from inside startServer() via
// registerApprovalRoutes(), reusing that same request's
// `app`/`authenticateToken`/`queryDB`/etc. rather than creating a second
// Express app or a second DB connection.
//
// NOT included here: Leave's own POST /api/leave-applications/:id/
// reliever-decision (still in server.ts) — a Leave-specific step that sits
// alongside this generic system rather than inside it, even though the
// Approve Applications screens surface both in one combined list.
//
// getTemplateWithSteps/validateTemplateSteps are only used within this
// module so they're defined locally below. getApprovalChain/
// performApprovalAction/toDateOnlyString are defined elsewhere in server.ts
// and shared with other modules (Attendance, Leave, Claims all create/act on
// Approval Requests through them), so they're threaded through as deps
// rather than duplicated or re-imported directly.

import type { Express } from "express";

interface ApprovalRouteDeps {
  authenticateToken: any;
  requireAdmin: any;
  requireSuperAdmin: any;
  requireModule: (moduleKey: string) => any;
  queryDB: (sql: string, params?: any[]) => Promise<any>;
  getApprovalChain: () => Promise<any[]>;
  performApprovalAction: (...args: any[]) => Promise<any>;
  toDateOnlyString: (value: any) => string | null;
  // Same helper ConveyanceBillClaimRoutes.ts uses to attach each Movement
  // Claim's Approval Workflow status — reused here (GET /api/my-approvals)
  // to attach lat/lng + status onto every Movement Claim referenced by a
  // 'user_claim' item, so an approver can open its location on a map without
  // a second permission-gated lookup.
  attachApprovalStatuses: (sourceType: "attendance" | "claim", rows: any[]) => Promise<any[]>;
}

export function registerApprovalRoutes(app: Express, deps: ApprovalRouteDeps) {
  const {
    authenticateToken,
    requireAdmin,
    requireSuperAdmin,
    requireModule,
    queryDB,
    getApprovalChain,
    performApprovalAction,
    toDateOnlyString,
    attachApprovalStatuses
  } = deps;

  // Attaches a `claim_refs: [{ claim_id, amount, purpose, check_in_at,
  // check_out_at, distance_km, check_in_lat/lng, check_out_lat/lng, ... }]`
  // array onto every 'user_claim' item in a GET /api/my-approvals list (every
  // other source_type is left untouched) — same shape/query as
  // ConveyanceBillClaimRoutes.ts's own attachUserClaimRefs, duplicated here
  // rather than imported since that one is private to that module's route
  // factory. Lets the Approve Application page show a "View Location" button
  // for any Movement Claim a Conveyance Bill Claim was built from, same as
  // the Admin Panel's own Conveyance Bill Claim review already does.
  async function attachClaimRefsToMyApprovals(rows: any[]): Promise<any[]> {
    const userClaimIds = rows.filter((r: any) => r.source_type === "user_claim").map((r: any) => Number(r.source_id));
    if (userClaimIds.length === 0) return rows;
    const refRows = await queryDB(
      `SELECT r.user_claim_id, r.claim_id, r.amount, c.purpose, c.check_in_at, c.check_out_at, c.distance_km,
              c.check_in_lat, c.check_in_lng, c.check_out_lat, c.check_out_lng
         FROM user_claim_references r
         JOIN claims c ON c.id = r.claim_id
        WHERE r.user_claim_id IN (${userClaimIds.map(() => "?").join(",")})
        ORDER BY r.id ASC`,
      userClaimIds
    );
    const withApproval = await attachApprovalStatuses(
      "claim",
      refRows.map((rr: any) => ({ ...rr, id: rr.claim_id }))
    );
    const byUserClaim: Record<number, any[]> = {};
    for (const rr of withApproval) {
      const key = Number(rr.user_claim_id);
      if (!byUserClaim[key]) byUserClaim[key] = [];
      byUserClaim[key].push({
        claim_id: Number(rr.claim_id),
        amount: Number(rr.amount),
        purpose: rr.purpose,
        check_in_at: rr.check_in_at,
        check_out_at: rr.check_out_at,
        distance_km: rr.distance_km !== null ? Number(rr.distance_km) : null,
        check_in_lat: rr.check_in_lat !== null ? Number(rr.check_in_lat) : null,
        check_in_lng: rr.check_in_lng !== null ? Number(rr.check_in_lng) : null,
        check_out_lat: rr.check_out_lat !== null ? Number(rr.check_out_lat) : null,
        check_out_lng: rr.check_out_lng !== null ? Number(rr.check_out_lng) : null,
        check_in_approval: rr.check_in_approval,
        check_out_approval: rr.check_out_approval
      });
    }
    return rows.map((r: any) => (r.source_type === "user_claim" ? { ...r, claim_refs: byUserClaim[Number(r.source_id)] || [] } : r));
  }

  // 2c-2. Approval Workflow — a single global, ORDERED chain of Admin/Superadmin
  // approvers (Superadmin-only to configure). Every Check In / Check Out (Remote
  // Attendance OR Movement Claims) already recorded immediately (non-blocking) also
  // routes an Approval Request through this chain layer by layer — see
  // createApprovalRequest above. Gated behind the "approvals" Admin Panel module.

  // The chain itself, in order — any Admin/Superadmin with the "approvals" module
  // can view it (so they know who's ahead of / behind them), only a Superadmin can
  // change it (PUT below).
  app.get("/api/approvals/chain", authenticateToken, requireAdmin, requireModule("approvals"), async (req, res) => {
    try {
      const chain = await getApprovalChain();
      res.json(chain);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Replaces the entire chain with an ordered list of user_ids (index 0 = first
  // layer / first approver, last index = final layer). Superadmin-only. Doesn't
  // touch any Approval Request already in flight — those keep their own
  // total_steps snapshot from when they were created.
  app.put("/api/approvals/chain", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const userIds = Array.isArray(req.body?.user_ids) ? req.body.user_ids.map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v)) : null;
      if (!userIds) return res.status(400).json({ error: "user_ids must be an array." });
      if (new Set(userIds).size !== userIds.length) {
        return res.status(400).json({ error: "The same approver can't appear twice in the chain." });
      }
      if (userIds.length > 0) {
        const allUsers = await queryDB("SELECT id, role FROM users");
        const userMap = new Map<number, any>(allUsers.map((u: any) => [Number(u.id), u]));
        for (const uid of userIds) {
          const u = userMap.get(uid);
          if (!u) return res.status(400).json({ error: `User #${uid} not found.` });
          if (u.role !== "admin" && u.role !== "superadmin") {
            return res.status(400).json({ error: `Only Admin/Superadmin accounts can be in the Approval Chain (user #${uid} is a plain user).` });
          }
        }
      }
      await queryDB("DELETE FROM approval_chain_steps");
      for (let i = 0; i < userIds.length; i++) {
        await queryDB("INSERT INTO approval_chain_steps (step_order, user_id) VALUES (?, ?)", [i + 1, userIds[i]]);
      }
      res.json({ success: true, chain: await getApprovalChain() });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every Approval Request, newest first, with enough context (source event
  // details + who's up next) for the Admin Panel -> Approvals queue/history.
  app.get("/api/approvals", authenticateToken, requireAdmin, requireModule("approvals"), async (req: any, res) => {
    try {
      const [requests, chain, templateStepApproverRows, attendanceRows, claimRows, userClaimRows, attendanceCorrectionRows, leaveApplicationRows, projects, users] = await Promise.all([
        queryDB("SELECT ar.*, u.name AS requested_by_name FROM approval_requests ar LEFT JOIN users u ON u.id = ar.requested_by ORDER BY ar.id DESC"),
        getApprovalChain(),
        queryDB(
          `SELECT s.template_id, s.step_order, sa.user_id, u.name AS user_name
           FROM approval_template_step_approvers sa
           JOIN approval_template_steps s ON s.id = sa.step_id
           LEFT JOIN users u ON u.id = sa.user_id`
        ),
        queryDB("SELECT * FROM attendance"),
        queryDB("SELECT * FROM claims"),
        queryDB("SELECT * FROM user_claims"),
        queryDB("SELECT * FROM attendance_corrections"),
        queryDB("SELECT * FROM leave_applications"),
        queryDB("SELECT * FROM projects"),
        queryDB("SELECT id, name, email, role, created_at FROM users")
      ]);
      const attendanceMap = new Map<number, any>(attendanceRows.map((a: any) => [Number(a.id), a]));
      const claimMap = new Map<number, any>(claimRows.map((c: any) => [Number(c.id), c]));
      const userClaimMap = new Map<number, any>(userClaimRows.map((c: any) => [Number(c.id), c]));
      const attendanceCorrectionMap = new Map<number, any>(attendanceCorrectionRows.map((c: any) => [Number(c.id), c]));
      const leaveApplicationMap = new Map<number, any>(leaveApplicationRows.map((l: any) => [Number(l.id), l]));
      const projectMap = new Map<number, any>(projects.map((p: any) => [Number(p.id), p]));
      const userMap = new Map<number, any>(users.map((u: any) => [Number(u.id), u]));
      const chainByStep = new Map<number, any>(chain.map((s: any) => [Number(s.step_order), s]));
      // Dynamic Approval Engine (Part 3) — same idea as chainByStep above, but
      // keyed by "template_id:step_order" and holding an ARRAY of approvers
      // (any one of whom clears that step), not a single user_id.
      const templateStepApproversMap = new Map<string, { user_id: number; user_name: string | null }[]>();
      for (const r of templateStepApproverRows) {
        const key = `${r.template_id}:${r.step_order}`;
        if (!templateStepApproversMap.has(key)) templateStepApproversMap.set(key, []);
        templateStepApproversMap.get(key)!.push({ user_id: Number(r.user_id), user_name: r.user_name });
      }

      const status = req.query.status ? String(req.query.status) : null;
      const mineOnly = req.query.mine === "true";

      const enriched = requests
        .map((r: any) => {
          let sourceLabel = "";
          let sourceAmount: number | null = null;
          let sourceCategory: string | null = null;
          let sourceApprovedAmount: number | null = null;
          if (r.source_type === "attendance") {
            const a = attendanceMap.get(Number(r.source_id));
            const proj = a ? projectMap.get(Number(a.project_id)) : null;
            sourceLabel = proj ? proj.project_name : "(project removed)";
          } else if (r.source_type === "user_claim") {
            const uc = userClaimMap.get(Number(r.source_id));
            sourceLabel = uc ? String(uc.description || `${uc.category} claim`) : "(claim removed)";
            sourceAmount = uc ? Number(uc.amount) : null;
            sourceCategory = uc ? uc.category : null;
            sourceApprovedAmount = uc && uc.approved_amount != null ? Number(uc.approved_amount) : null;
          } else if (r.source_type === "attendance_correction") {
            const ac = attendanceCorrectionRows.length ? attendanceCorrectionMap.get(Number(r.source_id)) : null;
            const proj = ac ? projectMap.get(Number(ac.project_id)) : null;
            sourceLabel = ac
              ? `${toDateOnlyString(ac.attendance_date)} \u2014 ${proj ? proj.project_name : "(project removed)"}`
              : "(request removed)";
          } else if (r.source_type === "leave_application") {
            const la = leaveApplicationMap.get(Number(r.source_id));
            const leaveTypeLabel = la ? (la.leave_type === "casual" ? "Casual" : la.leave_type === "sick" ? "Sick" : "Leave Without Pay") : null;
            sourceLabel = la
              ? `${leaveTypeLabel} \u2014 ${toDateOnlyString(la.start_date)} to ${toDateOnlyString(la.end_date)} (${Number(la.day_count)} day${Number(la.day_count) === 1 ? "" : "s"})`
              : "(application removed)";
          } else {
            const c = claimMap.get(Number(r.source_id));
            sourceLabel = c ? c.purpose : "(claim removed)";
          }
          // Dynamic Approval Engine (Part 3) — resolve current-step approver(s)
          // from the Template if this request is riding one (template_id set),
          // else fall back to the OLD single-approver global chain exactly as
          // before. Department Supervisor auto-layer (Part 6): when
          // supervisor_step_user_id is set, step_order 1 IS that Supervisor and
          // the Template's own steps are shifted down by one.
          let currentApprovers: { user_id: number; user_name: string | null }[] = [];
          if (r.status === "pending") {
            const hasSupervisorStep = !!r.supervisor_step_user_id;
            if (hasSupervisorStep && Number(r.current_step) === 1) {
              const su = userMap.get(Number(r.supervisor_step_user_id));
              currentApprovers = [{ user_id: Number(r.supervisor_step_user_id), user_name: su ? su.name : null }];
            } else if (r.template_id) {
              const templateStepOrder = hasSupervisorStep ? Number(r.current_step) - 1 : Number(r.current_step);
              currentApprovers = templateStepApproversMap.get(`${r.template_id}:${templateStepOrder}`) || [];
            } else {
              const step = chainByStep.get(Number(r.current_step));
              if (step) currentApprovers = [{ user_id: Number(step.user_id), user_name: step.user_name }];
            }
          }
          let actions: any[] = [];
          try {
            actions = JSON.parse(r.actions_json || "[]");
          } catch {
            actions = [];
          }
          return {
            ...r,
            source_label: sourceLabel,
            source_amount: sourceAmount,
            source_category: sourceCategory,
            source_approved_amount: sourceApprovedAmount,
            current_approver_id: currentApprovers[0] ? Number(currentApprovers[0].user_id) : null,
            current_approver_name: currentApprovers.length > 0 ? currentApprovers.map((a) => a.user_name || `User #${a.user_id}`).join(" or ") : null,
            current_approver_ids: currentApprovers.map((a) => a.user_id),
            actions
          };
        })
        .filter((r: any) => {
          if (status && r.status !== status) return false;
          if (mineOnly) {
            if (req.user.role === "superadmin") return r.status === "pending";
            return r.status === "pending" && r.current_approver_ids.includes(Number(req.user.id));
          }
          return true;
        });

      res.json(enriched.slice(0, 1000));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Approve or Reject the request at its CURRENT step. Only the approver assigned
  // to that step may act (a Superadmin may act at any step, as an override). An
  // Approve on the LAST step marks the whole request 'approved'; otherwise it just
  // advances current_step to the next layer. A Reject is terminal — the chain stops
  // there regardless of which step it happened at.
  app.post("/api/approvals/:id/act", authenticateToken, requireAdmin, requireModule("approvals"), async (req: any, res) => {
    try {
      const { id } = req.params;
      const action = req.body?.action;
      if (action !== "approved" && action !== "rejected") {
        return res.status(400).json({ error: "action must be 'approved' or 'rejected'." });
      }
      const remarks = typeof req.body?.remarks === "string" ? req.body.remarks.trim().slice(0, 1000) || null : null;
      const billId = req.body?.bill_id ? Number(req.body.bill_id) : null;
      // Approved Amount — only meaningful for a 'user_claim' Approve; ignored
      // otherwise. Lets the approver approve for less than the Claim Amount.
      const approvedAmount = req.body?.approved_amount != null && req.body.approved_amount !== "" ? Number(req.body.approved_amount) : null;

      const { status, current_step, billInfo } = await performApprovalAction(Number(id), req.user, action, remarks, billId, approvedAmount);
      res.json({ success: true, status, current_step, ...billInfo });
    } catch (err: any) {
      res.status(err instanceof ApprovalActionError ? err.statusCode : 500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // Personal "waiting on me" Approval Queue (Part 4 of 5) — Role Permissiveness.
  // A Template step's approvers may be ANY user account, role='user' included
  // (Part 2/3) — but role='user' normally can't get anywhere near
  // GET/POST /api/approvals above (requireAdmin blocks it unless that account
  // also happens to hold an Admin Panel module grant, which most approvers
  // never will). These two routes are the fix: authenticateToken ONLY, no
  // requireAdmin/requireModule, so a plain Employee named as an approver on a
  // Template can see and act on exactly the handful of requests genuinely
  // waiting on them — nothing about the wider Approvals module opens up
  // because of this; performApprovalAction still independently checks that
  // the caller is actually one of the current step's approvers (or a
  // Superadmin override) before allowing the action either way.
  // ==========================================================================

  // Every 'pending' request where the calling account is one of the CURRENT
  // step's approvers — powers the Dashboard "Pending Approvals" card/alert
  // for a regular Employee (see PendingApprovalsCard.tsx), as well as the
  // same widget reused inside the Admin Panel queue for consistency.
  app.get("/api/my-approvals", authenticateToken, async (req: any, res) => {
    try {
      const [pendingRequests, templateStepApproverRows, chain, userClaimRows, attendanceCorrectionRows, leaveApplicationRows, projects, requesterRows] = await Promise.all([
        queryDB("SELECT * FROM approval_requests WHERE status = 'pending' ORDER BY id ASC"),
        queryDB(
          `SELECT s.template_id, s.step_order, sa.user_id
           FROM approval_template_step_approvers sa
           JOIN approval_template_steps s ON s.id = sa.step_id`
        ),
        getApprovalChain(),
        queryDB("SELECT * FROM user_claims"),
        queryDB("SELECT * FROM attendance_corrections"),
        queryDB("SELECT * FROM leave_applications"),
        queryDB("SELECT * FROM projects"),
        queryDB("SELECT id, name FROM users")
      ]);
      const templateStepApproverIds = new Map<string, number[]>();
      for (const r of templateStepApproverRows) {
        const key = `${r.template_id}:${r.step_order}`;
        if (!templateStepApproverIds.has(key)) templateStepApproverIds.set(key, []);
        templateStepApproverIds.get(key)!.push(Number(r.user_id));
      }
      const chainByStep = new Map<number, any>(chain.map((s: any) => [Number(s.step_order), s]));
      const userClaimMap = new Map<number, any>(userClaimRows.map((c: any) => [Number(c.id), c]));
      const attendanceCorrectionMap = new Map<number, any>(attendanceCorrectionRows.map((c: any) => [Number(c.id), c]));
      const leaveApplicationMap = new Map<number, any>(leaveApplicationRows.map((l: any) => [Number(l.id), l]));
      const projectMap = new Map<number, any>(projects.map((p: any) => [Number(p.id), p]));
      const requesterMap = new Map<number, any>(requesterRows.map((u: any) => [Number(u.id), u]));
      const myId = Number(req.user.id);

      const mine = pendingRequests.filter((r: any) => {
        // Department Supervisor auto-layer (Part 6) — step_order 1 is the
        // Supervisor when supervisor_step_user_id is set, same shift as
        // GET /api/approvals above.
        const hasSupervisorStep = !!r.supervisor_step_user_id;
        if (hasSupervisorStep && Number(r.current_step) === 1) {
          return Number(r.supervisor_step_user_id) === myId;
        }
        if (r.template_id) {
          const templateStepOrder = hasSupervisorStep ? Number(r.current_step) - 1 : Number(r.current_step);
          const approverIds = templateStepApproverIds.get(`${r.template_id}:${templateStepOrder}`) || [];
          return approverIds.includes(myId);
        }
        const step = chainByStep.get(Number(r.current_step));
        return !!step && Number(step.user_id) === myId;
      });

      // Reliever workflow — Leave Applications waiting specifically on THIS
      // account as Reliever haven't reached the Dynamic Approval Engine yet
      // (no approval_requests row exists for them), so they're invisible to
      // the `mine` filter above. Surfaced here as their own source_type
      // ('leave_reliever') so this one personal queue still covers both
      // roles an account can be asked to act in. See POST
      // /api/leave-applications/:id/reliever-decision for how these are
      // actually decided.
      const relieverItems = leaveApplicationRows.filter(
        (la: any) => Number(la.reliever_id) === myId && la.reliever_status === "pending" && la.status === "pending"
      );

      const combined = [
        ...mine.map((r: any) => {
          let sourceLabel = "";
          let sourceAmount: number | null = null;
          // Running Approved Amount (Part 6b) — if an EARLIER Layer (e.g. the
          // Department/Direct Supervisor auto-layer, step 1) already edited the
          // Approved Amount on a still-pending 'user_claim', this carries that
          // value forward as this Layer's pre-fill instead of the full Claim
          // Amount — see updateUserClaimApprovedAmountDraft in server.ts.
          let sourceApprovedAmount: number | null = null;
          if (r.source_type === "user_claim") {
            const uc = userClaimMap.get(Number(r.source_id));
            sourceLabel = uc ? String(uc.description || `${uc.category} claim`) : "(claim removed)";
            sourceAmount = uc ? Number(uc.amount) : null;
            sourceApprovedAmount = uc && uc.approved_amount != null ? Number(uc.approved_amount) : null;
          } else if (r.source_type === "attendance_correction") {
            const ac = attendanceCorrectionMap.get(Number(r.source_id));
            const proj = ac ? projectMap.get(Number(ac.project_id)) : null;
            sourceLabel = ac
              ? `${toDateOnlyString(ac.attendance_date)} \u2014 ${proj ? proj.project_name : "(project removed)"}`
              : "(request removed)";
          } else if (r.source_type === "leave_application") {
            const la = leaveApplicationMap.get(Number(r.source_id));
            const leaveTypeLabel = la ? (la.leave_type === "casual" ? "Casual" : la.leave_type === "sick" ? "Sick" : "Leave Without Pay") : null;
            sourceLabel = la
              ? `${leaveTypeLabel} \u2014 ${toDateOnlyString(la.start_date)} to ${toDateOnlyString(la.end_date)} (${Number(la.day_count)} day${Number(la.day_count) === 1 ? "" : "s"})`
              : "(application removed)";
          }
          return {
            id: r.id,
            source_type: r.source_type,
            source_id: r.source_id,
            source_label: sourceLabel,
            source_amount: sourceAmount,
            source_approved_amount: sourceApprovedAmount,
            requested_by: r.requested_by,
            requested_by_name: requesterMap.get(Number(r.requested_by))?.name || null,
            current_step: r.current_step,
            total_steps: r.total_steps,
            created_at: r.created_at
          };
        }),
        ...relieverItems.map((la: any) => {
          const leaveTypeLabel = la.leave_type === "casual" ? "Casual" : la.leave_type === "sick" ? "Sick" : "Leave Without Pay";
          return {
            id: la.id,
            source_type: "leave_reliever",
            source_id: la.id,
            source_label: `${leaveTypeLabel} \u2014 ${toDateOnlyString(la.start_date)} to ${toDateOnlyString(la.end_date)} (${Number(la.day_count)} day${Number(la.day_count) === 1 ? "" : "s"})`,
            source_amount: null,
            requested_by: la.user_id,
            requested_by_name: requesterMap.get(Number(la.user_id))?.name || null,
            current_step: null,
            total_steps: null,
            created_at: la.created_at
          };
        })
      ];

      res.json(await attachClaimRefsToMyApprovals(combined));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Approve/Reject a request from the personal queue — same underlying
  // performApprovalAction as the Admin Panel's version, just without the
  // Admin Panel module gate. Still 403s if the caller isn't actually one of
  // the current step's approvers.
  app.post("/api/my-approvals/:id/act", authenticateToken, async (req: any, res) => {
    try {
      const { id } = req.params;
      const action = req.body?.action;
      if (action !== "approved" && action !== "rejected") {
        return res.status(400).json({ error: "action must be 'approved' or 'rejected'." });
      }
      const remarks = typeof req.body?.remarks === "string" ? req.body.remarks.trim().slice(0, 1000) || null : null;
      const billId = req.body?.bill_id ? Number(req.body.bill_id) : null;
      // Approved Amount — only meaningful for a 'user_claim' Approve; ignored
      // otherwise. Lets the approver approve for less than the Claim Amount,
      // same as the Admin Panel's Approvals tab.
      const approvedAmount = req.body?.approved_amount != null && req.body.approved_amount !== "" ? Number(req.body.approved_amount) : null;

      const { status, current_step, billInfo } = await performApprovalAction(Number(id), req.user, action, remarks, billId, approvedAmount);
      res.json({ success: true, status, current_step, ...billInfo });
    } catch (err: any) {
      res.status(err instanceof ApprovalActionError ? err.statusCode : 500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // Approval Workflow TEMPLATES — Admin Panel APIs (Dynamic Approval Engine,
  // Part 2 of 5). This is a SEPARATE system from the old single-global-chain
  // above (approval_chain_steps/approval_requests) — see the long design
  // comment above approval_templates in initDB(). Superadmin builds/edits/
  // deletes Templates here; Part 3 is what actually reads them to route a
  // freshly-submitted Conveyance/Leave/Timesheet request.
  //
  // NOTE: unlike the old chain's PUT /api/approvals/chain (which only allows
  // 'admin'/'superadmin' accounts as approvers), a Template step's approvers
  // may be ANY user account regardless of role — see Part 4's "role='user'
  // can be an approver" requirement. That loosening is intentional here, not
  // an oversight.
  // ==========================================================================

  // Loads one Template's ordered steps, each with its approver list —
  // shared by the detail route below and (in Part 3) the engine that builds
  // a request's approval chain from a Template.
  async function getTemplateWithSteps(templateId: number) {
    const templates = await queryDB("SELECT * FROM approval_templates WHERE id = ?", [templateId]);
    if (templates.length === 0) return null;
    const template = templates[0];
    const steps = await queryDB("SELECT * FROM approval_template_steps WHERE template_id = ? ORDER BY step_order ASC", [templateId]);
    const approverRows = await queryDB(
      `SELECT sa.*, u.name AS user_name
       FROM approval_template_step_approvers sa
       JOIN approval_template_steps s ON s.id = sa.step_id
       LEFT JOIN users u ON u.id = sa.user_id
       WHERE s.template_id = ?
       ORDER BY sa.id ASC`,
      [templateId]
    );
    const approversByStep = new Map<number, any[]>();
    for (const a of approverRows) {
      const key = Number(a.step_id);
      if (!approversByStep.has(key)) approversByStep.set(key, []);
      approversByStep.get(key)!.push({ id: a.id, step_id: a.step_id, user_id: a.user_id, user_name: a.user_name });
    }
    return {
      ...template,
      is_default: !!Number(template.is_default),
      is_active: !!Number(template.is_active),
      steps: steps.map((s: any) => ({ ...s, approvers: approversByStep.get(Number(s.id)) || [] }))
    };
  }

  // Validates the `steps` array a Template create/update request sends:
  // [{ approver_user_ids: number[] }, ...], step_order assigned by array
  // position (index + 1). Returns a cleaned copy, or throws with a message
  // safe to send straight back to the client.
  async function validateTemplateSteps(steps: any): Promise<{ approver_user_ids: number[] }[]> {
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error("A template needs at least one Layer/Step.");
    }
    const allUsers = await queryDB("SELECT id FROM users");
    const validUserIds = new Set<number>(allUsers.map((u: any) => Number(u.id)));
    const cleaned: { approver_user_ids: number[] }[] = [];
    steps.forEach((step: any, idx: number) => {
      const ids = Array.isArray(step?.approver_user_ids) ? step.approver_user_ids.map((v: any) => Number(v)).filter((v: number) => Number.isFinite(v)) : [];
      const uniqueIds = Array.from(new Set(ids));
      if (uniqueIds.length === 0) {
        throw new Error(`Layer ${idx + 1} needs at least one approver.`);
      }
      for (const uid of uniqueIds) {
        if (!validUserIds.has(uid)) throw new Error(`Layer ${idx + 1}: user #${uid} not found.`);
      }
      cleaned.push({ approver_user_ids: uniqueIds });
    });
    return cleaned;
  }

  // Every Template, newest-first, with a step_count so the list screen doesn't
  // need a second call per row. Optional ?request_type= filter for the
  // "New Assignment" screen's template picker.
  app.get("/api/approval-templates", authenticateToken, requireAdmin, requireModule("approvals"), async (req: any, res) => {
    try {
      const requestType = req.query?.request_type ? String(req.query.request_type) : null;
      const templates = await queryDB(
        requestType ? "SELECT * FROM approval_templates WHERE request_type = ? ORDER BY name ASC" : "SELECT * FROM approval_templates ORDER BY request_type ASC, name ASC",
        requestType ? [requestType] : []
      );
      const stepCounts = await queryDB("SELECT template_id, COUNT(*) AS cnt FROM approval_template_steps GROUP BY template_id");
      const countByTemplate = new Map<number, number>(stepCounts.map((r: any) => [Number(r.template_id), Number(r.cnt)]));
      res.json(
        templates.map((t: any) => ({
          ...t,
          is_default: !!Number(t.is_default),
          is_active: !!Number(t.is_active),
          step_count: countByTemplate.get(Number(t.id)) || 0
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Full detail — name/flags plus every ordered step and its approvers — for
  // the Template edit screen.
  app.get("/api/approval-templates/:id", authenticateToken, requireAdmin, requireModule("approvals"), async (req: any, res) => {
    try {
      const template = await getTemplateWithSteps(Number(req.params.id));
      if (!template) return res.status(404).json({ error: "Template not found." });
      res.json(template);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Creates a Template plus its ordered steps/approvers in one call — the
  // Template edit screen always submits the whole thing at once, never a step
  // at a time. Superadmin-only.
  app.post("/api/approval-templates", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const name = req.body?.name ? String(req.body.name).trim() : "";
      const requestType = req.body?.request_type;
      const isDefault = !!req.body?.is_default;
      const isActive = req.body?.is_active === false ? false : true;
      if (!name) return res.status(400).json({ error: "Template name is required." });
      if (!["conveyance", "leave", "timesheet"].includes(requestType)) {
        return res.status(400).json({ error: "request_type must be one of conveyance, leave, timesheet." });
      }
      const steps = await validateTemplateSteps(req.body?.steps);

      if (isDefault) {
        // At most one default per request_type — enforced here, not in the DB
        // (see the comment on approval_templates.is_default in initDB()).
        await queryDB("UPDATE approval_templates SET is_default = 0 WHERE request_type = ?", [requestType]);
      }

      const result = await queryDB(
        "INSERT INTO approval_templates (name, request_type, is_default, is_active, created_by) VALUES (?, ?, ?, ?, ?)",
        [name, requestType, isDefault ? 1 : 0, isActive ? 1 : 0, req.user.id]
      );
      const templateId = result.insertId;

      for (let i = 0; i < steps.length; i++) {
        const stepResult = await queryDB("INSERT INTO approval_template_steps (template_id, step_order) VALUES (?, ?)", [templateId, i + 1]);
        const stepId = stepResult.insertId;
        for (const uid of steps[i].approver_user_ids) {
          await queryDB("INSERT INTO approval_template_step_approvers (step_id, user_id) VALUES (?, ?)", [stepId, uid]);
        }
      }

      res.status(201).json(await getTemplateWithSteps(templateId));
    } catch (err: any) {
      res.status(err.message?.includes("not found") || err.message?.includes("needs at least") ? 400 : 500).json({ error: err.message });
    }
  });

  // Replaces a Template's name/flags AND its entire step/approver list
  // wholesale (delete-and-reinsert, same pattern as PUT /api/notices/:id's
  // target list) — the edit form always submits the full intended shape, not
  // a diff. Superadmin-only. request_type can't be changed once ANY employee
  // is assigned this template — that would silently point their
  // Conveyance/Leave/Timesheet request at the wrong flow's chain.
  app.put("/api/approval-templates/:id", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existingRows = await queryDB("SELECT * FROM approval_templates WHERE id = ?", [id]);
      if (existingRows.length === 0) return res.status(404).json({ error: "Template not found." });
      const existing = existingRows[0];

      const name = req.body?.name ? String(req.body.name).trim() : "";
      const requestType = req.body?.request_type;
      const isDefault = !!req.body?.is_default;
      const isActive = req.body?.is_active === false ? false : true;
      if (!name) return res.status(400).json({ error: "Template name is required." });
      if (!["conveyance", "leave", "timesheet"].includes(requestType)) {
        return res.status(400).json({ error: "request_type must be one of conveyance, leave, timesheet." });
      }
      if (requestType !== existing.request_type) {
        const assignedCount = await queryDB("SELECT COUNT(*) AS cnt FROM employee_template_assignments WHERE template_id = ?", [id]);
        if (Number(assignedCount[0]?.cnt || 0) > 0) {
          return res.status(400).json({ error: "This template is assigned to one or more employees — create a new template instead of changing its Request Type." });
        }
      }
      const steps = await validateTemplateSteps(req.body?.steps);

      if (isDefault) {
        await queryDB("UPDATE approval_templates SET is_default = 0 WHERE request_type = ? AND id <> ?", [requestType, id]);
      }

      await queryDB("UPDATE approval_templates SET name = ?, request_type = ?, is_default = ?, is_active = ? WHERE id = ?", [
        name,
        requestType,
        isDefault ? 1 : 0,
        isActive ? 1 : 0,
        id
      ]);

      // Replace the step/approver tree wholesale — ON DELETE CASCADE on
      // approval_template_step_approvers.step_id takes the approver rows with it.
      await queryDB("DELETE FROM approval_template_steps WHERE template_id = ?", [id]);
      for (let i = 0; i < steps.length; i++) {
        const stepResult = await queryDB("INSERT INTO approval_template_steps (template_id, step_order) VALUES (?, ?)", [id, i + 1]);
        const stepId = stepResult.insertId;
        for (const uid of steps[i].approver_user_ids) {
          await queryDB("INSERT INTO approval_template_step_approvers (step_id, user_id) VALUES (?, ?)", [stepId, uid]);
        }
      }

      res.json(await getTemplateWithSteps(id));
    } catch (err: any) {
      res.status(err.message?.includes("not found") || err.message?.includes("needs at least") ? 400 : 500).json({ error: err.message });
    }
  });

  // Deletes a Template outright. Blocked (400, not a silent cascade) whenever
  // it's still in active use — either as a request_type's default fallback, or
  // explicitly assigned to one or more employees — since
  // employee_template_assignments.template_id is ON DELETE CASCADE and would
  // otherwise quietly strip those employees' routing without telling anyone.
  app.delete("/api/approval-templates/:id", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const rows = await queryDB("SELECT * FROM approval_templates WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Template not found." });
      const template = rows[0];
      if (Number(template.is_default)) {
        return res.status(400).json({ error: "This is the default template for its Request Type — make another template the default first." });
      }
      const assignedCount = await queryDB("SELECT COUNT(*) AS cnt FROM employee_template_assignments WHERE template_id = ?", [id]);
      if (Number(assignedCount[0]?.cnt || 0) > 0) {
        return res.status(400).json({ error: `${assignedCount[0].cnt} employee(s) are assigned this template — reassign them first.` });
      }
      await queryDB("DELETE FROM approval_templates WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Makes this Template the default (company-wide fallback) for its
  // request_type, unsetting whichever one held that spot before. Pass
  // { is_default: false } to just unset this one without picking a new default.
  app.put("/api/approval-templates/:id/default", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const rows = await queryDB("SELECT * FROM approval_templates WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Template not found." });
      const template = rows[0];
      const makeDefault = req.body?.is_default !== false;
      if (makeDefault) {
        await queryDB("UPDATE approval_templates SET is_default = 0 WHERE request_type = ?", [template.request_type]);
      }
      await queryDB("UPDATE approval_templates SET is_default = ? WHERE id = ?", [makeDefault ? 1 : 0, id]);
      res.json(await getTemplateWithSteps(id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Soft on/off switch — an inactive Template stays intact (and still shows in
  // history for anyone already routed through it) but can no longer be newly
  // assigned or picked as a default. Doesn't retroactively touch requests
  // already in flight on it.
  app.put("/api/approval-templates/:id/active", authenticateToken, requireSuperAdmin, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const rows = await queryDB("SELECT * FROM approval_templates WHERE id = ?", [id]);
      if (rows.length === 0) return res.status(404).json({ error: "Template not found." });
      const isActive = req.body?.is_active !== false;
      if (!isActive && Number(rows[0].is_default)) {
        return res.status(400).json({ error: "The default template for a Request Type can't be deactivated — make another one the default first." });
      }
      await queryDB("UPDATE approval_templates SET is_active = ? WHERE id = ?", [isActive ? 1 : 0, id]);
      res.json(await getTemplateWithSteps(id));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // Employee <-> Template Assignment — Admin Panel "Template Assignment" screen
  // (Part 2 of 5, continued). One row per (employee, request_type); a missing
  // row just means "use that request_type's default template" (resolved
  // client-side here as effective_template_id/name so the screen can show it
  // without a second lookup).
  // ==========================================================================

  // Every user account, joined against any assignment row for the given
  // request_type, plus that request_type's current default (so the UI can
  // show "— uses default (X)" for anyone without an explicit pick).
  app.get("/api/template-assignments", authenticateToken, requireAdmin, requireModule("approvals"), async (req: any, res) => {
    try {
      const requestType = req.query?.request_type ? String(req.query.request_type) : null;
      if (!requestType || !["conveyance", "leave", "timesheet"].includes(requestType)) {
        return res.status(400).json({ error: "?request_type= is required (conveyance, leave, or timesheet)." });
      }
      const users = await queryDB("SELECT id, name, email, username, role FROM users ORDER BY name ASC");
      const assignments = await queryDB(
        `SELECT eta.employee_user_id, eta.template_id, t.name AS template_name
         FROM employee_template_assignments eta
         JOIN approval_templates t ON t.id = eta.template_id
         WHERE eta.request_type = ?`,
        [requestType]
      );
      const assignmentByUser = new Map<number, any>(assignments.map((a: any) => [Number(a.employee_user_id), a]));
      const defaultRows = await queryDB("SELECT id, name FROM approval_templates WHERE request_type = ? AND is_default = 1 LIMIT 1", [requestType]);
      const defaultTemplate = defaultRows[0] || null;

      res.json({
        default_template: defaultTemplate,
        employees: users.map((u: any) => {
          const a = assignmentByUser.get(Number(u.id));
          return {
            employee_user_id: u.id,
            employee_name: u.name,
            employee_role: u.role,
            assigned_template_id: a ? a.template_id : null,
            assigned_template_name: a ? a.template_name : null,
            effective_template_id: a ? a.template_id : defaultTemplate?.id || null,
            effective_template_name: a ? a.template_name : defaultTemplate?.name || null,
            uses_default: !a
          };
        })
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sets (or clears, with template_id: null) one employee's explicit template
  // pick for one request_type. Clearing just deletes the row — that employee
  // falls back to the request_type's default from then on.
  app.put("/api/template-assignments", authenticateToken, requireAdmin, requireModule("approvals"), async (req: any, res) => {
    try {
      const employeeUserId = Number(req.body?.employee_user_id);
      const requestType = req.body?.request_type;
      const templateId = req.body?.template_id === null || req.body?.template_id === undefined ? null : Number(req.body.template_id);
      if (!Number.isFinite(employeeUserId)) return res.status(400).json({ error: "employee_user_id is required." });
      if (!["conveyance", "leave", "timesheet"].includes(requestType)) {
        return res.status(400).json({ error: "request_type must be one of conveyance, leave, timesheet." });
      }
      const userRows = await queryDB("SELECT id FROM users WHERE id = ?", [employeeUserId]);
      if (userRows.length === 0) return res.status(404).json({ error: "Employee account not found." });

      if (templateId === null) {
        await queryDB("DELETE FROM employee_template_assignments WHERE employee_user_id = ? AND request_type = ?", [employeeUserId, requestType]);
        return res.json({ success: true, cleared: true });
      }

      const templateRows = await queryDB("SELECT * FROM approval_templates WHERE id = ?", [templateId]);
      if (templateRows.length === 0) return res.status(404).json({ error: "Template not found." });
      if (templateRows[0].request_type !== requestType) {
        return res.status(400).json({ error: "That template is for a different Request Type." });
      }
      if (!Number(templateRows[0].is_active)) {
        return res.status(400).json({ error: "That template is inactive — activate it first, or pick a different one." });
      }

      await queryDB(
        `INSERT INTO employee_template_assignments (employee_user_id, request_type, template_id, assigned_by)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE template_id = VALUES(template_id), assigned_by = VALUES(assigned_by)`,
        [employeeUserId, requestType, templateId, req.user.id]
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}