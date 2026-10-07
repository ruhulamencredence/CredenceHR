/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Notices routes (Admin Panel -> Notices, plus the popup/board the User sees), moved out of server.ts unchanged.
// The shared helpers they use are passed in by startServer().

import type { Express } from "express";

export interface RegisterNoticeRoutesDeps {
  announceNotice: any;
  authenticateToken: any;
  queryDB: any;
  requireAdmin: any;
  requireModule: any;
}

export function registerNoticeRoutes(app: Express, deps: RegisterNoticeRoutesDeps) {
  const { announceNotice, authenticateToken, queryDB, requireAdmin, requireModule } = deps;
  // 2d. Notices — Superadmin/Admin composes a popup (title + text/HTML + an
  // optional custom Lottie animation) that shows to a User right after they log
  // in. Gated behind the "notices" Admin Panel module, same as every other tab.
  const parseJsonBody = <T,>(value: any): T | null => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "object") return value as T;
    try {
      return JSON.parse(String(value));
    } catch {
      return null;
    }
  };

  // Minimal recipient list for the "Specific Users" target picker — every plain
  // 'user' account (not Admins/Superadmins, who never see the popup). Deliberately
  // its own lightweight route rather than reusing GET /api/users, so an Admin who
  // only has the "notices" module (not "users") can still pick recipients.
  app.get("/api/notices/recipients", authenticateToken, requireAdmin, requireModule("notices"), async (req, res) => {
    try {
      const rows = await queryDB("SELECT * FROM users");
      res.json(
        rows
          .filter((u: any) => u.role === "user")
          .map((u: any) => ({ id: u.id, name: u.name, email: u.email || null, username: u.username || null }))
          .sort((a: any, b: any) => a.name.localeCompare(b.name))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every Notice an Admin/Superadmin has created, newest first, with its target
  // users (for 'specific' ones) and who created it — for the Admin Panel -> Notices
  // management list.
  app.get("/api/notices", authenticateToken, requireAdmin, requireModule("notices"), async (req, res) => {
    try {
      const notices = await queryDB("SELECT * FROM notices");
      const targets = await queryDB("SELECT * FROM notice_targets");
      const users = await queryDB("SELECT id, name, role FROM users");
      const userMap = new Map<number, any>(users.map((u: any) => [u.id, u]));
      // Who has seen each notice — closing the login popup records a
      // dismissal, so "seen" is the audience members with one. The audience
      // is every account except its author for an 'all' notice (the popup
      // goes to Admins too), or the picked users for 'specific'.
      const dismissals = await queryDB("SELECT * FROM notice_dismissals");
      const allUserIds = users.map((u: any) => Number(u.id));

      const sorted = [...notices].sort((a: any, b: any) => (a.id < b.id ? 1 : -1));
      res.json(
        sorted.map((n: any) => {
          const targetUserIds = targets.filter((t: any) => t.notice_id === n.id).map((t: any) => t.user_id);
          const audience = new Set<number>(
            n.target_type === "all" ? allUserIds.filter((id: number) => id !== Number(n.created_by)) : targetUserIds.map((id: any) => Number(id))
          );
          const seenIds = new Set<number>(
            dismissals
              .filter((d: any) => Number(d.notice_id) === Number(n.id) && audience.has(Number(d.user_id)))
              .map((d: any) => Number(d.user_id))
          );
          return {
            id: n.id,
            title: n.title,
            content_html: n.content_html,
            lottie_json: n.lottie_json || null,
            lottie_url: n.lottie_url || null,
            target_type: n.target_type,
            source: n.source || null,
            is_active: !!Number(n.is_active),
            created_by: n.created_by,
            created_by_name: userMap.get(n.created_by)?.name || null,
            created_at: n.created_at,
            updated_at: n.updated_at,
            target_user_ids: targetUserIds,
            target_users: targetUserIds.map((id: number) => ({ id, name: userMap.get(id)?.name || "Unknown" })),
            audience_count: audience.size,
            seen_count: seenIds.size,
            seen_by: Array.from(seenIds).map((id) => userMap.get(id)?.name || "Unknown").sort()
          };
        })
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/notices", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const { title, content_html, lottie_json, lottie_url, target_type, target_user_ids, is_active } = req.body;
      if (!title || !String(title).trim()) return res.status(400).json({ error: "Title is required" });
      if (!content_html || !String(content_html).trim()) return res.status(400).json({ error: "Notice content is required" });
      const resolvedTargetType = target_type === "specific" ? "specific" : "all";
      // A pasted Lottie animation must be valid JSON, or it silently fails to
      // render for the User later — validated (and re-stringified) here rather
      // than trusted straight from the client.
      let lottieJsonStr: string | null = null;
      if (lottie_json && String(lottie_json).trim()) {
        const parsed = parseJsonBody(lottie_json);
        if (!parsed) return res.status(400).json({ error: "The pasted Lottie animation isn't valid JSON." });
        lottieJsonStr = JSON.stringify(parsed);
      }
      const lottieUrlStr = lottie_url && String(lottie_url).trim() ? String(lottie_url).trim() : null;

      const result = await queryDB(
        "INSERT INTO notices (title, content_html, lottie_json, lottie_url, target_type, is_active, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [String(title).trim(), String(content_html), lottieJsonStr, lottieUrlStr, resolvedTargetType, is_active === false ? 0 : 1, req.user.id]
      );
      const noticeId = result.insertId;

      if (resolvedTargetType === "specific" && Array.isArray(target_user_ids)) {
        for (const uid of target_user_ids) {
          const userIdNum = Number(uid);
          if (Number.isFinite(userIdNum)) {
            await queryDB("INSERT INTO notice_targets (notice_id, user_id) VALUES (?, ?)", [noticeId, userIdNum]);
          }
        }
      }

      if (is_active !== false) {
        const audience = resolvedTargetType === "specific" ? (Array.isArray(target_user_ids) ? target_user_ids.map(Number).filter(Number.isFinite) : []) : "all";
        void announceNotice(noticeId, String(title).trim(), audience, req.user.id);
      }
      res.status(201).json({ id: noticeId });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put("/api/notices/:id", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM notices WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Notice not found" });

      const { title, content_html, lottie_json, lottie_url, target_type, target_user_ids } = req.body;
      if (!title || !String(title).trim()) return res.status(400).json({ error: "Title is required" });
      if (!content_html || !String(content_html).trim()) return res.status(400).json({ error: "Notice content is required" });
      const resolvedTargetType = target_type === "specific" ? "specific" : "all";
      let lottieJsonStr: string | null = null;
      if (lottie_json && String(lottie_json).trim()) {
        const parsed = parseJsonBody(lottie_json);
        if (!parsed) return res.status(400).json({ error: "The pasted Lottie animation isn't valid JSON." });
        lottieJsonStr = JSON.stringify(parsed);
      }
      const lottieUrlStr = lottie_url && String(lottie_url).trim() ? String(lottie_url).trim() : null;

      await queryDB(
        "UPDATE notices SET title = ?, content_html = ?, lottie_json = ?, lottie_url = ?, target_type = ? WHERE id = ?",
        [String(title).trim(), String(content_html), lottieJsonStr, lottieUrlStr, resolvedTargetType, id]
      );

      // Replace the target list wholesale rather than diffing — simplest correct
      // behaviour for a form that always submits the full intended audience.
      await queryDB("DELETE FROM notice_targets WHERE notice_id = ?", [id]);
      if (resolvedTargetType === "specific" && Array.isArray(target_user_ids)) {
        for (const uid of target_user_ids) {
          const userIdNum = Number(uid);
          if (Number.isFinite(userIdNum)) {
            await queryDB("INSERT INTO notice_targets (notice_id, user_id) VALUES (?, ?)", [id, userIdNum]);
          }
        }
      }

      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Publish/unpublish toggle — pulls a Notice's popup down (or brings it back)
  // without losing it or its dismissal history, unlike deleting it outright.
  app.put("/api/notices/:id/active", authenticateToken, requireAdmin, requireModule("notices"), async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM notices WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Notice not found" });
      await queryDB("UPDATE notices SET is_active = ? WHERE id = ?", [req.body.is_active ? 1 : 0, id]);
      // Published again: show it live and push it, like a new one.
      if (req.body.is_active && !Number(existing[0].is_active)) {
        const targets: any[] = existing[0].target_type === "specific" ? (await queryDB("SELECT user_id FROM notice_targets WHERE notice_id = ?", [id])) || [] : [];
        void announceNotice(id, existing[0].title, existing[0].target_type === "specific" ? targets.map((t) => Number(t.user_id)) : "all", req.user.id);
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/notices/:id", authenticateToken, requireAdmin, requireModule("notices"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      const existing = await queryDB("SELECT * FROM notices WHERE id = ?", [id]);
      if (existing.length === 0) return res.status(404).json({ error: "Notice not found" });
      await queryDB("DELETE FROM notices WHERE id = ?", [id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Active, targeted, not-yet-dismissed Notices for the CALLING user — polled by
  // the User Panel right after login to decide whether to pop the Notice modal up.
  // Oldest-first, so a User who has several queued sees them in the order they were
  // published rather than newest-first.
  app.get("/api/notices/active", authenticateToken, async (req: any, res) => {
    try {
      const notices = await queryDB("SELECT * FROM notices");
      const active = notices.filter((n: any) => !!Number(n.is_active));
      if (active.length === 0) return res.json([]);

      const dismissals = await queryDB("SELECT * FROM notice_dismissals WHERE user_id = ?", [req.user.id]);
      const dismissedIds = new Set(dismissals.map((d: any) => Number(d.notice_id)));

      const targets = await queryDB("SELECT * FROM notice_targets");

      const visible = active.filter((n: any) => {
        if (dismissedIds.has(Number(n.id))) return false;
        // The author doesn't need their own notice popped up at them.
        if (Number(n.created_by) === Number(req.user.id)) return false;
        if (n.target_type === "all") return true;
        return targets.some((t: any) => Number(t.notice_id) === Number(n.id) && Number(t.user_id) === Number(req.user.id));
      });

      visible.sort((a: any, b: any) => (a.id > b.id ? 1 : -1));

      res.json(
        visible.map((n: any) => ({
          id: n.id,
          title: n.title,
          content_html: n.content_html,
          lottie_json: n.lottie_json || null,
          lottie_url: n.lottie_url || null,
          source: n.source || null,
          created_at: n.created_at
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Every Notice currently posted for this account — same active + targeting
  // rules as /api/notices/active above, but WITHOUT its dismissal filter, and
  // newest first.
  //
  // Dismissing is meant to stop the login popup from putting a notice in front
  // of someone again, not to erase it: NoticeBoard.tsx has always described
  // itself as "somewhere to come back and re-read a notice later", but it
  // couldn't be while it read the popup's endpoint — one dismissal and the
  // notice was gone from the board too, with nothing left anywhere in the app
  // to say it had ever been posted. This is the endpoint the Notice Board and
  // the Dashboard's notice preview read instead.
  app.get("/api/notices/board", authenticateToken, async (req: any, res) => {
    try {
      const notices = await queryDB("SELECT * FROM notices");
      const active = notices.filter((n: any) => !!Number(n.is_active));
      if (active.length === 0) return res.json([]);

      const targets = await queryDB("SELECT * FROM notice_targets");
      const visible = active.filter((n: any) => {
        if (n.target_type === "all") return true;
        return targets.some((t: any) => Number(t.notice_id) === Number(n.id) && Number(t.user_id) === Number(req.user.id));
      });

      visible.sort((a: any, b: any) => Number(b.id) - Number(a.id));

      res.json(
        visible.map((n: any) => ({
          id: n.id,
          title: n.title,
          content_html: n.content_html,
          lottie_json: n.lottie_json || null,
          lottie_url: n.lottie_url || null,
          created_at: n.created_at
        }))
      );
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Marks one Notice as seen/closed for the calling user — it stops appearing for
  // them (but keeps showing to anyone else it's targeted at who hasn't dismissed it).
  app.post("/api/notices/:id/dismiss", authenticateToken, async (req: any, res) => {
    try {
      const id = Number(req.params.id);
      await queryDB("INSERT INTO notice_dismissals (notice_id, user_id) VALUES (?, ?)", [id, req.user.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
}
