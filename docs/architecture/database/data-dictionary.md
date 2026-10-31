# Data Dictionary — CredenceHR ডাটাবেস (সব টেবিল ও কলাম)

> স্বয়ংক্রিয়ভাবে তৈরি: চালু সার্ভারের `information_schema` থেকে (MariaDB, ২২১টি টেবিল, ২৩৭৮টি কলাম)।
> `PK` = প্রাইমারি কী, `FK` = ঘোষিত foreign key (→ কোন টেবিল), `logical` = foreign key ঘোষণা নেই কিন্তু নাম দেখে যে টেবিলের সাথে সম্পর্ক বোঝা যায়।

## K. Communication: Notices, Chat, Mail, Assistant, Feedback

Notice, Chat (রুম, মেসেজ, reaction, pin), Credence Mail (মেইল, ফোল্ডার, গ্রুপ, ফিল্টার), Assistant, Feedback।

### `app_feedback`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `rating` | tinyint(4) | হ্যাঁ |  | |
| `kind` | varchar(10) | না | default 'general' | |
| `module` | varchar(80) | হ্যাঁ |  | |
| `message` | text | হ্যাঁ |  | |
| `screenshot_mimetype` | varchar(60) | হ্যাঁ |  | |
| `screenshot_data` | mediumblob | হ্যাঁ |  | |
| `page` | varchar(255) | হ্যাঁ |  | |
| `device` | varchar(20) | হ্যাঁ |  | |
| `client` | varchar(10) | হ্যাঁ |  | |
| `app_version` | varchar(40) | হ্যাঁ |  | |
| `user_agent` | varchar(255) | হ্যাঁ |  | |
| `source` | varchar(10) | না | default 'button' | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `assistant_learned`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `question` | varchar(300) | না | UNI  | |
| `tool` | varchar(64) | হ্যাঁ |  | |
| `help_id` | varchar(64) | হ্যাঁ |  | |
| `args` | varchar(255) | হ্যাঁ |  | |
| `hits` | int(11) | না | default 1 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uq_assistant_learned_q`(question)

### `assistant_support_messages`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `session_id` | int(11) | না |  | |
| `sender_id` | int(11) | হ্যাঁ |  | |
| `kind` | varchar(12) | না | default 'user' | |
| `body` | text | না |  | |
| `created_at` | datetime | হ্যাঁ | default current_timestamp() | |

### `assistant_support_sessions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `group_id` | int(11) | না | default 1 | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `user_id` | int(11) | না |  | logical → `users` |
| `agent_id` | int(11) | হ্যাঁ |  | |
| `status` | varchar(16) | না | default 'waiting' | |
| `topic` | varchar(300) | হ্যাঁ |  | |
| `created_at` | datetime | হ্যাঁ | default current_timestamp() | |
| `accepted_at` | datetime | হ্যাঁ |  | |
| `closed_at` | datetime | হ্যাঁ |  | |
| `closed_by` | int(11) | হ্যাঁ |  | |
| `last_message_at` | datetime | হ্যাঁ | default current_timestamp() | |

### `chat_message_hidden`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `message_id` | int(11) | না | PK  | FK → `chat_messages.id` |
| `user_id` | int(11) | না | PK  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `chat_message_reactions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `message_id` | int(11) | না | PK  | FK → `chat_messages.id` |
| `user_id` | int(11) | না | PK  | FK → `users.id` |
| `emoji` | varchar(16) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `chat_messages`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `room_id` | int(11) | না |  | FK → `chat_rooms.id` |
| `sender_id` | int(11) | না |  | FK → `users.id` |
| `message_type` | enum('text','image','file','audio') | না | default 'text' | |
| `content` | text | হ্যাঁ |  | |
| `attachment_filename` | varchar(255) | হ্যাঁ |  | |
| `attachment_mimetype` | varchar(150) | হ্যাঁ |  | |
| `attachment_data` | longblob | হ্যাঁ |  | |
| `reply_to_id` | int(11) | হ্যাঁ |  | FK → `chat_messages.id` |
| `deleted_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `unsent_at` | timestamp | হ্যাঁ |  | |
| `unsent_by` | int(11) | হ্যাঁ |  | |
| `edited_at` | timestamp | হ্যাঁ |  | |
| `is_forwarded` | tinyint(1) | না | default 0 | |

### `chat_pinned_messages`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `message_id` | int(11) | না | PK  | FK → `chat_messages.id` |
| `room_id` | int(11) | না |  | FK → `chat_rooms.id` |
| `pinned_by` | int(11) | হ্যাঁ |  | |
| `pinned_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `expires_at` | timestamp | হ্যাঁ |  | |

### `chat_push_tokens`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `token` | varchar(255) | না | UNI  | |
| `platform` | varchar(20) | না | default 'android' | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `token`(token)

### `chat_room_members`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `room_id` | int(11) | না |  | FK → `chat_rooms.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `role` | enum('admin','member') | না | default 'member' | |
| `joined_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uniq_chat_room_member`(room_id,user_id)

### `chat_room_reads`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `room_id` | int(11) | না | PK  | FK → `chat_rooms.id` |
| `user_id` | int(11) | না | PK  | FK → `users.id` |
| `last_read_message_id` | int(11) | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `chat_rooms`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `type` | enum('direct','group','community') | না |  | |
| `title` | varchar(150) | হ্যাঁ |  | |
| `parent_room_id` | int(11) | হ্যাঁ |  | FK → `chat_rooms.id` |
| `avatar_mimetype` | varchar(150) | হ্যাঁ |  | |
| `avatar_data` | longblob | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |

### `chat_wallpapers`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `user_id` | int(11) | না | PK  | FK → `users.id` |
| `room_id` | int(11) | না | PK  | logical → `chat_rooms` |
| `wallpaper` | varchar(32) | না |  | |

### `feedback_prompts`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `user_id` | int(11) | না | PK  | FK → `users.id` |
| `first_seen_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `next_ask_at` | timestamp | হ্যাঁ |  | |
| `never_ask` | tinyint(1) | না | default 0 | |

### `feedback_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK  | |
| `prompt_enabled` | tinyint(1) | না | default 1 | |
| `prompt_after_days` | int(11) | না | default 7 | |

### `mail_accounts`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `email` | varchar(255) | না |  | |
| `display_name` | varchar(255) | হ্যাঁ |  | |
| `provider` | varchar(40) | না | default 'custom' | |
| `imap_host` | varchar(255) | না |  | |
| `imap_port` | int(11) | না | default 993 | |
| `imap_secure` | tinyint(1) | না | default 1 | |
| `smtp_host` | varchar(255) | না |  | |
| `smtp_port` | int(11) | না | default 465 | |
| `smtp_secure` | tinyint(1) | না | default 1 | |
| `username` | varchar(255) | না |  | |
| `password_enc` | text | না |  | |
| `tls_insecure` | tinyint(1) | না | default 0 | |
| `folders_json` | text | হ্যাঁ |  | |
| `is_default` | tinyint(1) | না | default 0 | |
| `last_sync_at` | datetime | হ্যাঁ |  | |
| `last_error` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `employee_id` | int(11) | হ্যাঁ |  | logical → `all_employees` |

Unique: `uq_mail_account`(user_id,email)

### `mail_admin_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | bigint(20) | না | PK auto_increment | |
| `actor_user_id` | int(11) | না |  | |
| `target_user_id` | int(11) | না |  | |
| `account_id` | int(11) | হ্যাঁ |  | |
| `action` | varchar(20) | না |  | |
| `ip` | varchar(64) | হ্যাঁ |  | |
| `created_at` | datetime | না |  | |

### `mail_blobs`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | bigint(20) | না | PK auto_increment | |
| `sha256` | char(64) | না | UNI  | |
| `size` | int(11) | না | default 0 | |
| `data` | longblob | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uq_mail_blob_sha`(sha256)

### `mail_contacts`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `name` | varchar(255) | না |  | |
| `email` | varchar(255) | না |  | |
| `phone` | varchar(80) | হ্যাঁ |  | |
| `company` | varchar(255) | হ্যাঁ |  | |
| `notes` | text | হ্যাঁ |  | |
| `avatar_color` | varchar(50) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `mail_events`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `title` | varchar(500) | না |  | |
| `start_at` | varchar(40) | না |  | |
| `end_at` | varchar(40) | না |  | |
| `description` | text | হ্যাঁ |  | |
| `location` | varchar(255) | হ্যাঁ |  | |
| `email_id` | bigint(20) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `mail_files`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | bigint(20) | না | PK auto_increment | |
| `message_id` | bigint(20) | না |  | |
| `idx` | int(11) | না |  | |
| `name` | varchar(255) | না |  | |
| `mime` | varchar(150) | হ্যাঁ |  | |
| `size` | int(11) | না | default 0 | |
| `data` | longblob | হ্যাঁ |  | |
| `blob_id` | bigint(20) | হ্যাঁ |  | |

### `mail_filters`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `name` | varchar(255) | না |  | |
| `conditions_json` | text | না |  | |
| `actions_json` | text | না |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `mail_folder_state`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `account_id` | int(11) | না | PK  | |
| `role` | varchar(20) | না | PK  | |
| `path` | varchar(255) | না |  | |
| `uidvalidity` | bigint(20) | না | default 0 | |
| `last_uid` | bigint(20) | না | default 0 | |

### `mail_groups`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `email` | varchar(255) | না | UNI  | |
| `name` | varchar(255) | না |  | |
| `description` | varchar(1000) | হ্যাঁ |  | |
| `members_json` | mediumtext | হ্যাঁ |  | |
| `all_employees` | tinyint(1) | না | default 0 | |
| `departments_json` | text | হ্যাঁ |  | |
| `send_policy` | varchar(16) | না | default 'members' | |
| `senders_json` | text | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uq_mail_group_email`(email)

### `mail_messages`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | bigint(20) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `account_id` | int(11) | না |  | |
| `folder_role` | varchar(20) | হ্যাঁ |  | |
| `uid` | bigint(20) | হ্যাঁ |  | |
| `message_id` | varchar(500) | হ্যাঁ |  | |
| `in_reply_to` | varchar(500) | হ্যাঁ |  | |
| `refs` | text | হ্যাঁ |  | |
| `thread_id` | varchar(64) | না |  | |
| `from_name` | varchar(255) | হ্যাঁ |  | |
| `from_email` | varchar(255) | হ্যাঁ |  | |
| `to_json` | text | হ্যাঁ |  | |
| `cc_json` | text | হ্যাঁ |  | |
| `bcc_json` | text | হ্যাঁ |  | |
| `subject` | text | হ্যাঁ |  | |
| `body` | mediumtext | হ্যাঁ |  | |
| `snippet` | varchar(300) | হ্যাঁ |  | |
| `mail_date` | datetime | না |  | |
| `is_read` | tinyint(1) | না | default 0 | |
| `is_starred` | tinyint(1) | না | default 0 | |
| `is_important` | tinyint(1) | না | default 0 | |
| `labels_json` | text | হ্যাঁ |  | |
| `category` | varchar(30) | না | default 'primary' | |
| `attachments_json` | text | হ্যাঁ |  | |
| `has_attachments` | tinyint(1) | না | default 0 | |
| `scheduled_at` | datetime | হ্যাঁ |  | |
| `send_error` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `via_internal` | tinyint(1) | না | default 0 | |

Unique: `uq_mail_uid`(account_id,folder_role,uid)

### `mail_personal_groups`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `name` | varchar(255) | না |  | |
| `members_json` | mediumtext | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `mail_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `user_id` | int(11) | না | PK  | logical → `users` |
| `signatures_json` | mediumtext | হ্যাঁ |  | |
| `vacation_json` | text | হ্যাঁ |  | |
| `blocked_json` | text | হ্যাঁ |  | |
| `layout_json` | text | হ্যাঁ |  | |
| `language` | varchar(50) | হ্যাঁ |  | |
| `timezone` | varchar(80) | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `picture_senders_json` | text | হ্যাঁ |  | |

### `mail_signature_images`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `token` | char(32) | না |  | |
| `mime` | varchar(80) | না |  | |
| `data` | mediumblob | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `mail_system_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK  | |
| `internal_delivery` | tinyint(1) | না | default 1 | |
| `internal_domains` | varchar(1000) | না | default 'credencehousinglimited.com' | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `mail_tasks`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `title` | varchar(500) | না |  | |
| `due_date` | varchar(40) | হ্যাঁ |  | |
| `completed` | tinyint(1) | না | default 0 | |
| `email_id` | bigint(20) | হ্যাঁ |  | |
| `email_subject` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `mail_templates`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `title` | varchar(255) | না |  | |
| `subject` | varchar(500) | হ্যাঁ |  | |
| `body` | mediumtext | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `mail_vacation_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `account_id` | int(11) | না | PK  | |
| `sender` | varchar(255) | না | PK  | |
| `sent_at` | datetime | না |  | |

### `notice_dismissals`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `notice_id` | int(11) | না |  | FK → `notices.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `dismissed_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_notice_user_dismiss`(notice_id,user_id)

### `notice_targets`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `notice_id` | int(11) | না |  | FK → `notices.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |

Unique: `unique_notice_user`(notice_id,user_id)

### `notices`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `title` | varchar(200) | না |  | |
| `content_html` | mediumtext | না |  | |
| `lottie_json` | mediumtext | হ্যাঁ |  | |
| `lottie_url` | varchar(500) | হ্যাঁ |  | |
| `target_type` | enum('all','specific') | না | default 'all' | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `source` | varchar(30) | হ্যাঁ |  | |
| `source_ref` | varchar(64) | হ্যাঁ |  | |

### `report_email_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | হ্যাঁ |  | কোম্পানি-মালিকানা (code-level scope) |
| `sent_by` | int(11) | হ্যাঁ |  | |
| `report_title` | varchar(255) | না |  | |
| `file_name` | varchar(255) | না |  | |
| `recipients_json` | text | না |  | |
| `failed_json` | text | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `ride_saved_places`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `kind` | varchar(10) | না | default 'other' | |
| `name` | varchar(120) | না |  | |
| `address` | varchar(255) | হ্যাঁ |  | |
| `lat` | decimal(10,7) | না |  | |
| `lng` | decimal(10,7) | না |  | |
| `driver_note` | varchar(255) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

## H. HR Operations, Onboarding & Recruitment

HR action (পদোন্নতি, বদলি, increment…), চিঠি ও টেমপ্লেট, onboarding, নিয়োগ (job posting, প্রার্থী, ইন্টারভিউ), রিপোর্ট ও রিমাইন্ডার।

### `candidate_emails`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `candidate_id` | int(11) | না |  | FK → `job_candidates.id` |
| `interview_id` | int(11) | হ্যাঁ |  | |
| `kind` | varchar(30) | না |  | |
| `to_email` | varchar(255) | না |  | |
| `subject` | varchar(255) | না |  | |
| `body` | text | না |  | |
| `status` | varchar(10) | না |  | |
| `error` | varchar(500) | হ্যাঁ |  | |
| `covers_event_id` | int(11) | হ্যাঁ |  | |
| `sent_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `candidate_interview_events`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `interview_id` | int(11) | না |  | FK → `candidate_interviews.id` |
| `candidate_id` | int(11) | না |  | logical → `job_candidates` |
| `action` | varchar(20) | না |  | |
| `old_scheduled_at` | datetime | হ্যাঁ |  | |
| `new_scheduled_at` | datetime | হ্যাঁ |  | |
| `old_place` | varchar(600) | হ্যাঁ |  | |
| `new_place` | varchar(600) | হ্যাঁ |  | |
| `reason` | varchar(500) | হ্যাঁ |  | |
| `done_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `candidate_interviews`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `candidate_id` | int(11) | না |  | FK → `job_candidates.id` |
| `scheduled_at` | datetime | হ্যাঁ |  | |
| `interviewer_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `feedback` | text | হ্যাঁ |  | |
| `rating` | decimal(3,1) | হ্যাঁ |  | |
| `status` | enum('scheduled','completed','cancelled') | না | default 'scheduled' | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `mode` | varchar(20) | হ্যাঁ |  | |
| `venue` | varchar(500) | হ্যাঁ |  | |
| `meeting_link` | varchar(500) | হ্যাঁ |  | |
| `duration_minutes` | int(11) | হ্যাঁ |  | |
| `candidate_note` | text | হ্যাঁ |  | |

### `employee_requisitions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `user_id` | int(11) | না |  | logical → `users` |
| `employee_id` | int(11) | হ্যাঁ |  | logical → `all_employees` |
| `application_id` | int(11) | হ্যাঁ |  | |
| `kind` | varchar(20) | না |  | |
| `status` | varchar(20) | না | default 'requested' | |
| `reason` | varchar(30) | না | default 'new' | |
| `note` | varchar(1000) | হ্যাঁ |  | |
| `operator` | varchar(30) | হ্যাঁ |  | |
| `name_on_card` | varchar(150) | হ্যাঁ |  | |
| `blood_group` | varchar(10) | হ্যাঁ |  | |
| `sim_id` | int(11) | হ্যাঁ |  | logical → `mobile_sims` |
| `card_number` | varchar(60) | হ্যাঁ |  | |
| `decided_by` | int(11) | হ্যাঁ |  | |
| `decided_at` | datetime | হ্যাঁ |  | |
| `decision_note` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `hr_action_approval_steps`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `action_type` | varchar(40) | না |  | |
| `step_order` | int(11) | না |  | |
| `label` | varchar(100) | হ্যাঁ |  | |
| `approver_user_ids` | text | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `hr_actions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `action_type` | varchar(40) | না |  | |
| `effective_date` | date | না |  | |
| `status` | varchar(20) | না | default 'pending' | |
| `applied` | tinyint(1) | না | default 0 | |
| `current_step` | int(11) | না | default 1 | |
| `total_steps` | int(11) | না | default 0 | |
| `chain_json` | text | হ্যাঁ |  | |
| `history_json` | text | হ্যাঁ |  | |
| `from_json` | text | হ্যাঁ |  | |
| `to_json` | text | হ্যাঁ |  | |
| `reason` | text | হ্যাঁ |  | |
| `remarks` | text | হ্যাঁ |  | |
| `batch_id` | varchar(40) | হ্যাঁ |  | |
| `transfer_id` | int(11) | হ্যাঁ |  | |
| `salary_structure_id` | int(11) | হ্যাঁ |  | logical → `salary_structures` |
| `letter_id` | int(11) | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `decided_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `hr_increment_policies`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(150) | না |  | |
| `basis` | varchar(20) | না | default 'anniversary' | |
| `fixed_month` | int(11) | হ্যাঁ |  | |
| `min_service_months` | int(11) | না | default 12 | |
| `default_percent` | decimal(6,2) | না | default 5.00 | |
| `department_id` | int(11) | হ্যাঁ |  | logical → `departments` |
| `grade` | varchar(100) | হ্যাঁ |  | |
| `job_base` | varchar(50) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `hr_info_requests`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `batch_id` | varchar(40) | হ্যাঁ |  | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `user_id` | int(11) | না |  | logical → `users` |
| `item_type` | varchar(30) | না |  | |
| `doc_type` | varchar(100) | হ্যাঁ |  | |
| `note` | varchar(500) | হ্যাঁ |  | |
| `due_date` | date | হ্যাঁ |  | |
| `status` | varchar(20) | না | default 'pending' | |
| `submission_json` | text | হ্যাঁ |  | |
| `file_name` | varchar(255) | হ্যাঁ |  | |
| `file_mime` | varchar(100) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `submitted_at` | timestamp | হ্যাঁ |  | |
| `review_remarks` | varchar(500) | হ্যাঁ |  | |
| `reviewed_by` | int(11) | হ্যাঁ |  | |
| `reviewed_at` | timestamp | হ্যাঁ |  | |
| `result_ref` | varchar(100) | হ্যাঁ |  | |
| `requested_by` | int(11) | হ্যাঁ |  | |
| `reminded_on` | date | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `hr_letter_requests`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `letter_type` | varchar(40) | না |  | |
| `purpose` | varchar(500) | হ্যাঁ |  | |
| `status` | varchar(20) | না | default 'pending' | |
| `letter_id` | int(11) | হ্যাঁ |  | |
| `handled_by` | int(11) | হ্যাঁ |  | |
| `handled_at` | timestamp | হ্যাঁ |  | |
| `remarks` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `hr_letter_templates`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `letter_type` | varchar(40) | না |  | |
| `name` | varchar(150) | না |  | |
| `subject` | varchar(255) | না |  | |
| `body` | mediumtext | না |  | |
| `is_default` | tinyint(1) | না | default 0 | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `hr_letters`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `ref_no` | varchar(100) | না |  | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `letter_type` | varchar(40) | না |  | |
| `template_id` | int(11) | হ্যাঁ |  | |
| `subject` | varchar(255) | না |  | |
| `body` | mediumtext | না |  | |
| `letter_date` | date | না |  | |
| `hr_action_id` | int(11) | হ্যাঁ |  | logical → `hr_actions` |
| `request_id` | int(11) | হ্যাঁ |  | |
| `issued_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `status` | varchar(20) | না | default 'issued' | |
| `requires_ack` | tinyint(1) | না | default 1 | |
| `acknowledged_at` | timestamp | হ্যাঁ |  | |
| `ack_note` | varchar(500) | হ্যাঁ |  | |
| `cancelled_reason` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `emailed_to` | varchar(255) | হ্যাঁ |  | |
| `emailed_at` | timestamp | হ্যাঁ |  | |

### `hr_onboarding_items`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `task_key` | varchar(60) | না |  | |
| `label` | varchar(200) | না |  | |
| `category` | varchar(60) | হ্যাঁ |  | |
| `sort_order` | int(11) | না | default 0 | |
| `status` | varchar(20) | না | default 'pending' | |
| `due_date` | date | হ্যাঁ |  | |
| `note` | varchar(500) | হ্যাঁ |  | |
| `value_text` | varchar(255) | হ্যাঁ |  | |
| `attachment_name` | varchar(255) | হ্যাঁ |  | |
| `attachment_mime` | varchar(100) | হ্যাঁ |  | |
| `attachment_data` | longblob | হ্যাঁ |  | |
| `done_by` | int(11) | হ্যাঁ |  | |
| `done_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `hr_onboarding_tasks`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `task_key` | varchar(60) | না |  | |
| `label` | varchar(200) | না |  | |
| `category` | varchar(60) | হ্যাঁ |  | |
| `due_days` | int(11) | না | default 0 | |
| `sort_order` | int(11) | না | default 0 | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `hr_ops_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `setting_key` | varchar(100) | না |  | |
| `setting_value` | text | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `ucompany_setting_key`(company_id,setting_key)

### `hr_reminder_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না |  | কোম্পানি-মালিকানা (code-level scope) |
| `kind` | varchar(20) | না |  | |
| `employee_id` | int(11) | না |  | logical → `all_employees` |
| `ref_key` | varchar(40) | না | default '' | |
| `ref_date` | date | না |  | |
| `lead_days` | int(11) | না |  | |
| `user_id` | int(11) | না |  | logical → `users` |
| `sent_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uniq_hr_reminder`(company_id,kind,employee_id,ref_key,ref_date,lead_days,user_id)

### `hr_report_runs`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `report_id` | int(11) | হ্যাঁ |  | |
| `owner_user_id` | int(11) | না |  | |
| `report_name` | varchar(150) | না |  | |
| `period` | varchar(20) | হ্যাঁ |  | |
| `row_count` | int(11) | না | default 0 | |
| `recipients_json` | text | হ্যাঁ |  | |
| `result_json` | mediumtext | হ্যাঁ |  | |
| `run_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `hr_saved_reports`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `owner_user_id` | int(11) | না |  | FK → `users.id` |
| `name` | varchar(150) | না |  | |
| `config_json` | mediumtext | না |  | |
| `schedule_json` | text | হ্যাঁ |  | |
| `last_period` | varchar(20) | হ্যাঁ |  | |
| `last_run_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `job_candidates`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `posting_id` | int(11) | না |  | FK → `job_postings.id` |
| `name` | varchar(255) | না |  | |
| `email` | varchar(255) | হ্যাঁ |  | |
| `phone` | varchar(50) | হ্যাঁ |  | |
| `source` | varchar(100) | হ্যাঁ |  | |
| `status` | enum('applied','shortlisted','interview_scheduled','interviewed','offered','hired','rejected') | না | default 'applied' | |
| `notes` | text | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `employee_id` | int(11) | হ্যাঁ |  | logical → `all_employees` |

### `job_postings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `title` | varchar(255) | না |  | |
| `department` | varchar(255) | হ্যাঁ |  | |
| `designation` | varchar(255) | হ্যাঁ |  | |
| `vacancy_count` | int(11) | না | default 1 | |
| `description` | text | হ্যাঁ |  | |
| `requirements` | text | হ্যাঁ |  | |
| `status` | enum('open','on_hold','closed') | না | default 'open' | |
| `closing_date` | date | হ্যাঁ |  | |
| `posted_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `onboarding_applications`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না |  | কোম্পানি-মালিকানা (code-level scope) |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `candidate_id` | int(11) | হ্যাঁ |  | logical → `job_candidates` |
| `onb_code` | varchar(20) | না | UNI  | |
| `name` | varchar(255) | না |  | |
| `designation` | varchar(255) | হ্যাঁ |  | |
| `department_id` | int(11) | হ্যাঁ |  | logical → `departments` |
| `branch_id` | int(11) | হ্যাঁ |  | logical → `branches` |
| `joining_date` | date | হ্যাঁ |  | |
| `email` | varchar(255) | হ্যাঁ |  | |
| `phone` | varchar(60) | হ্যাঁ |  | |
| `status` | varchar(20) | না | default 'draft' | |
| `data_json` | mediumtext | হ্যাঁ |  | |
| `submitted_at` | datetime | হ্যাঁ |  | |
| `review_remarks` | varchar(500) | হ্যাঁ |  | |
| `reviewed_by` | int(11) | হ্যাঁ |  | |
| `reviewed_at` | datetime | হ্যাঁ |  | |
| `employee_id` | int(11) | হ্যাঁ |  | logical → `all_employees` |
| `created_by` | int(11) | হ্যাঁ |  | |
| `expires_at` | datetime | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uq_onb_code`(onb_code)

### `onboarding_documents`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `application_id` | int(11) | না |  | FK → `onboarding_applications.id` |
| `doc_type` | varchar(100) | না |  | |
| `file_name` | varchar(255) | না |  | |
| `file_mime` | varchar(100) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `uploaded_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uq_onb_doc`(application_id,doc_type)

## D. Attendance, Roster, Breaks & Tracking

রিমোট উপস্থিতি (GPS), অফিস উপস্থিতি (ZKTeco ডিভাইস লগ), সাইট muster roll, ডিউটি রোস্টার, দেরি নীতি, বিরতি, লাইভ লোকেশন।

### `attendance`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `project_id` | int(11) | না |  | FK → `projects.id` |
| `attendance_date` | date | না |  | |
| `check_in_at` | timestamp | হ্যাঁ |  | |
| `check_in_lat` | decimal(10,7) | হ্যাঁ |  | |
| `check_in_lng` | decimal(10,7) | হ্যাঁ |  | |
| `check_in_distance_m` | int(11) | হ্যাঁ |  | |
| `check_out_at` | timestamp | হ্যাঁ |  | |
| `check_out_lat` | decimal(10,7) | হ্যাঁ |  | |
| `check_out_lng` | decimal(10,7) | হ্যাঁ |  | |
| `check_out_distance_m` | int(11) | হ্যাঁ |  | |
| `check_in_remarks` | text | হ্যাঁ |  | |
| `check_out_remarks` | text | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_project_date`(user_id,project_id,attendance_date)

### `attendance_corrections`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `project_id` | int(11) | না |  | FK → `projects.id` |
| `attendance_date` | date | না |  | |
| `requested_check_in_at` | datetime | হ্যাঁ |  | |
| `requested_check_out_at` | datetime | হ্যাঁ |  | |
| `remarks` | text | হ্যাঁ |  | |
| `file_name` | varchar(255) | হ্যাঁ |  | |
| `file_mimetype` | varchar(150) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `status` | enum('pending','approved','rejected') | না | default 'pending' | |
| `admin_remarks` | text | হ্যাঁ |  | |
| `reviewed_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `reviewed_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `attendance_report_department_access`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `department` | varchar(150) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_department`(user_id,department)

### `break_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | UNI default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `allowed_minutes` | int(11) | না | default 60 | |
| `max_breaks` | int(11) | না | default 3 | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | datetime | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uniq_break_settings_company`(company_id)

### `duty_roster`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | logical → `all_employees` |
| `roster_date` | date | না |  | |
| `shift_id` | int(11) | হ্যাঁ |  | logical → `duty_shifts` |
| `is_off` | tinyint(1) | না | default 0 | |
| `note` | varchar(255) | হ্যাঁ |  | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | datetime | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uniq_duty_roster_day`(employee_id,roster_date)

### `duty_roster_department_access`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `department` | varchar(150) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_department`(user_id,department)

### `duty_shifts`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `name` | varchar(100) | না |  | |
| `code` | varchar(8) | না |  | |
| `start_time` | time | না |  | |
| `end_time` | time | না |  | |
| `grace_minutes` | int(11) | হ্যাঁ |  | |
| `extreme_grace_minutes` | int(11) | হ্যাঁ |  | |
| `color` | varchar(16) | না | default '#7F00FF' | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | datetime | হ্যাঁ | default current_timestamp() | |
| `updated_at` | datetime | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `employee_breaks`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `break_date` | date | না |  | |
| `started_at` | datetime | না |  | |
| `ended_at` | datetime | হ্যাঁ |  | |
| `minutes` | int(11) | হ্যাঁ |  | |
| `note` | varchar(255) | হ্যাঁ |  | |
| `open_flag` | tinyint(4) | হ্যাঁ |  | |
| `ended_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uniq_employee_breaks_open`(user_id,open_flag)

### `late_policy_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `shift_start_time` | time | না | default '09:00:00' | |
| `grace_minutes` | int(11) | না | default 10 | |
| `lates_per_deduction_day` | int(11) | না | default 3 | |
| `extreme_grace_minutes` | int(11) | না | default 60 | |
| `extreme_lates_per_deduction_day` | int(11) | না | default 1 | |
| `effective_date` | date | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `late_waivers`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `waiver_date` | date | না |  | |
| `reason` | varchar(255) | হ্যাঁ |  | |
| `waived_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_employee_waiver_date`(employee_id,waiver_date)

### `location_pings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `lat` | decimal(10,7) | না |  | |
| `lng` | decimal(10,7) | না |  | |
| `accuracy_m` | int(11) | হ্যাঁ |  | |
| `battery_pct` | int(11) | হ্যাঁ |  | |
| `recorded_at` | timestamp | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `site_attendance_entries`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `sheet_id` | int(11) | না |  | FK → `site_attendance_sheets.id` |
| `team_id` | int(11) | না |  | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `attendance_date` | date | না |  | |
| `status` | varchar(20) | না |  | |
| `in_time` | varchar(5) | হ্যাঁ |  | |
| `out_time` | varchar(5) | হ্যাঁ |  | |
| `remarks` | varchar(255) | হ্যাঁ |  | |
| `confirmed` | tinyint(1) | না | default 0 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_site_entry`(employee_id,attendance_date)

### `site_attendance_members`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `team_id` | int(11) | না |  | FK → `site_attendance_teams.id` |
| `employee_id` | int(11) | না | UNI  | FK → `all_employees.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_site_member`(employee_id)

### `site_attendance_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `require_approval` | tinyint(1) | না | default 0 | |
| `require_photo` | tinyint(1) | না | default 0 | |
| `require_location` | tinyint(1) | না | default 0 | |
| `backdate_days` | int(11) | না | default 2 | |
| `reminder_time` | varchar(5) | না | default '11:00' | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ |  | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `site_attendance_sheets`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `team_id` | int(11) | না |  | FK → `site_attendance_teams.id` |
| `attendance_date` | date | না |  | |
| `status` | varchar(20) | না | default 'submitted' | |
| `submitted_by` | int(11) | হ্যাঁ |  | |
| `submitted_at` | timestamp | হ্যাঁ |  | |
| `lat` | decimal(10,7) | হ্যাঁ |  | |
| `lng` | decimal(10,7) | হ্যাঁ |  | |
| `accuracy_m` | int(11) | হ্যাঁ |  | |
| `distance_m` | int(11) | হ্যাঁ |  | |
| `outside_site` | tinyint(1) | না | default 0 | |
| `photo_mime` | varchar(100) | হ্যাঁ |  | |
| `photo_data` | longblob | হ্যাঁ |  | |
| `note` | varchar(500) | হ্যাঁ |  | |
| `reviewed_by` | int(11) | হ্যাঁ |  | |
| `reviewed_at` | timestamp | হ্যাঁ |  | |
| `review_note` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_site_sheet`(team_id,attendance_date)

### `site_attendance_teams`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(150) | না |  | |
| `project_id` | int(11) | হ্যাঁ |  | logical → `projects` |
| `site_location` | varchar(255) | হ্যাঁ |  | |
| `supervisor_user_id` | int(11) | না |  | |
| `backup_user_id` | int(11) | হ্যাঁ |  | |
| `lat` | decimal(10,7) | হ্যাঁ |  | |
| `lng` | decimal(10,7) | হ্যাঁ |  | |
| `radius_m` | int(11) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `reminded_on` | date | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `tracking_department_access`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `department` | varchar(150) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_department`(user_id,department)

### `tracking_device_state`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `user_id` | int(11) | না | PK  | FK → `users.id` |
| `location_on` | tinyint(1) | হ্যাঁ |  | |
| `foreground_granted` | tinyint(1) | হ্যাঁ |  | |
| `background_granted` | tinyint(1) | হ্যাঁ |  | |
| `precise_granted` | tinyint(1) | হ্যাঁ |  | |
| `mode` | varchar(10) | হ্যাঁ |  | |
| `battery_pct` | int(11) | হ্যাঁ |  | |
| `reported_at` | timestamp | না | default current_timestamp() | |

### `tracking_employee_access`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `employee_pk` | int(11) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_employee`(user_id,employee_pk)

### `tracking_notice_recipients`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `notice_id` | int(11) | না |  | FK → `notices.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `employee_pk` | int(11) | হ্যাঁ |  | |
| `reason` | varchar(80) | হ্যাঁ |  | |
| `last_ping` | datetime | হ্যাঁ |  | |
| `sent_by` | int(11) | হ্যাঁ |  | |
| `sent_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `vehicle_ride_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK  | |
| `grace_minutes` | int(11) | না | default 30 | |
| `reminder_minutes` | int(11) | না | default 60 | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `zk_attendance_logs`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `device_id` | int(11) | না |  | FK → `zk_devices.id` |
| `device_user_pin` | varchar(20) | না |  | |
| `punch_time` | datetime | না |  | |
| `verify_mode` | int(11) | হ্যাঁ |  | |
| `work_code` | int(11) | হ্যাঁ |  | |
| `synced_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_device_pin_time`(device_id,device_user_pin,punch_time)

### `zk_devices`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(100) | না |  | |
| `ip_address` | varchar(45) | না |  | |
| `port` | int(11) | না | default 4370 | |
| `serial_number` | varchar(100) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `last_synced_at` | timestamp | হ্যাঁ |  | |
| `last_sync_status` | varchar(255) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `unique_device_ip_port`(ip_address,port)

## A. Accounts, Access & Security

লগইন অ্যাকাউন্ট (`users`), সেশন, ডিভাইস, Module Access (কে কোন মডিউল/layer পাবে), পাসওয়ার্ড রিসেট, লগইন চেষ্টার লক। পুরো সিস্টেমের কেন্দ্র `users` টেবিল।

### `access_templates`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(100) | না |  | |
| `description` | varchar(255) | হ্যাঁ |  | |
| `features_json` | text | হ্যাঁ |  | |
| `modules_json` | text | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `is_default` | tinyint(1) | না | default 0 | |
| `features_rev` | int(11) | না | default 1 | |

### `admin_module_permission_layers`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `module_key` | varchar(50) | না |  | |
| `layer_key` | varchar(30) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `unique_user_company_module_layer`(user_id,company_id,module_key,layer_key)

### `admin_module_permissions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `module_key` | varchar(50) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `unique_user_company_module`(user_id,company_id,module_key)

### `employee_template_assignments`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_user_id` | int(11) | না |  | FK → `users.id` |
| `request_type` | enum('conveyance','leave','timesheet','asset','vehicle','mobile','loan') | না |  | |
| `template_id` | int(11) | না |  | FK → `approval_templates.id` |
| `assigned_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `unique_employee_request_type`(employee_user_id,request_type)

### `fingerprint_logins`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `kind` | varchar(10) | না |  | |
| `device_id` | varchar(128) | হ্যাঁ |  | |
| `label` | varchar(200) | হ্যাঁ |  | |
| `secret_hash` | char(64) | হ্যাঁ |  | |
| `credential_id` | varchar(512) | হ্যাঁ |  | |
| `public_key` | text | হ্যাঁ |  | |
| `counter` | bigint(20) | না | default 0 | |
| `transports` | varchar(200) | হ্যাঁ |  | |
| `pw_mark` | char(16) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `last_used_at` | datetime | হ্যাঁ |  | |

### `login_attempts`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `ip` | varchar(64) | না |  | |
| `identifier` | varchar(190) | না |  | |
| `user_id` | int(11) | হ্যাঁ |  | logical → `users` |
| `success` | tinyint(1) | না | default 0 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `password_reset_codes`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `code_hash` | char(64) | না |  | |
| `expires_at` | datetime | না |  | |
| `attempts` | int(11) | না | default 0 | |
| `used_at` | datetime | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `password_reset_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `ip` | varchar(64) | হ্যাঁ |  | |
| `kind` | varchar(12) | না |  | |
| `user_id` | int(11) | হ্যাঁ |  | logical → `users` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `password_reset_requests`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `note` | varchar(255) | হ্যাঁ |  | |
| `status` | varchar(12) | না | default 'pending' | |
| `ip` | varchar(64) | হ্যাঁ |  | |
| `handled_by` | int(11) | হ্যাঁ |  | |
| `handled_at` | datetime | হ্যাঁ |  | |
| `reject_reason` | varchar(255) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `password_reset_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK  | |
| `email_code_enabled` | tinyint(1) | না | default 0 | |
| `hr_request_enabled` | tinyint(1) | না | default 1 | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | datetime | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `payroll_access_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `user_id` | int(11) | হ্যাঁ |  | logical → `users` |
| `user_name` | varchar(150) | হ্যাঁ |  | |
| `kind` | varchar(10) | না |  | |
| `area` | varchar(120) | না |  | |
| `detail` | varchar(500) | হ্যাঁ |  | |
| `ip` | varchar(64) | হ্যাঁ |  | |
| `device` | varchar(200) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `platform_visits`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `group_id` | int(11) | না |  | |
| `company_id` | int(11) | না |  | কোম্পানি-মালিকানা (code-level scope) |
| `visited_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `session_policy`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK  | |
| `web_hours` | int(11) | না | default 12 | |
| `web_idle_minutes` | int(11) | না | default 60 | |
| `app_days` | int(11) | না | default 7 | |
| `app_idle_days` | int(11) | না | default 3 | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `user_access_audit`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `target_user_id` | int(11) | না |  | |
| `actor_user_id` | int(11) | হ্যাঁ |  | |
| `action` | varchar(64) | না |  | |
| `detail` | text | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `user_company_access`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `company_id` | int(11) | না |  | FK → `companies.id` |
| `is_default` | tinyint(1) | না | default 0 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_company`(user_id,company_id)

### `user_devices`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `device_id` | varchar(128) | না |  | |
| `device_name` | varchar(200) | হ্যাঁ |  | |
| `platform` | varchar(20) | হ্যাঁ |  | |
| `status` | varchar(20) | না | default 'active' | |
| `requested_at` | timestamp | হ্যাঁ |  | |
| `approved_by` | int(11) | হ্যাঁ |  | |
| `approved_at` | timestamp | হ্যাঁ |  | |
| `last_seen_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uniq_user_device`(user_id,device_id)

### `user_profile_details`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `user_id` | int(11) | না | PK  | FK → `users.id` |
| `first_name` | varchar(150) | হ্যাঁ |  | |
| `last_name` | varchar(150) | হ্যাঁ |  | |
| `date_of_birth` | date | হ্যাঁ |  | |
| `country` | varchar(100) | হ্যাঁ |  | |
| `state` | varchar(100) | হ্যাঁ |  | |
| `city` | varchar(100) | হ্যাঁ |  | |
| `full_address` | text | হ্যাঁ |  | |
| `photo_mimetype` | varchar(150) | হ্যাঁ |  | |
| `photo_data` | longblob | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `user_project_permissions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `project_id` | int(11) | না |  | FK → `projects.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_project`(user_id,project_id)

### `user_sessions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `session_key` | char(40) | না | UNI  | |
| `user_id` | int(11) | না |  | logical → `users` |
| `client` | varchar(10) | না | default 'web' | |
| `device_row_id` | int(11) | হ্যাঁ |  | |
| `ip` | varchar(64) | হ্যাঁ |  | |
| `user_agent` | varchar(400) | হ্যাঁ |  | |
| `signed_in_at` | timestamp | হ্যাঁ |  | |
| `first_seen_at` | timestamp | হ্যাঁ |  | |
| `last_seen_at` | timestamp | হ্যাঁ |  | |
| `revoked_at` | datetime | হ্যাঁ |  | |
| `revoked_reason` | varchar(20) | হ্যাঁ |  | |
| `kept_after` | datetime(3) | হ্যাঁ |  | |

Unique: `uniq_session_key`(session_key)

### `user_signatures`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `user_id` | int(11) | না | PK  | FK → `users.id` |
| `image` | mediumblob | না |  | |
| `updated_at` | datetime | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `users`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(100) | না |  | |
| `email` | varchar(150) | হ্যাঁ | UNI  | |
| `username` | varchar(150) | হ্যাঁ | UNI  | |
| `password_hash` | varchar(255) | না |  | |
| `role` | enum('superadmin','admin','user') | হ্যাঁ | default 'user' | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `last_login_lat` | decimal(10,7) | হ্যাঁ |  | |
| `last_login_lng` | decimal(10,7) | হ্যাঁ |  | |
| `last_login_at` | timestamp | হ্যাঁ |  | |
| `can_edit_delivery_date` | tinyint(1) | না | default 1 | |
| `can_job_edit` | tinyint(1) | না | default 0 | |
| `can_use_attendance` | tinyint(1) | না | default 0 | |
| `can_use_tracking` | tinyint(1) | না | default 0 | |
| `can_view_login_location` | tinyint(1) | না | default 0 | |
| `can_grant_module_access` | tinyint(1) | না | default 0 | |
| `can_access_user_panel` | tinyint(1) | না | default 0 | |
| `can_manage_leave` | tinyint(1) | না | default 0 | |
| `can_view_movement_claims` | tinyint(1) | না | default 0 | |
| `can_view_conveyance_claims` | tinyint(1) | না | default 0 | |
| `can_save_ride_places` | tinyint(1) | না | default 0 | |
| `chat_about` | varchar(140) | হ্যাঁ |  | |
| `group_id` | int(11) | না | default 1 | |
| `is_platform_admin` | tinyint(1) | না | default 0 | |
| `can_view_group_directory` | tinyint(1) | না | default 0 | |
| `can_work_all_companies` | tinyint(1) | না | default 0 | |
| `max_devices` | int(11) | না | default 1 | |
| `sessions_valid_after` | datetime(3) | হ্যাঁ |  | |
| `can_view_budget_module` | tinyint(1) | না | default 1 | |
| `can_view_leave_summary` | tinyint(1) | না | default 0 | |
| `can_view_timesheet` | tinyint(1) | না | default 0 | |
| `can_view_leave_application` | tinyint(1) | না | default 0 | |
| `can_view_my_leave` | tinyint(1) | না | default 0 | |
| `is_blocked` | tinyint(1) | না | default 0 | |
| `blocked_reason` | varchar(255) | হ্যাঁ |  | |
| `blocked_at` | datetime | হ্যাঁ |  | |
| `blocked_by` | int(11) | হ্যাঁ |  | |
| `is_onboarding` | tinyint(1) | না | default 0 | |
| `must_change_password` | tinyint(1) | না | default 0 | |
| `onboarding_expires_at` | datetime | হ্যাঁ |  | |
| `can_use_calls` | tinyint(1) | না | default 0 | |
| `can_use_chat` | tinyint(1) | না | default 1 | |
| `can_use_ai_assistant` | tinyint(1) | না | default 1 | |
| `can_export_assistant_reports` | tinyint(1) | না | default 0 | |
| `can_handle_assistant_support` | tinyint(1) | না | default 0 | |
| `can_view_tasks` | tinyint(1) | না | default 0 | |
| `can_view_targets` | tinyint(1) | না | default 0 | |
| `can_view_loan_request` | tinyint(1) | না | default 0 | |
| `can_view_service_book` | tinyint(1) | না | default 0 | |
| `can_view_mobile_bill` | tinyint(1) | না | default 0 | |
| `can_view_group_dashboard` | tinyint(1) | না | default 0 | |
| `attendance_project_id` | int(11) | হ্যাঁ |  | FK → `projects.id` |
| `can_use_mail` | tinyint(1) | না | default 0 | |
| `can_view_mail_directory` | tinyint(1) | না | default 0 | |
| `can_use_mail_groups` | tinyint(1) | না | default 0 | |
| `can_view_roster` | tinyint(1) | না | default 0 | |
| `can_take_break` | tinyint(1) | না | default 0 | |
| `can_give_feedback` | tinyint(1) | না | default 0 | |
| `can_use_fingerprint` | tinyint(1) | না | default 0 | |
| `can_receive_material` | tinyint(1) | না | default 0 | |
| `can_return_dispatch` | tinyint(1) | না | default 0 | |
| `can_sign_documents` | tinyint(1) | না | default 0 | |
| `can_view_payslip` | tinyint(1) | না | default 0 | |
| `can_email_reports` | tinyint(1) | না | default 0 | |
| `can_request_items` | tinyint(1) | না | default 0 | |

Unique: `email`(email), `username`(username)

### `web_push_keys`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK  | |
| `public_key` | varchar(255) | না |  | |
| `private_key` | varchar(255) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `web_push_subscriptions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `endpoint` | varchar(700) | না | UNI  | |
| `p256dh` | varchar(255) | না |  | |
| `auth` | varchar(100) | না |  | |
| `user_agent` | varchar(255) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `last_used_at` | timestamp | হ্যাঁ |  | |

Unique: `uniq_web_push_endpoint`(endpoint)

## M. PEPM: MPR, Jobs, Budget & Materials

প্রকল্পের MPR নম্বর, job, entry (সারি), budget ও submission, dispatch/receive, উপকরণ ক্যাটাগরি, রেট লিস্ট।

### `budget_items`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `budget_id` | int(11) | না |  | FK → `budgets.id` |
| `sl_no` | varchar(30) | হ্যাঁ |  | |
| `project_name` | varchar(150) | হ্যাঁ |  | |
| `req_no` | varchar(100) | হ্যাঁ |  | |
| `mrf_no` | varchar(100) | হ্যাঁ |  | |
| `item_date` | varchar(50) | হ্যাঁ |  | |
| `description` | varchar(255) | হ্যাঁ |  | |
| `unit` | varchar(50) | হ্যাঁ |  | |
| `specification` | varchar(255) | হ্যাঁ |  | |
| `req_qty` | varchar(50) | হ্যাঁ |  | |
| `po_qty` | varchar(50) | হ্যাঁ |  | |
| `received_qty` | varchar(50) | হ্যাঁ |  | |
| `balance_qty` | varchar(50) | হ্যাঁ |  | |
| `entry_user` | varchar(100) | হ্যাঁ |  | |
| `approved_date` | varchar(50) | হ্যাঁ |  | |
| `app_user` | varchar(100) | হ্যাঁ |  | |
| `site_sup_date` | varchar(50) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `budget_submissions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `budget_id` | int(11) | না |  | FK → `budgets.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `submitted_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_budget_user`(budget_id,user_id)

### `budgets`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `budget_name` | varchar(150) | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `original_filename` | varchar(255) | হ্যাঁ |  | |
| `file_mimetype` | varchar(150) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `delivery_date_from` | date | হ্যাঁ |  | |
| `delivery_date_to` | date | হ্যাঁ |  | |
| `is_published` | tinyint(1) | না | default 0 | |
| `published_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |
| `rate_approved_at` | timestamp | হ্যাঁ |  | |
| `rate_approved_by` | int(11) | হ্যাঁ |  | |

### `delivery_date_conditions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `condition_type` | enum('entry','job_edit') | না |  | |
| `scope` | enum('global','project','budget') | না | default 'global' | |
| `scope_id` | int(11) | না | default 0 | |
| `min_lead_days` | int(11) | না | default 0 | |
| `apply_to_admins` | tinyint(1) | না | default 0 | |
| `enabled` | tinyint(1) | না | default 0 | |
| `updated_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |

Unique: `ugroup_delivery_condition`(group_id,condition_type,scope,scope_id)

### `entries`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `entry_date` | date | না |  | |
| `job_name` | varchar(30) | না |  | |
| `budget_id` | int(11) | হ্যাঁ |  | FK → `budgets.id` |
| `project_id` | int(11) | না |  | FK → `projects.id` |
| `job_id` | int(11) | না |  | FK → `jobs.id` |
| `mpr_id` | int(11) | না |  | FK → `mpr_numbers.id` |
| `budget_item_id` | int(11) | হ্যাঁ |  | FK → `budget_items.id` |
| `item_name` | varchar(255) | না |  | |
| `requisitioned_qty` | decimal(14,2) | হ্যাঁ |  | |
| `delivery_date` | date | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `deleted_at` | timestamp | হ্যাঁ |  | |
| `deleted_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `matched_rate` | decimal(14,2) | হ্যাঁ |  | |
| `computed_amount` | decimal(16,2) | হ্যাঁ |  | |
| `category_head` | varchar(150) | হ্যাঁ |  | |
| `category_sub1` | varchar(150) | হ্যাঁ |  | |
| `category_sub2` | varchar(150) | হ্যাঁ |  | |
| `category_sub3` | varchar(150) | হ্যাঁ |  | |
| `category_sector` | varchar(100) | হ্যাঁ |  | |
| `rate_calculated_at` | timestamp | হ্যাঁ |  | |
| `md_status` | varchar(20) | না | default 'pending' | |
| `md_target_qty` | decimal(14,2) | হ্যাঁ |  | |
| `md_dispatched_qty` | decimal(14,2) | না | default 0.00 | |
| `md_received_qty` | decimal(14,2) | না | default 0.00 | |
| `md_last_dispatch_date` | date | হ্যাঁ |  | |
| `md_received_date` | date | হ্যাঁ |  | |
| `md_queued_at` | timestamp | হ্যাঁ |  | |
| `md_queued_by` | int(11) | হ্যাঁ |  | |
| `md_confirmed_at` | timestamp | হ্যাঁ |  | |
| `md_confirmed_by` | int(11) | হ্যাঁ |  | |

### `entry_edit_history`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `entry_id` | int(11) | না |  | FK → `entries.id` |
| `edited_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `field_name` | varchar(50) | না |  | |
| `old_value` | varchar(255) | হ্যাঁ |  | |
| `new_value` | varchar(255) | হ্যাঁ |  | |
| `edited_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `entry_permanent_delete_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `entry_id` | int(11) | না |  | logical → `entries` |
| `entry_date` | date | হ্যাঁ |  | |
| `job_name` | varchar(30) | হ্যাঁ |  | |
| `job_no` | varchar(100) | হ্যাঁ |  | |
| `project_name` | varchar(150) | হ্যাঁ |  | |
| `mpr_no` | varchar(100) | হ্যাঁ |  | |
| `item_name` | varchar(255) | হ্যাঁ |  | |
| `requisitioned_qty` | decimal(14,2) | হ্যাঁ |  | |
| `entry_created_by_name` | varchar(100) | হ্যাঁ |  | |
| `entry_deleted_by_name` | varchar(100) | হ্যাঁ |  | |
| `entry_deleted_at` | timestamp | হ্যাঁ |  | |
| `permanently_deleted_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `permanently_deleted_by_name` | varchar(100) | না |  | |
| `permanently_deleted_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `job_edit_requests`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `job_id` | int(11) | হ্যাঁ |  | FK → `jobs.id` |
| `entry_id` | int(11) | হ্যাঁ |  | FK → `entries.id` |
| `action` | enum('add_item','delete_entry','add_job') | না |  | |
| `payload` | text | হ্যাঁ |  | |
| `status` | enum('pending','approved','rejected') | না | default 'pending' | |
| `requested_by` | int(11) | না |  | FK → `users.id` |
| `reviewed_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `reviewed_at` | timestamp | হ্যাঁ |  | |
| `review_note` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `job_submissions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `job_id` | int(11) | না |  | FK → `jobs.id` |
| `budget_id` | int(11) | হ্যাঁ |  | logical → `budgets` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `submitted_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_job_user`(job_id,user_id)

### `jobs`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `job_no` | varchar(100) | না |  | |
| `job_duration` | varchar(50) | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `budget_id` | int(11) | হ্যাঁ |  | FK → `budgets.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_budget_job_no`(created_by,budget_id,job_no)

### `material_categories`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `sl_no` | int(11) | হ্যাঁ |  | |
| `head` | varchar(150) | হ্যাঁ |  | |
| `sub1` | varchar(150) | হ্যাঁ |  | |
| `sub2` | varchar(150) | হ্যাঁ |  | |
| `sub3` | varchar(150) | হ্যাঁ |  | |
| `details` | varchar(255) | হ্যাঁ |  | |
| `sector` | varchar(100) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |

### `mpr_dispatches`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `entry_id` | int(11) | না |  | logical → `entries` |
| `qty` | decimal(14,2) | না |  | |
| `dispatch_date` | date | না |  | |
| `supplier` | varchar(255) | হ্যাঁ |  | |
| `rate` | decimal(14,2) | হ্যাঁ |  | |
| `po_no` | varchar(255) | হ্যাঁ |  | |
| `challan_no` | varchar(100) | হ্যাঁ |  | |
| `vehicle_no` | varchar(100) | হ্যাঁ |  | |
| `note` | varchar(1000) | হ্যাঁ |  | |
| `source` | varchar(20) | না | default 'screen' | |
| `status` | varchar(20) | না | default 'sent' | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `received_qty` | decimal(14,2) | হ্যাঁ |  | |
| `received_date` | date | হ্যাঁ |  | |
| `received_note` | varchar(1000) | হ্যাঁ |  | |
| `received_by` | int(11) | হ্যাঁ |  | |
| `received_at` | timestamp | হ্যাঁ |  | |
| `cancelled_by` | int(11) | হ্যাঁ |  | |
| `cancelled_at` | timestamp | হ্যাঁ |  | |
| `cancel_reason` | varchar(1000) | হ্যাঁ |  | |
| `received_time` | time | হ্যাঁ |  | |
| `received_supplier` | varchar(255) | হ্যাঁ |  | |
| `truck_no` | varchar(40) | হ্যাঁ |  | |
| `po_status` | varchar(40) | হ্যাঁ |  | |
| `received_by_text` | varchar(255) | হ্যাঁ |  | |

### `mpr_fulfil_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `entry_id` | int(11) | না |  | logical → `entries` |
| `dispatch_id` | int(11) | হ্যাঁ |  | |
| `action` | varchar(20) | না |  | |
| `qty` | decimal(14,2) | হ্যাঁ |  | |
| `detail` | varchar(1000) | হ্যাঁ |  | |
| `user_id` | int(11) | হ্যাঁ |  | logical → `users` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `mpr_numbers`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `mpr_no` | varchar(100) | না | UNI  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |

Unique: `mpr_no`(mpr_no)

### `mpr_po_imports`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `file_name` | varchar(255) | হ্যাঁ |  | |
| `total_lines` | int(11) | না | default 0 | |
| `matched_lines` | int(11) | না | default 0 | |
| `new_pos` | int(11) | না | default 0 | |
| `updated_pos` | int(11) | না | default 0 | |
| `unmatched_lines` | int(11) | না | default 0 | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `mpr_po_lines`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `entry_id` | int(11) | না |  | logical → `entries` |
| `po_no` | varchar(100) | না |  | |
| `po_date` | date | হ্যাঁ |  | |
| `req_no` | varchar(100) | হ্যাঁ |  | |
| `app_no` | varchar(100) | হ্যাঁ |  | |
| `supplier` | varchar(255) | হ্যাঁ |  | |
| `brand` | varchar(255) | হ্যাঁ |  | |
| `unit` | varchar(50) | হ্যাঁ |  | |
| `order_qty` | decimal(14,2) | হ্যাঁ |  | |
| `app_qty` | decimal(14,2) | হ্যাঁ |  | |
| `rate` | decimal(14,2) | হ্যাঁ |  | |
| `amount` | decimal(16,2) | হ্যাঁ |  | |
| `received_qty` | decimal(14,2) | হ্যাঁ |  | |
| `import_id` | int(11) | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uq_mpr_po_line`(entry_id,po_no)

### `rate_file_meta`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK  | |
| `original_filename` | varchar(255) | হ্যাঁ |  | |
| `file_mimetype` | varchar(150) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `imported_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `rate_list`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `materials_name` | varchar(255) | না |  | |
| `unit` | varchar(50) | হ্যাঁ |  | |
| `rate` | decimal(14,2) | হ্যাঁ |  | |
| `specification` | varchar(255) | হ্যাঁ |  | |
| `assigned_person` | varchar(150) | হ্যাঁ |  | |
| `remarks` | varchar(255) | হ্যাঁ |  | |
| `is_manual` | tinyint(1) | না | default 0 | |
| `added_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |

## F. Claims, Conveyance & Mobile Bill

Movement claim, Conveyance Bill Claim (bill ও লাইন), অনুমোদনকারীর স্বাক্ষর, ক্লেইম নীতি, মোবাইল SIM ও বিল।

### `bill_claim_categories`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `name` | varchar(100) | না |  | |
| `description` | varchar(255) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `sort_order` | int(11) | না | default 0 | |
| `max_per_bill` | decimal(12,2) | হ্যাঁ |  | |
| `monthly_limit` | decimal(12,2) | হ্যাঁ |  | |
| `receipt_required` | tinyint(1) | না | default 0 | |
| `deleted_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `bill_claim_policy_history`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | bigint(20) | না | PK auto_increment | |
| `company_ref` | int(11) | না |  | |
| `actor_id` | int(11) | হ্যাঁ |  | |
| `actor_name` | varchar(150) | হ্যাঁ |  | |
| `actor_role` | varchar(30) | হ্যাঁ |  | |
| `action` | varchar(40) | না |  | |
| `target_type` | varchar(20) | না |  | |
| `target_id` | int(11) | হ্যাঁ |  | |
| `target_name` | varchar(150) | হ্যাঁ |  | |
| `before_json` | text | হ্যাঁ |  | |
| `after_json` | text | হ্যাঁ |  | |
| `ip` | varchar(64) | হ্যাঁ |  | |
| `user_agent` | varchar(255) | হ্যাঁ |  | |
| `created_at` | varchar(30) | না |  | |
| `prev_hash` | char(64) | না |  | |
| `row_hash` | char(64) | না |  | |

### `bill_claim_policy_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `policy_key` | varchar(64) | না |  | |
| `policy_value` | varchar(255) | না |  | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uniq_bcp_company_key`(company_id,policy_key)

### `claim_approval_signatures`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `approval_request_id` | int(11) | না |  | logical → `approval_requests` |
| `step_order` | int(11) | না |  | |
| `approver_user_id` | int(11) | না |  | |
| `image` | mediumblob | না |  | |
| `signed_at` | datetime | না |  | |

Unique: `uniq_claim_sig`(approval_request_id,step_order,approver_user_id)

### `claims`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `purpose` | varchar(255) | না |  | |
| `status` | enum('open','completed') | না | default 'open' | |
| `check_in_at` | timestamp | হ্যাঁ |  | |
| `check_in_lat` | decimal(10,7) | হ্যাঁ |  | |
| `check_in_lng` | decimal(10,7) | হ্যাঁ |  | |
| `check_in_remarks` | text | হ্যাঁ |  | |
| `check_out_at` | timestamp | হ্যাঁ |  | |
| `check_out_lat` | decimal(10,7) | হ্যাঁ |  | |
| `check_out_lng` | decimal(10,7) | হ্যাঁ |  | |
| `check_out_remarks` | text | হ্যাঁ |  | |
| `distance_km` | decimal(10,2) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `conveyance_bill_items`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `bill_id` | int(11) | না |  | FK → `conveyance_bills.id` |
| `source` | enum('movement_claim','manual','user_claim') | না | default 'manual' | |
| `claim_id` | int(11) | হ্যাঁ | UNI  | FK → `claims.id` |
| `user_claim_id` | int(11) | হ্যাঁ | UNI  | FK → `user_claims.id` |
| `entry_date` | date | না |  | |
| `particulars` | varchar(255) | না |  | |
| `from_location` | varchar(255) | হ্যাঁ |  | |
| `to_location` | varchar(255) | হ্যাঁ |  | |
| `distance_km` | decimal(10,2) | হ্যাঁ |  | |
| `rate_per_km` | decimal(10,2) | হ্যাঁ |  | |
| `amount` | decimal(12,2) | না |  | |
| `remarks` | text | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `claim_id`(claim_id), `user_claim_id`(user_claim_id)

### `conveyance_bills`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `bill_date` | date | না |  | |
| `remarks` | text | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `is_disbursed` | tinyint(1) | না | default 0 | |
| `voucher_no` | varchar(100) | হ্যাঁ |  | |
| `disbursed_at` | timestamp | হ্যাঁ |  | |
| `disbursed_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `conveyance_claim_department_access`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `department` | varchar(150) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_department`(user_id,department)

### `mobile_bills`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `sim_id` | int(11) | না |  | FK → `mobile_sims.id` |
| `bill_month` | char(7) | না |  | |
| `amount` | decimal(10,2) | না |  | |
| `limit_amount` | decimal(10,2) | না | default 0.00 | |
| `employee_id` | int(11) | হ্যাঁ |  | logical → `all_employees` |
| `paid_at` | datetime | হ্যাঁ |  | |
| `paid_by` | int(11) | হ্যাঁ |  | |
| `imported_by` | int(11) | হ্যাঁ |  | |
| `imported_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uniq_mobile_bill`(company_id,sim_id,bill_month)

### `mobile_limit_policies`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `employee_type` | varchar(100) | না | default '' | |
| `limit_amount` | decimal(10,2) | না |  | |
| `note` | varchar(255) | হ্যাঁ |  | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uniq_mobile_policy_type`(company_id,employee_type)

### `mobile_limit_requests`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `sim_id` | int(11) | না |  | FK → `mobile_sims.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `current_limit` | decimal(10,2) | না |  | |
| `requested_limit` | decimal(10,2) | না |  | |
| `scope` | varchar(10) | না | default 'month' | |
| `for_month` | char(7) | না |  | |
| `reason` | text | না |  | |
| `status` | varchar(12) | না | default 'pending' | |
| `decided_by` | int(11) | হ্যাঁ |  | |
| `decided_at` | datetime | হ্যাঁ |  | |
| `decision_note` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `mobile_sim_events`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `sim_id` | int(11) | না |  | FK → `mobile_sims.id` |
| `action` | varchar(30) | না |  | |
| `message` | varchar(500) | না |  | |
| `actor_id` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `old_limit` | decimal(10,2) | হ্যাঁ |  | |
| `new_limit` | decimal(10,2) | হ্যাঁ |  | |
| `change_kind` | varchar(20) | হ্যাঁ |  | |
| `for_month` | char(7) | হ্যাঁ |  | |

### `mobile_sims`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `phone_number` | varchar(15) | না |  | |
| `operator` | varchar(30) | না |  | |
| `sim_type` | varchar(15) | না | default 'postpaid' | |
| `package_name` | varchar(100) | হ্যাঁ |  | |
| `employee_id` | int(11) | হ্যাঁ |  | logical → `all_employees` |
| `duty_location` | varchar(150) | হ্যাঁ |  | |
| `limit_amount` | decimal(10,2) | না | default 0.00 | |
| `limit_source` | varchar(10) | না | default 'type' | |
| `status` | varchar(10) | না | default 'active' | |
| `issued_on` | date | হ্যাঁ |  | |
| `note` | varchar(255) | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uniq_mobile_sim_number`(company_id,phone_number)

### `user_claim_history`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_claim_id` | int(11) | না |  | FK → `user_claims.id` |
| `action` | varchar(20) | না |  | |
| `actor_id` | int(11) | হ্যাঁ |  | |
| `actor_name` | varchar(255) | হ্যাঁ |  | |
| `reason` | text | হ্যাঁ |  | |
| `version` | int(11) | না | default 1 | |
| `snapshot_json` | mediumtext | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `user_claim_items`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_claim_id` | int(11) | না |  | FK → `user_claims.id` |
| `category_id` | int(11) | হ্যাঁ |  | logical → `leave_categories` |
| `category_name` | varchar(100) | না |  | |
| `bill_date` | date | না |  | |
| `amount` | decimal(12,2) | না |  | |
| `description` | varchar(500) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `user_claim_references`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_claim_id` | int(11) | না |  | FK → `user_claims.id` |
| `claim_id` | int(11) | না | UNI  | FK → `claims.id` |
| `amount` | decimal(12,2) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `claim_id`(claim_id)

### `user_claims`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `claim_date` | date | না |  | |
| `from_date` | date | না |  | |
| `to_date` | date | না |  | |
| `category` | varchar(255) | না | default 'Others' | |
| `amount` | decimal(12,2) | না |  | |
| `description` | text | হ্যাঁ |  | |
| `file_name` | varchar(255) | হ্যাঁ |  | |
| `file_mimetype` | varchar(150) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `status` | enum('pending','approved','rejected') | না | default 'pending' | |
| `admin_remarks` | text | হ্যাঁ |  | |
| `reviewed_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `reviewed_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `approved_amount` | decimal(12,2) | হ্যাঁ |  | |
| `filed_by` | int(11) | হ্যাঁ |  | |
| `first_submitted_at` | datetime | হ্যাঁ |  | |
| `version` | int(11) | না | default 1 | |
| `edit_state` | varchar(20) | হ্যাঁ |  | |
| `return_reason` | text | হ্যাঁ |  | |
| `reclaim_allowed` | tinyint(1) | না | default 0 | |

## B. Company, Organisation & Employees

কোম্পানি-গ্রুপ, বিভাগ, শাখা, প্রজেক্ট, কর্মীর মূল তথ্য (`all_employees`), শিক্ষা/অভিজ্ঞতা/পরিবার/প্রশিক্ষণ, সুপারভাইজার, বদলি, ছুটির ক্যালেন্ডার। `users` = লগইন, `all_employees` = HR-এর কর্মী রেকর্ড; দুটো `user_id` দিয়ে জোড়া।

### `all_employees`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | varchar(50) | হ্যাঁ |  | |
| `zk_device_pin` | varchar(20) | হ্যাঁ | UNI  | |
| `name` | varchar(255) | না |  | |
| `designation` | varchar(255) | হ্যাঁ |  | |
| `department` | varchar(255) | হ্যাঁ |  | |
| `email` | varchar(255) | হ্যাঁ |  | |
| `phone` | varchar(50) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `user_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `middle_name` | varchar(255) | হ্যাঁ |  | |
| `gender` | varchar(20) | হ্যাঁ |  | |
| `date_of_birth` | date | হ্যাঁ |  | |
| `nid_ssn` | varchar(50) | হ্যাঁ |  | |
| `nationality` | varchar(100) | হ্যাঁ |  | |
| `marital_status` | varchar(30) | হ্যাঁ |  | |
| `blood_group` | varchar(10) | হ্যাঁ |  | |
| `religion` | varchar(50) | হ্যাঁ |  | |
| `is_foreigner` | tinyint(1) | না | default 0 | |
| `division` | varchar(255) | হ্যাঁ |  | |
| `branch` | varchar(255) | হ্যাঁ |  | |
| `unit` | varchar(255) | হ্যাঁ |  | |
| `status_effective_date` | date | হ্যাঁ |  | |
| `job_status` | varchar(50) | হ্যাঁ |  | |
| `job_status_effective_date` | date | হ্যাঁ |  | |
| `job_base` | varchar(50) | হ্যাঁ |  | |
| `job_base_effective_date` | date | হ্যাঁ |  | |
| `review_month` | varchar(20) | হ্যাঁ |  | |
| `employment_category` | varchar(50) | হ্যাঁ |  | |
| `employment_category_effective_date` | date | হ্যাঁ |  | |
| `designation_effective_date` | date | হ্যাঁ |  | |
| `mobile` | varchar(50) | হ্যাঁ |  | |
| `telephone` | varchar(50) | হ্যাঁ |  | |
| `personal_email` | varchar(255) | হ্যাঁ |  | |
| `present_address` | text | হ্যাঁ |  | |
| `present_country` | varchar(100) | হ্যাঁ |  | |
| `present_state` | varchar(100) | হ্যাঁ |  | |
| `present_city` | varchar(100) | হ্যাঁ |  | |
| `present_zip` | varchar(20) | হ্যাঁ |  | |
| `permanent_address` | text | হ্যাঁ |  | |
| `permanent_country` | varchar(100) | হ্যাঁ |  | |
| `permanent_state` | varchar(100) | হ্যাঁ |  | |
| `permanent_city` | varchar(100) | হ্যাঁ |  | |
| `permanent_zip` | varchar(20) | হ্যাঁ |  | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `department_id` | int(11) | হ্যাঁ |  | FK → `departments.id` |
| `branch_id` | int(11) | হ্যাঁ |  | FK → `branches.id` |
| `joining_date` | date | হ্যাঁ |  | |

Unique: `zk_device_pin`(zk_device_pin)

### `branches`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `branch_name` | varchar(150) | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `location_lat` | decimal(10,7) | হ্যাঁ |  | |
| `location_lng` | decimal(10,7) | হ্যাঁ |  | |
| `location_label` | varchar(255) | হ্যাঁ |  | |
| `location_radius` | int(11) | হ্যাঁ |  | |
| `project_id` | int(11) | হ্যাঁ | UNI  | FK → `projects.id` |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `branch_type` | enum('head_office','project_site') | না | default 'project_site' | |

Unique: `unique_branch_project`(project_id), `unique_company_branch_name`(company_id,branch_name)

### `companies`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `group_id` | int(11) | না |  | FK → `company_groups.id` |
| `name` | varchar(200) | না |  | |
| `short_code` | varchar(10) | না |  | |
| `is_mother` | tinyint(1) | না | default 0 | |
| `address` | varchar(500) | হ্যাঁ |  | |
| `phone` | varchar(60) | হ্যাঁ |  | |
| `email` | varchar(150) | হ্যাঁ |  | |
| `website` | varchar(150) | হ্যাঁ |  | |
| `logo_mime` | varchar(100) | হ্যাঁ |  | |
| `logo_data` | longblob | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `shared_settings` | text | হ্যাঁ |  | |

Unique: `unique_company_code`(group_id,short_code)

### `company_groups`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(150) | না |  | |
| `short_name` | varchar(50) | হ্যাঁ |  | |
| `logo_mime` | varchar(100) | হ্যাঁ |  | |
| `logo_data` | longblob | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `workspace_code` | varchar(40) | হ্যাঁ | UNI  | |
| `tagline` | varchar(200) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |

Unique: `unique_workspace_code`(workspace_code)

### `departments`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(150) | না |  | |
| `supervisor_user_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `include_supervisor_approval` | tinyint(1) | না | default 1 | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `unique_company_name`(company_id,name)

### `employee_advances`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `total_amount` | decimal(10,2) | না |  | |
| `monthly_installment` | decimal(10,2) | না |  | |
| `paid_amount` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `reason` | varchar(255) | হ্যাঁ |  | |
| `status` | enum('active','completed') | হ্যাঁ | default 'active' | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `employee_change_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `field_name` | varchar(100) | না |  | |
| `old_value` | text | হ্যাঁ |  | |
| `new_value` | text | হ্যাঁ |  | |
| `action_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `employee_company_assignments`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `company_id` | int(11) | না |  | FK → `companies.id` |
| `employee_code` | varchar(50) | হ্যাঁ |  | |
| `designation` | varchar(150) | হ্যাঁ |  | |
| `department` | varchar(150) | হ্যাঁ |  | |
| `start_date` | date | হ্যাঁ |  | |
| `end_date` | date | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `note` | varchar(500) | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_employee_company`(employee_id,company_id)

### `employee_documents`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `doc_type` | varchar(100) | না |  | |
| `file_name` | varchar(255) | না |  | |
| `file_mimetype` | varchar(100) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `requires_signature` | tinyint(1) | না | default 0 | |
| `expiry_date` | date | হ্যাঁ |  | |
| `uploaded_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `uploaded_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `sha256` | char(64) | হ্যাঁ |  | |
| `verify_code` | varchar(24) | হ্যাঁ | UNI  | |
| `sign_status` | varchar(16) | না | default 'none' | |
| `sign_placement` | varchar(16) | না | default 'page' | |
| `signed_file` | longblob | হ্যাঁ |  | |
| `signed_sha256` | char(64) | হ্যাঁ |  | |
| `sign_requested_by` | int(11) | হ্যাঁ |  | |
| `sign_requested_at` | datetime | হ্যাঁ |  | |
| `completed_at` | datetime | হ্যাঁ |  | |
| `seal` | char(64) | হ্যাঁ |  | |
| `events_head` | char(64) | হ্যাঁ |  | |
| `pki_subject` | varchar(255) | হ্যাঁ |  | |
| `pki_issuer` | varchar(255) | হ্যাঁ |  | |
| `pki_self_signed` | tinyint(1) | হ্যাঁ |  | |
| `source_type` | varchar(32) | হ্যাঁ |  | |
| `source_id` | int(11) | হ্যাঁ |  | |
| `sign_box` | varchar(200) | হ্যাঁ |  | |

Unique: `uniq_doc_verify_code`(verify_code)

### `employee_pay_items`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `component_id` | int(11) | হ্যাঁ |  | |
| `name` | varchar(100) | না |  | |
| `kind` | enum('earning','deduction') | না |  | |
| `amount` | decimal(10,2) | না |  | |
| `start_month` | varchar(7) | না |  | |
| `end_month` | varchar(7) | হ্যাঁ |  | |
| `remarks` | varchar(255) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `employee_payment_accounts`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `account_type` | enum('bank','mfs','cash') | না | default 'bank' | |
| `account_label` | varchar(100) | না |  | |
| `bank_name` | varchar(150) | হ্যাঁ |  | |
| `branch_name` | varchar(150) | হ্যাঁ |  | |
| `provider` | varchar(50) | হ্যাঁ |  | |
| `account_number` | varchar(100) | না |  | |
| `percentage` | decimal(5,2) | না | default 0.00 | |
| `is_active` | tinyint(1) | না | default 1 | |
| `sort_order` | int(11) | না | default 0 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `employee_supervisors`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `supervisor_id` | int(11) | না |  | FK → `all_employees.id` |
| `effective_date` | date | হ্যাঁ |  | |
| `is_direct` | tinyint(1) | না | default 0 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `employee_transfers`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `from_department_id` | int(11) | হ্যাঁ |  | |
| `from_department_name` | varchar(255) | হ্যাঁ |  | |
| `to_department_id` | int(11) | হ্যাঁ |  | |
| `to_department_name` | varchar(255) | হ্যাঁ |  | |
| `from_designation` | varchar(255) | হ্যাঁ |  | |
| `to_designation` | varchar(255) | হ্যাঁ |  | |
| `from_supervisor_id` | int(11) | হ্যাঁ |  | FK → `all_employees.id` |
| `to_supervisor_id` | int(11) | হ্যাঁ |  | FK → `all_employees.id` |
| `effective_date` | date | হ্যাঁ |  | |
| `reason` | varchar(255) | হ্যাঁ |  | |
| `action_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `applied` | tinyint(1) | না | default 1 | |

### `holiday_calendar`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `entry_date` | date | না |  | |
| `day_type` | enum('holiday','weekend') | না | default 'holiday' | |
| `title` | varchar(150) | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `applies_to` | enum('head_office','project_site') | না | default 'head_office' | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `ucompany_unique_holiday_entry_date_group`(company_id,entry_date,applies_to)

### `hr_emp_education`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `level` | varchar(60) | হ্যাঁ |  | |
| `degree` | varchar(150) | না |  | |
| `major` | varchar(150) | হ্যাঁ |  | |
| `institute` | varchar(200) | হ্যাঁ |  | |
| `board_university` | varchar(150) | হ্যাঁ |  | |
| `passing_year` | int(11) | হ্যাঁ |  | |
| `result` | varchar(60) | হ্যাঁ |  | |
| `duration` | varchar(60) | হ্যাঁ |  | |
| `verified` | tinyint(1) | না | default 0 | |
| `verified_by` | int(11) | হ্যাঁ |  | |
| `verified_at` | timestamp | হ্যাঁ |  | |
| `verify_note` | varchar(500) | হ্যাঁ |  | |
| `file_name` | varchar(255) | হ্যাঁ |  | |
| `file_mime` | varchar(100) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `hr_emp_experience`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `company_name` | varchar(200) | না |  | |
| `company_business` | varchar(150) | হ্যাঁ |  | |
| `location` | varchar(200) | হ্যাঁ |  | |
| `designation` | varchar(150) | হ্যাঁ |  | |
| `department` | varchar(150) | হ্যাঁ |  | |
| `from_date` | date | হ্যাঁ |  | |
| `to_date` | date | হ্যাঁ |  | |
| `responsibilities` | text | হ্যাঁ |  | |
| `last_salary` | decimal(12,2) | হ্যাঁ |  | |
| `leaving_reason` | varchar(500) | হ্যাঁ |  | |
| `reference_name` | varchar(150) | হ্যাঁ |  | |
| `reference_contact` | varchar(150) | হ্যাঁ |  | |
| `verified` | tinyint(1) | না | default 0 | |
| `verified_by` | int(11) | হ্যাঁ |  | |
| `verified_at` | timestamp | হ্যাঁ |  | |
| `verify_note` | varchar(500) | হ্যাঁ |  | |
| `file_name` | varchar(255) | হ্যাঁ |  | |
| `file_mime` | varchar(100) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `hr_emp_family`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `name` | varchar(150) | না |  | |
| `relation` | varchar(60) | হ্যাঁ |  | |
| `date_of_birth` | date | হ্যাঁ |  | |
| `occupation` | varchar(150) | হ্যাঁ |  | |
| `phone` | varchar(60) | হ্যাঁ |  | |
| `nid` | varchar(60) | হ্যাঁ |  | |
| `address` | varchar(500) | হ্যাঁ |  | |
| `is_nominee` | tinyint(1) | না | default 0 | |
| `nominee_percent` | decimal(5,2) | হ্যাঁ |  | |
| `is_emergency` | tinyint(1) | না | default 0 | |
| `is_dependent` | tinyint(1) | না | default 0 | |
| `remarks` | varchar(500) | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `hr_emp_training`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `title` | varchar(200) | না |  | |
| `training_type` | varchar(30) | হ্যাঁ |  | |
| `organizer` | varchar(200) | হ্যাঁ |  | |
| `location` | varchar(200) | হ্যাঁ |  | |
| `from_date` | date | হ্যাঁ |  | |
| `to_date` | date | হ্যাঁ |  | |
| `hours` | decimal(6,1) | হ্যাঁ |  | |
| `cost` | decimal(12,2) | হ্যাঁ |  | |
| `result` | varchar(100) | হ্যাঁ |  | |
| `certificate_no` | varchar(100) | হ্যাঁ |  | |
| `remarks` | varchar(500) | হ্যাঁ |  | |
| `file_name` | varchar(255) | হ্যাঁ |  | |
| `file_mime` | varchar(100) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `hr_employee_service`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না | UNI  | FK → `all_employees.id` |
| `grade` | varchar(100) | হ্যাঁ |  | |
| `probation_months` | int(11) | হ্যাঁ |  | |
| `probation_end_date` | date | হ্যাঁ |  | |
| `confirmation_date` | date | হ্যাঁ |  | |
| `contract_end_date` | date | হ্যাঁ |  | |
| `service_status` | varchar(30) | হ্যাঁ |  | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `employee_id`(employee_id)

### `projects`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `project_name` | varchar(150) | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `location_lat` | decimal(10,7) | হ্যাঁ |  | |
| `location_lng` | decimal(10,7) | হ্যাঁ |  | |
| `location_label` | varchar(255) | হ্যাঁ |  | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `location_radius` | int(11) | হ্যাঁ |  | |

Unique: `unique_company_project_name`(company_id,project_name)

### `server_profiles`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(150) | না |  | |
| `url` | varchar(255) | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |

## C. Leave

ছুটির ধরন, নীতি, ব্যালেন্স, বছরের সেটিং, ব্যালেন্স workflow এবং আবেদন (`leave_applications`)।

### `leave_accrual_log`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | logical → `users` |
| `category_key` | varchar(100) | না |  | |
| `month_year` | char(7) | না |  | |
| `days` | decimal(5,1) | না | default 0.0 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uq_leave_accrual`(user_id,category_key,month_year)

### `leave_application_department_access`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `department` | varchar(150) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_user_department`(user_id,department)

### `leave_applications`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `leave_type` | varchar(64) | না |  | |
| `start_date` | date | না |  | |
| `end_date` | date | না |  | |
| `day_count` | decimal(5,1) | না |  | |
| `is_continuous` | tinyint(1) | না | default 0 | |
| `is_prefix` | tinyint(1) | না | default 0 | |
| `is_suffix` | tinyint(1) | না | default 0 | |
| `is_half_day` | tinyint(1) | না | default 0 | |
| `include_extra_work_dates` | tinyint(1) | না | default 0 | |
| `is_foreign_leave` | tinyint(1) | না | default 0 | |
| `purpose` | text | না |  | |
| `approver_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `status` | enum('pending','approved','rejected') | না | default 'pending' | |
| `apply_date` | date | না |  | |
| `remarks` | text | হ্যাঁ |  | |
| `decided_by` | int(11) | হ্যাঁ |  | |
| `decided_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `reliever_id` | int(11) | হ্যাঁ |  | |
| `reliever_status` | enum('pending','approved','rejected') | হ্যাঁ |  | |
| `reliever_remarks` | text | হ্যাঁ |  | |
| `reliever_decided_by` | int(11) | হ্যাঁ |  | |
| `reliever_decided_at` | timestamp | হ্যাঁ |  | |

### `leave_balance_workflow_items`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `workflow_id` | int(11) | না |  | FK → `leave_balance_workflows.id` |
| `category_key` | varchar(100) | না |  | |
| `balance_days` | decimal(5,1) | না | default 0.0 | |

Unique: `uniq_workflow_category`(workflow_id,category_key)

### `leave_balance_workflows`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(100) | না |  | |
| `scope_type` | enum('general','designation') | না | default 'designation' | |
| `designation` | varchar(255) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |

### `leave_balances`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না | UNI  | FK → `users.id` |
| `casual_leave` | decimal(5,1) | না | default 0.0 | |
| `sick_leave` | decimal(5,1) | না | default 0.0 | |
| `leave_without_pay` | decimal(5,1) | না | default 0.0 | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `unique_user_leave`(user_id)

### `leave_categories`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `category_key` | varchar(100) | না |  | |
| `label` | varchar(100) | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `ucompany_unique_leave_category_key`(company_id,category_key)

### `leave_category_balances`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `category_id` | int(11) | না |  | FK → `leave_categories.id` |
| `balance` | decimal(5,1) | না | default 0.0 | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `unique_user_category`(user_id,category_id)

### `leave_category_policies`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `category_key` | varchar(100) | না |  | |
| `min_advance_notice_days` | int(11) | না | default 0 | |
| `reliever_required` | tinyint(1) | না | default 1 | |
| `max_consecutive_days` | int(11) | হ্যাঁ |  | |
| `require_paid_leave_exhausted` | tinyint(1) | না | default 0 | |
| `updated_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `min_service_months` | int(11) | না | default 0 | |
| `gender` | varchar(10) | না | default 'any' | |
| `accrual_per_month` | decimal(4,1) | না | default 0.0 | |
| `balance_cap` | decimal(5,1) | হ্যাঁ |  | |
| `carry_forward_max` | decimal(5,1) | হ্যাঁ |  | |
| `accrual_from` | char(7) | হ্যাঁ |  | |
| `count_off_days` | tinyint(1) | না | default 1 | |

Unique: `ucompany_uniq_leave_category_policy`(company_id,category_key)

### `leave_year_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK default 1 | |
| `close_month_day` | varchar(5) | না | default '12-31' | |
| `start_month_day` | varchar(5) | না | default '01-01' | |
| `auto_rollover` | tinyint(1) | না | default 0 | |
| `last_rollover_year` | int(11) | হ্যাঁ |  | |
| `updated_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

## L. Assets & Vehicles

অফিস সম্পদ, requisition, assignment, গাড়ি ও রাইড requisition।

### `asset_assignment_claims`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `assignment_id` | int(11) | না |  | FK → `asset_assignments.id` |
| `employee_user_id` | int(11) | না |  | FK → `users.id` |
| `issue_type` | enum('mismatch','damaged','missing','other') | না | default 'other' | |
| `description` | text | না |  | |
| `status` | enum('pending','resolved') | না | default 'pending' | |
| `resolution_note` | text | হ্যাঁ |  | |
| `resolved_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `resolved_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `asset_assignments`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `asset_id` | int(11) | না |  | FK → `assets.id` |
| `employee_user_id` | int(11) | না |  | FK → `users.id` |
| `requisition_id` | int(11) | হ্যাঁ |  | FK → `asset_requisitions.id` |
| `assigned_date` | date | না |  | |
| `returned_date` | date | হ্যাঁ |  | |
| `condition_on_assign` | enum('new','good') | না | default 'good' | |
| `condition_on_return` | enum('good','damaged','lost') | হ্যাঁ |  | |
| `assigned_by` | int(11) | না |  | FK → `users.id` |
| `acknowledged_at` | timestamp | হ্যাঁ |  | |
| `return_requested_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `quantity` | decimal(10,2) | হ্যাঁ |  | |
| `unit` | varchar(50) | হ্যাঁ |  | |
| `handover_note` | text | হ্যাঁ |  | |

### `asset_requisition_events`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `requisition_id` | int(11) | না |  | |
| `actor_user_id` | int(11) | হ্যাঁ |  | |
| `actor_name` | varchar(150) | হ্যাঁ |  | |
| `action` | varchar(50) | না |  | |
| `message` | text | না |  | |
| `details_json` | text | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `asset_requisition_items`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `requisition_id` | int(11) | না |  | FK → `asset_requisitions.id` |
| `item_name` | varchar(150) | না |  | |
| `purpose` | text | না |  | |
| `unit` | varchar(50) | না |  | |
| `quantity` | decimal(10,2) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `source` | varchar(20) | হ্যাঁ |  | |
| `original_quantity` | decimal(10,2) | হ্যাঁ |  | |
| `edited_by` | int(11) | হ্যাঁ |  | |
| `removed_at` | timestamp | হ্যাঁ |  | |
| `removed_by` | int(11) | হ্যাঁ |  | |

### `asset_requisitions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_user_id` | int(11) | না |  | FK → `users.id` |
| `asset_category` | varchar(100) | না |  | |
| `reason` | text | না |  | |
| `urgency` | enum('low','medium','high') | না | default 'medium' | |
| `target_date` | date | হ্যাঁ |  | |
| `attachment_filename` | varchar(255) | হ্যাঁ |  | |
| `attachment_mimetype` | varchar(150) | হ্যাঁ |  | |
| `attachment_data` | longblob | হ্যাঁ |  | |
| `status` | enum('pending','manager_approved','approved','rejected','dispatched','fulfilled') | না | default 'pending' | |
| `manager_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `manager_decided_at` | timestamp | হ্যাঁ |  | |
| `manager_remarks` | text | হ্যাঁ |  | |
| `admin_decided_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `admin_decided_at` | timestamp | হ্যাঁ |  | |
| `rejection_reason` | text | হ্যাঁ |  | |
| `assigned_asset_id` | int(11) | হ্যাঁ |  | FK → `assets.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `asset_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK  | |
| `show_inventory` | tinyint(1) | না | default 0 | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `assets`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `asset_tag` | varchar(50) | না |  | |
| `name` | varchar(255) | না |  | |
| `category` | varchar(100) | না |  | |
| `serial_number` | varchar(150) | হ্যাঁ |  | |
| `purchase_date` | date | হ্যাঁ |  | |
| `status` | enum('available','assigned','maintenance','disposed') | না | default 'available' | |
| `condition_note` | varchar(255) | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `ucompany_asset_tag`(company_id,asset_tag)

### `vehicle_requisitions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_user_id` | int(11) | না |  | FK → `users.id` |
| `purpose` | text | না |  | |
| `pickup_location` | varchar(255) | না |  | |
| `destination` | varchar(255) | না |  | |
| `ride_date` | date | না |  | |
| `start_time` | varchar(10) | না |  | |
| `estimated_duration_hours` | decimal(5,2) | না |  | |
| `expected_return_at` | datetime | হ্যাঁ |  | |
| `status` | enum('pending','approved','assigned','ongoing','rejected','cancelled','completed','expired') | না | default 'pending' | |
| `decided_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `decided_at` | timestamp | হ্যাঁ |  | |
| `rejection_reason` | text | হ্যাঁ |  | |
| `assigned_vehicle_id` | int(11) | হ্যাঁ |  | FK → `vehicles.id` |
| `driver_name` | varchar(150) | হ্যাঁ |  | |
| `driver_mobile` | varchar(30) | হ্যাঁ |  | |
| `actual_return_at` | datetime | হ্যাঁ |  | |
| `returned_late` | tinyint(1) | হ্যাঁ |  | |
| `time_extension_status` | enum('none','requested','approved','rejected') | না | default 'none' | |
| `time_extension_note` | text | হ্যাঁ |  | |
| `time_extension_decided_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `hr_notice_flag` | tinyint(1) | না | default 0 | |
| `hr_manual_note` | text | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `driver_user_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `deadline_reminded_at` | datetime | হ্যাঁ |  | |
| `expired_at` | datetime | হ্যাঁ |  | |
| `assigned_at` | datetime | হ্যাঁ |  | |
| `started_at` | datetime | হ্যাঁ |  | |
| `start_reminded_at` | datetime | হ্যাঁ |  | |
| `assigned_by` | int(11) | হ্যাঁ |  | |
| `started_by` | int(11) | হ্যাঁ |  | |
| `destination_lat` | decimal(10,7) | হ্যাঁ |  | |
| `destination_lng` | decimal(10,7) | হ্যাঁ |  | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `vehicles`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `vehicle_no` | varchar(50) | না | UNI  | |
| `model` | varchar(150) | না |  | |
| `vehicle_type` | varchar(50) | হ্যাঁ |  | |
| `status` | enum('available','on_ride','maintenance') | না | default 'available' | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `vehicle_no`(vehicle_no)

## J. Documents & E-Signature

Document Vault-এর ডকুমেন্ট ইভেন্ট, স্বাক্ষরকারী, স্বাক্ষর, সার্টিফিকেট (PKI), OTP।

### `document_events`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `document_id` | int(11) | না |  | FK → `employee_documents.id` |
| `seq` | int(11) | না |  | |
| `event` | varchar(32) | না |  | |
| `user_id` | int(11) | হ্যাঁ |  | logical → `users` |
| `ip` | varchar(64) | হ্যাঁ |  | |
| `user_agent` | varchar(255) | হ্যাঁ |  | |
| `detail` | varchar(500) | হ্যাঁ |  | |
| `at_iso` | varchar(32) | না |  | |
| `prev_hash` | char(64) | না |  | |
| `hash` | char(64) | না |  | |

Unique: `uniq_doc_event_seq`(document_id,seq)

### `document_signatures`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `document_id` | int(11) | না | UNI  | FK → `employee_documents.id` |
| `signer_user_id` | int(11) | না |  | FK → `users.id` |
| `signed_name` | varchar(255) | না |  | |
| `signed_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uniq_signature_document`(document_id)

### `document_signers`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `document_id` | int(11) | না |  | FK → `employee_documents.id` |
| `step_order` | int(11) | না |  | |
| `signer_user_id` | int(11) | না |  | FK → `users.id` |
| `label` | varchar(100) | হ্যাঁ |  | |
| `status` | varchar(16) | না | default 'waiting' | |
| `signed_name` | varchar(255) | হ্যাঁ |  | |
| `signature_image` | mediumblob | হ্যাঁ |  | |
| `signed_at` | datetime | হ্যাঁ |  | |
| `ip` | varchar(64) | হ্যাঁ |  | |
| `user_agent` | varchar(255) | হ্যাঁ |  | |
| `decline_reason` | varchar(500) | হ্যাঁ |  | |

Unique: `uniq_doc_step`(document_id,step_order)

### `esign_certificates`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | UNI default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `p12` | mediumblob | না |  | |
| `created_at` | datetime | হ্যাঁ | default current_timestamp() | |

Unique: `uniq_esign_cert_company`(company_id)

### `esign_otps`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `document_id` | int(11) | না |  | FK → `employee_documents.id` |
| `user_id` | int(11) | না |  | logical → `users` |
| `code_hash` | char(64) | না |  | |
| `sent_to` | varchar(255) | হ্যাঁ |  | |
| `expires_at` | datetime | না |  | |
| `attempts` | int(11) | না | default 0 | |
| `locked_until` | datetime | হ্যাঁ |  | |
| `used_at` | datetime | হ্যাঁ |  | |
| `created_at` | datetime | না |  | |

### `esign_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | UNI default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `otp_required` | tinyint(1) | না | default 0 | |
| `otp_doc_types` | text | হ্যাঁ |  | |
| `require_read` | tinyint(1) | না | default 0 | |
| `updated_by` | int(11) | হ্যাঁ |  | |
| `updated_at` | datetime | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `email_signed` | tinyint(1) | না | default 0 | |
| `pki_sign` | tinyint(1) | না | default 0 | |

Unique: `uniq_esign_settings_company`(company_id)

## E. Payroll & Salary

বেতন কাঠামো, pay grade, payroll মাস/ব্যাচ, payslip লাইন, bonus, advance/ঋণ, final settlement, payroll দেখার লগ।

### `advance_requests`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `total_amount` | decimal(10,2) | না |  | |
| `monthly_installment` | decimal(10,2) | না |  | |
| `reason` | varchar(255) | হ্যাঁ |  | |
| `status` | enum('pending','approved','rejected','cancelled') | না | default 'pending' | |
| `requested_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `decided_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `decision_remarks` | varchar(255) | হ্যাঁ |  | |
| `advance_id` | int(11) | হ্যাঁ |  | FK → `employee_advances.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `decided_at` | timestamp | হ্যাঁ |  | |
| `chain_status` | varchar(20) | হ্যাঁ |  | |
| `request_kind` | varchar(10) | না | default 'loan' | |
| `installments` | int(11) | হ্যাঁ |  | |

### `final_settlements`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `exit_id` | int(11) | না | UNI  | FK → `exit_requests.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `unused_leave_days` | decimal(6,1) | না | default 0.0 | |
| `unused_leave_encashment` | decimal(12,2) | না | default 0.00 | |
| `gratuity_amount` | decimal(12,2) | না | default 0.00 | |
| `outstanding_dues` | decimal(12,2) | না | default 0.00 | |
| `other_additions` | decimal(12,2) | না | default 0.00 | |
| `other_deductions` | decimal(12,2) | না | default 0.00 | |
| `net_payable` | decimal(12,2) | না | default 0.00 | |
| `notes` | varchar(500) | হ্যাঁ |  | |
| `status` | enum('draft','approved','paid') | না | default 'draft' | |
| `prepared_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `approved_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `paid_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `dues_json` | text | হ্যাঁ |  | |

Unique: `uniq_settlement_exit`(exit_id)

### `pay_grade_components`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `pay_grade_id` | int(11) | না |  | FK → `pay_grades.id` |
| `component_id` | int(11) | না |  | FK → `salary_components.id` |
| `amount` | decimal(10,2) | না | default 0.00 | |

Unique: `unique_grade_component`(pay_grade_id,component_id)

### `pay_grades`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `grade_name` | varchar(100) | না |  | |
| `grade_code` | varchar(20) | হ্যাঁ |  | |
| `basic_salary` | decimal(10,2) | না | default 0.00 | |
| `description` | varchar(255) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `ucompany_unique_grade_name`(company_id,grade_name)

### `payroll_batch_events`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `batch_id` | int(11) | না |  | |
| `action` | varchar(30) | না |  | |
| `user_id` | int(11) | হ্যাঁ |  | logical → `users` |
| `note` | varchar(1000) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `payroll_batches`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `month_year` | varchar(7) | না |  | |
| `status` | enum('draft','submitted','approved','returned','paid') | না | default 'draft' | |
| `submitted_by` | int(11) | হ্যাঁ |  | |
| `submitted_at` | timestamp | হ্যাঁ |  | |
| `audited_by` | int(11) | হ্যাঁ |  | |
| `audited_at` | timestamp | হ্যাঁ |  | |
| `audit_note` | varchar(1000) | হ্যাঁ |  | |
| `paid_by` | int(11) | হ্যাঁ |  | |
| `paid_at` | timestamp | হ্যাঁ |  | |
| `payment_date` | date | হ্যাঁ |  | |
| `payment_method` | varchar(50) | হ্যাঁ |  | |
| `payment_reference` | varchar(150) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

Unique: `uq_payroll_batch`(company_id,month_year)

### `payroll_line_items`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `payroll_id` | int(11) | না |  | FK → `payrolls.id` |
| `employee_id` | int(11) | না |  | logical → `all_employees` |
| `month_year` | varchar(7) | না |  | |
| `source` | enum('pay_item','adjustment') | না |  | |
| `source_id` | int(11) | না |  | |
| `name` | varchar(150) | না |  | |
| `kind` | enum('earning','deduction') | না |  | |
| `amount` | decimal(10,2) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `payroll_payment_splits`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `payroll_id` | int(11) | না |  | FK → `payrolls.id` |
| `account_type` | enum('bank','mfs','cash') | না | default 'bank' | |
| `account_label` | varchar(100) | না |  | |
| `bank_name` | varchar(150) | হ্যাঁ |  | |
| `branch_name` | varchar(150) | হ্যাঁ |  | |
| `provider` | varchar(50) | হ্যাঁ |  | |
| `account_number` | varchar(100) | না |  | |
| `percentage` | decimal(5,2) | না | default 0.00 | |
| `amount` | decimal(10,2) | না | default 0.00 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `payrolls`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `month_year` | varchar(7) | না |  | |
| `total_working_days` | int(11) | না |  | |
| `present_days` | int(11) | না | default 0 | |
| `absent_days` | int(11) | না | default 0 | |
| `leave_days` | int(11) | না | default 0 | |
| `lwp_days` | int(11) | না | default 0 | |
| `overtime_hours` | decimal(5,2) | হ্যাঁ | default 0.00 | |
| `basic_amount` | decimal(10,2) | না | default 0.00 | |
| `allowances_total` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `overtime_amount` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `bonus_amount` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `gross_earned` | decimal(10,2) | না | default 0.00 | |
| `absent_deduction` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `tax_deduction` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `pf_deduction` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `advance_deduction` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `other_deduction` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `total_deduction` | decimal(10,2) | না | default 0.00 | |
| `net_salary` | decimal(10,2) | না | default 0.00 | |
| `payment_status` | enum('unpaid','processed','paid') | হ্যাঁ | default 'unpaid' | |
| `payment_method` | varchar(50) | হ্যাঁ | default 'Bank Transfer' | |
| `remarks` | text | হ্যাঁ |  | |
| `generated_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `paid_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `paid_at` | timestamp | হ্যাঁ |  | |
| `processed_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `late_count` | int(11) | না | default 0 | |
| `late_deduction_days` | int(11) | না | default 0 | |
| `is_held` | tinyint(1) | না | default 0 | |
| `hold_reason` | varchar(255) | হ্যাঁ |  | |
| `held_by` | int(11) | হ্যাঁ |  | |
| `held_at` | datetime | হ্যাঁ |  | |
| `released_by` | int(11) | হ্যাঁ |  | |
| `released_at` | datetime | হ্যাঁ |  | |
| `late_deduction_amount` | decimal(10,2) | না | default 0.00 | |
| `payment_date` | date | হ্যাঁ |  | |
| `payment_reference` | varchar(150) | হ্যাঁ |  | |
| `last_edited_by` | int(11) | হ্যাঁ |  | |
| `item_earnings` | decimal(10,2) | না | default 0.00 | |
| `item_deductions` | decimal(10,2) | না | default 0.00 | |

Unique: `unique_employee_month`(employee_id,month_year)

### `pending_bonuses`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `month_year` | varchar(7) | না |  | |
| `amount` | decimal(10,2) | না |  | |
| `reason` | varchar(255) | হ্যাঁ |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `salary_adjustments`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `kind` | enum('arrear','recovery') | না |  | |
| `for_month` | varchar(7) | না |  | |
| `total_amount` | decimal(10,2) | না |  | |
| `installment_amount` | decimal(10,2) | না |  | |
| `start_month` | varchar(7) | না |  | |
| `reason` | varchar(500) | হ্যাঁ |  | |
| `status` | enum('active','cancelled') | না | default 'active' | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `cancelled_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `cancelled_at` | timestamp | হ্যাঁ |  | |

### `salary_components`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(100) | না |  | |
| `component_type` | enum('earning','deduction') | না |  | |
| `description` | varchar(255) | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `ucompany_unique_component_name`(company_id,name)

### `salary_month_settings`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `start_day` | tinyint(4) | না | default 1 | |
| `effective_month` | char(7) | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `salary_structures`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `employee_id` | int(11) | না |  | FK → `all_employees.id` |
| `basic_salary` | decimal(10,2) | না | default 0.00 | |
| `house_rent` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `medical_allowance` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `conveyance_allowance` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `other_allowance` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `gross_salary` | decimal(10,2) | না | default 0.00 | |
| `tax_deduction` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `pf_deduction` | decimal(10,2) | হ্যাঁ | default 0.00 | |
| `effective_date` | date | না |  | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

## I. Performance, Grievance, Exit, Targets & Tasks

পারফরম্যান্স চক্র, অভিযোগ ও শৃঙ্খলা, পদত্যাগ/ছাড়পত্র, টার্গেট, টাস্ক।

### `case_feedback`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `case_type` | varchar(20) | না |  | |
| `case_id` | int(11) | না |  | |
| `user_id` | int(11) | না |  | logical → `users` |
| `role` | varchar(20) | না |  | |
| `message` | text | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |

### `disciplinary_actions`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `action_type` | enum('verbal_warning','written_warning','show_cause','suspension','termination') | না |  | |
| `reason` | text | না |  | |
| `document_text` | text | হ্যাঁ |  | |
| `issued_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `issued_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `acknowledged` | tinyint(1) | না | default 0 | |
| `acknowledged_at` | timestamp | হ্যাঁ |  | |
| `status` | enum('active','acknowledged','closed') | না | default 'active' | |

### `exit_clearance_approvers`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `department` | varchar(100) | না |  | |
| `approver_user_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `item_label` | varchar(255) | হ্যাঁ |  | |
| `sort_order` | int(11) | না | default 0 | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

Unique: `ucompany_department`(company_id,department)

### `exit_clearance_items`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `exit_id` | int(11) | না |  | FK → `exit_requests.id` |
| `department` | varchar(100) | না |  | |
| `item_label` | varchar(255) | না |  | |
| `is_cleared` | tinyint(1) | না | default 0 | |
| `cleared_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `cleared_at` | timestamp | হ্যাঁ |  | |
| `remarks` | varchar(500) | হ্যাঁ |  | |
| `approver_user_id` | int(11) | হ্যাঁ |  | FK → `users.id` |

### `exit_requests`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `exit_type` | enum('resignation','termination') | না | default 'resignation' | |
| `reason` | text | হ্যাঁ |  | |
| `notice_date` | date | হ্যাঁ |  | |
| `last_working_day` | date | হ্যাঁ |  | |
| `status` | enum('pending','clearance','settled','cancelled') | না | default 'pending' | |
| `requested_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `grievances`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `raised_by` | int(11) | না |  | FK → `users.id` |
| `against_user_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `category` | varchar(100) | হ্যাঁ |  | |
| `description` | text | না |  | |
| `is_anonymous` | tinyint(1) | না | default 0 | |
| `status` | enum('open','investigating','resolved','dismissed') | না | default 'open' | |
| `assigned_to` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `resolution_notes` | text | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `resolved_at` | timestamp | হ্যাঁ |  | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `performance_cycles`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(150) | না |  | |
| `period_start` | date | হ্যাঁ |  | |
| `period_end` | date | হ্যাঁ |  | |
| `status` | enum('draft','active','closed') | না | default 'draft' | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `performance_goals`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `cycle_id` | int(11) | না |  | FK → `performance_cycles.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `title` | varchar(255) | না |  | |
| `description` | text | হ্যাঁ |  | |
| `weight` | decimal(5,2) | না | default 0.00 | |
| `self_rating` | decimal(3,1) | হ্যাঁ |  | |
| `manager_rating` | decimal(3,1) | হ্যাঁ |  | |
| `status` | enum('active','completed') | না | default 'active' | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `performance_reviews`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `cycle_id` | int(11) | না |  | FK → `performance_cycles.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `reviewer_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `overall_rating` | decimal(3,1) | হ্যাঁ |  | |
| `strengths` | text | হ্যাঁ |  | |
| `improvements` | text | হ্যাঁ |  | |
| `status` | enum('pending','submitted','acknowledged') | না | default 'pending' | |
| `submitted_at` | timestamp | হ্যাঁ |  | |
| `acknowledged_at` | timestamp | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `target_task_updates`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `task_id` | int(11) | না |  | FK → `target_tasks.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `from_progress` | int(11) | না | default 0 | |
| `to_progress` | int(11) | না | default 0 | |
| `from_status` | varchar(12) | হ্যাঁ |  | |
| `to_status` | varchar(12) | হ্যাঁ |  | |
| `note` | text | হ্যাঁ |  | |
| `file_name` | varchar(255) | হ্যাঁ |  | |
| `file_mime` | varchar(120) | হ্যাঁ |  | |
| `file_data` | longblob | হ্যাঁ |  | |
| `digested` | tinyint(1) | না | default 0 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `target_tasks`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `target_id` | int(11) | না |  | FK → `targets.id` |
| `sort_order` | int(11) | না | default 0 | |
| `title` | varchar(200) | না |  | |
| `description` | text | হ্যাঁ |  | |
| `due_date` | date | হ্যাঁ |  | |
| `weight` | int(11) | না | default 1 | |
| `progress` | int(11) | না | default 0 | |
| `status` | varchar(12) | না | default 'not_started' | |
| `completed_at` | datetime | হ্যাঁ |  | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `targets`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `department` | varchar(150) | হ্যাঁ |  | |
| `department_id` | int(11) | হ্যাঁ |  | logical → `departments` |
| `period_type` | varchar(10) | না |  | |
| `period` | varchar(7) | না |  | |
| `title` | varchar(200) | না |  | |
| `deadline` | date | না |  | |
| `status` | varchar(12) | না | default 'draft' | |
| `source` | varchar(12) | না | default 'supervisor' | |
| `created_by` | int(11) | না |  | FK → `users.id` |
| `shared_at` | datetime | হ্যাঁ |  | |
| `approved_by` | int(11) | হ্যাঁ |  | |
| `approved_at` | datetime | হ্যাঁ |  | |
| `rejected_by` | int(11) | হ্যাঁ |  | |
| `rejected_at` | datetime | হ্যাঁ |  | |
| `reject_reason` | text | হ্যাঁ |  | |
| `cancelled_by` | int(11) | হ্যাঁ |  | |
| `cancelled_at` | datetime | হ্যাঁ |  | |
| `cancel_reason` | text | হ্যাঁ |  | |
| `closed_by` | int(11) | হ্যাঁ |  | |
| `closed_at` | datetime | হ্যাঁ |  | |
| `copied_from` | int(11) | হ্যাঁ |  | |
| `reminder_stage` | varchar(10) | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |

### `task_assignees`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `task_id` | int(11) | না |  | FK → `tasks.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `assigned_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `uniq_task_assignee`(task_id,user_id)

### `task_comments`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `task_id` | int(11) | না |  | FK → `tasks.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `message` | text | না |  | |
| `kind` | varchar(15) | না | default 'comment' | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `task_recurrences`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `title` | varchar(200) | না |  | |
| `description` | text | হ্যাঁ |  | |
| `category` | varchar(40) | না | default 'general' | |
| `priority` | varchar(10) | না | default 'normal' | |
| `assignee_ids` | varchar(1000) | না |  | |
| `source` | varchar(10) | না | default 'hr' | |
| `department` | varchar(150) | হ্যাঁ |  | |
| `frequency` | varchar(10) | না |  | |
| `weekday` | tinyint(4) | হ্যাঁ |  | |
| `month_day` | tinyint(4) | হ্যাঁ |  | |
| `due_in_days` | int(11) | না | default 0 | |
| `next_run` | date | না |  | |
| `last_run` | date | হ্যাঁ |  | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | না |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

### `tasks`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `title` | varchar(200) | না |  | |
| `description` | text | হ্যাঁ |  | |
| `source` | varchar(10) | না | default 'hr' | |
| `category` | varchar(40) | না | default 'general' | |
| `request_type` | varchar(40) | হ্যাঁ |  | |
| `priority` | varchar(10) | না | default 'normal' | |
| `due_date` | date | হ্যাঁ |  | |
| `department` | varchar(150) | হ্যাঁ |  | |
| `status` | varchar(15) | না | default 'open' | |
| `created_by` | int(11) | না |  | FK → `users.id` |
| `started_at` | datetime | হ্যাঁ |  | |
| `completed_by` | int(11) | হ্যাঁ |  | |
| `completed_at` | datetime | হ্যাঁ |  | |
| `completion_note` | text | হ্যাঁ |  | |
| `cancelled_by` | int(11) | হ্যাঁ |  | |
| `cancelled_at` | datetime | হ্যাঁ |  | |
| `recurrence_id` | int(11) | হ্যাঁ |  | FK → `task_recurrences.id` |
| `reminded_on` | date | হ্যাঁ |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |

## G. Approvals & Alerts

অনুমোদন-চেইনের টেমপ্লেট ও ধাপ, চলমান অনুমোদন (`approval_requests`), নোটিফিকেশন (`alerts`)।

### `alerts`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `type` | varchar(50) | না |  | |
| `title` | varchar(200) | না |  | |
| `message` | text | না |  | |
| `related_type` | varchar(50) | হ্যাঁ |  | |
| `related_id` | int(11) | হ্যাঁ |  | |
| `is_read` | tinyint(1) | না | default 0 | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

### `approval_chain_steps`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `step_order` | int(11) | না | UNI  | |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_step_order`(step_order)

### `approval_requests`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `source_type` | enum('attendance','claim','user_claim','attendance_correction','leave_application','asset_requisition','vehicle_requisition','mobile_limit_request','advance_request') | না |  | |
| `event_type` | enum('check_in','check_out','submit') | না |  | |
| `source_id` | int(11) | না |  | |
| `requested_by` | int(11) | না |  | FK → `users.id` |
| `status` | enum('pending','approved','rejected','returned') | না | default 'pending' | |
| `current_step` | int(11) | না | default 1 | |
| `total_steps` | int(11) | না |  | |
| `actions_json` | mediumtext | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `group_id` | int(11) | না | default 1 | |
| `template_id` | int(11) | হ্যাঁ |  | FK → `approval_templates.id` |
| `supervisor_step_user_id` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `awaiting_approver` | tinyint(1) | না | default 0 | |

### `approval_template_step_approvers`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `step_id` | int(11) | না |  | FK → `approval_template_steps.id` |
| `user_id` | int(11) | না |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |

Unique: `unique_step_user`(step_id,user_id)

### `approval_template_steps`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `template_id` | int(11) | না |  | FK → `approval_templates.id` |
| `step_order` | int(11) | না |  | |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `approver_type` | enum('employee','admin','vehicle_maintainer','asset_fulfiller','conveyance_disburser') | না | default 'employee' | |
| `label` | varchar(100) | হ্যাঁ |  | |

Unique: `unique_template_step_order`(template_id,step_order)

### `approval_templates`

| কলাম | ধরন | Null | মান/কী | সম্পর্ক |
|---|---|---|---|---|
| `id` | int(11) | না | PK auto_increment | |
| `name` | varchar(150) | না |  | |
| `request_type` | enum('conveyance','leave','timesheet','asset','vehicle','mobile','loan') | না |  | |
| `is_default` | tinyint(1) | না | default 0 | |
| `is_active` | tinyint(1) | না | default 1 | |
| `created_by` | int(11) | হ্যাঁ |  | FK → `users.id` |
| `created_at` | timestamp | হ্যাঁ | default current_timestamp() | |
| `updated_at` | timestamp | হ্যাঁ | default current_timestamp() on update current_timestamp() | |
| `company_id` | int(11) | না | default 1 | কোম্পানি-মালিকানা (code-level scope) |
| `skip_auto_supervisor` | tinyint(1) | না | default 0 | |
