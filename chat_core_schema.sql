-- =====================================================================
-- Phase 1 — Database Architecture Setup
-- WhatsApp-style Messaging: One-to-One, Group & Community
-- Engine: MySQL 8.0+ (InnoDB, utf8mb4 — required for emoji in messages)
-- =====================================================================
-- Design notes (read before Phase 2 / Phase 3):
--
-- 1. `id` on chats/messages is a client-generatable UUID (CHAR(36)), not
--    AUTO_INCREMENT — the frontend already builds an optimistic message
--    with its own id before the server round-trip completes (see the
--    React sendMessage() in the earlier draft), so the id has to be
--    knowable client-side up front. chat_participants/message_status
--    are pure link/tracking rows with no client-side identity need, so
--    they stay BIGINT AUTO_INCREMENT (smaller, faster joins/indexes).
--
-- 2. Community <-> Group relationship: modeled as a single nullable
--    self-referential `community_id` column on `chats` (a group can
--    belong to at most one community — same as real WhatsApp), instead
--    of a separate community_subgroups join table. One column, one
--    index, no extra join for "give me every group in this community".
--
-- 3. `user_id` columns are plain BIGINT UNSIGNED with NO foreign key to
--    a `users` table — this schema is written standalone, since the
--    host app's actual users table name/engine wasn't specified here.
--    Wire up `FOREIGN KEY (user_id) REFERENCES users(id)` once you tell
--    me the real table name, or drop this note if you're keeping it
--    decoupled (e.g. users live in a separate service).
--
-- 4. Scalability flag for `message_status`: it stores one row per
--    (message, recipient) — fine for direct chats (1 row/message) and
--    small/medium groups, but a 500-member community sending 10,000
--    messages is 5,000,000 status rows. Two mitigations already built
--    in: (a) `chat_participants.last_read_message_id` gives an O(1)
--    "unread count since X" without touching message_status at all —
--    use THAT for badge counts / list previews; reserve message_status
--    reads for when you actually render the per-message double-tick
--    inside an open direct/small-group chat. (b) partition or archive
--    old message_status rows once a message is outside the "recent"
--    window, if community chat volume grows — not done here, flagging
--    for when real volume numbers exist.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) chats — every Direct / Group / Community is one row here.
-- ---------------------------------------------------------------------
CREATE TABLE chats (
  id                CHAR(36)      NOT NULL,                         -- UUID, client-generated
  type              ENUM('direct', 'group', 'community') NOT NULL,
  title             VARCHAR(150)  NULL,                             -- NULL for 'direct' (shown as the other participant's name)
  description       TEXT          NULL,                             -- group/community "About" text
  avatar_url        VARCHAR(500)  NULL,
  community_id      CHAR(36)      NULL,                             -- set only when type='group' AND it belongs to a community
  created_by        BIGINT UNSIGNED NOT NULL,
  is_archived       TINYINT(1)    NOT NULL DEFAULT 0,
  created_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  KEY idx_chats_community_id (community_id),
  KEY idx_chats_type (type),
  KEY idx_chats_created_by (created_by),

  CONSTRAINT fk_chats_community
    FOREIGN KEY (community_id) REFERENCES chats(id) ON DELETE SET NULL,

  -- Only a 'group' may point at a community; a 'direct' or 'community'
  -- row itself never has a parent. (MySQL 8.0.16+ enforces CHECK.)
  CONSTRAINT chk_chats_community_only_on_group
    CHECK (community_id IS NULL OR type = 'group')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 2) chat_participants — who's in which chat, what role, what they've
--    read so far.
-- ---------------------------------------------------------------------
CREATE TABLE chat_participants (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  chat_id               CHAR(36)        NOT NULL,
  user_id               BIGINT UNSIGNED NOT NULL,
  role                  ENUM('super_admin', 'admin', 'member') NOT NULL DEFAULT 'member',
  -- O(1) unread-count source for chat list badges — see design note 4
  -- above. Updated whenever this user reads the chat (last message
  -- they've seen), independent of the heavier message_status table.
  last_read_message_id CHAR(36)        NULL,
  is_muted              TINYINT(1)      NOT NULL DEFAULT 0,
  joined_at             TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- NULL while still a member; set the moment they leave/are removed —
  -- kept (not deleted) so past messages can still show "X left the
  -- group" and old read-receipts stay attributable.
  left_at                TIMESTAMP      NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_chat_participants_chat_user (chat_id, user_id),
  KEY idx_chat_participants_user_id (user_id),
  KEY idx_chat_participants_last_read (chat_id, last_read_message_id),

  CONSTRAINT fk_chat_participants_chat
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 3) messages — every text/image/file/audio/system message in every
--    chat.
-- ---------------------------------------------------------------------
CREATE TABLE messages (
  id             CHAR(36)      NOT NULL,                            -- UUID, client-generated (optimistic send)
  chat_id        CHAR(36)      NOT NULL,
  sender_id      BIGINT UNSIGNED NOT NULL,
  message_type   ENUM('text', 'image', 'video', 'audio', 'file', 'location', 'system')
                 NOT NULL DEFAULT 'text',
  -- Caption/body for text & media messages; for 'system' messages this
  -- holds the rendered line itself (e.g. "Rahim added Karim").
  content        TEXT          NULL,
  -- Actual uploaded file's URL (S3/Cloudinary/local) — kept separate
  -- from `content` so a media message can carry a real URL *and* a
  -- caption at the same time.
  media_url      VARCHAR(500)  NULL,
  -- Free-form metadata for the media: { "mime": "...", "size": 1234,
  -- "width": 1080, "height": 1920, "duration_sec": 12 } — whatever the
  -- upload endpoint knows, so the UI can render a placeholder/duration
  -- before the file itself loads.
  media_meta     JSON          NULL,
  reply_to_id    CHAR(36)      NULL,
  is_edited      TINYINT(1)    NOT NULL DEFAULT 0,
  is_deleted     TINYINT(1)    NOT NULL DEFAULT 0,                  -- soft delete -> UI renders "This message was deleted"
  deleted_at     TIMESTAMP     NULL,
  created_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  -- The single most important index in this whole schema: every chat
  -- screen opens by paginating "messages in this chat, newest first".
  KEY idx_messages_chat_created (chat_id, created_at),
  KEY idx_messages_sender_id (sender_id),
  KEY idx_messages_reply_to (reply_to_id),

  CONSTRAINT fk_messages_chat
    FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  CONSTRAINT fk_messages_reply_to
    FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ---------------------------------------------------------------------
-- 4) message_status — per-recipient sent/delivered/read tracking
--    (the single/double/blue-tick source of truth).
-- ---------------------------------------------------------------------
CREATE TABLE message_status (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  message_id   CHAR(36)        NOT NULL,
  user_id      BIGINT UNSIGNED NOT NULL,                            -- the recipient this row is tracking
  status       ENUM('sent', 'delivered', 'read') NOT NULL DEFAULT 'sent',
  updated_at   TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_message_status_message_user (message_id, user_id),  -- one status row per recipient per message
  -- Powers "give me everything still unread/undelivered for this user"
  -- on reconnect/app-open, without scanning every message row.
  KEY idx_message_status_user_status (user_id, status),

  CONSTRAINT fk_message_status_message
    FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
