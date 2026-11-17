# Test log — 17 November 2026

## Credence Mail → My folders (own folders and sub-folders, real IMAP folders)

People could not make folders (only the fixed Inbox / Sent / … and rule labels). Now, as part of Credence Mail
(whoever has Mail has folders — no switch of their own, as the owner asked): "+ New folder", sub-folders, rename,
delete, "Move to folder" (toolbar / reader / drag), rules that file into a folder — all as real folders on the mail
server, so Outlook and the phone's mail app show the same folders.

Test setup (this environment only): Dovecot IMAP on 127.0.0.1:143 (`apt-get install dovecot-imapd`, plain login,
maildir; user `qa.mail@credence.test` / `MailPass123`) and a small SMTP stub on :2525 so a mailbox can be connected.
Every step is checked on the IMAP server itself (`imapflow`), the way Outlook / a phone sees it.

- `scripts/mail-folders-api.mjs`: **36/36** — mailbox connected, 3 mails synced; no Mail → `GET /folders` 403 and
  can't create; Mail on → folders on (`canFolders`, 200) with no extra switch; someone else's mailbox → 404; Superadmin
  `canFolders`; "Projects" and "Projects/Gulshan Tower" made on the server and subscribed;
  same name twice / "a/b" / "Sent" at the top → 400; 2 mails moved → server 2 in the folder, 1 in INBOX; the folder
  lists 2, counts 2 / 2 unread; read in the folder → `\Seen` on the server; a folder made straight on the server
  ("Outlook") appears and its mail syncs; rename Projects → Sites: server `Sites/Gulshan Tower`, same folder id, its
  mail still listed; a rule "from steel.test → Vendors" moves a new mail to Vendors on the server; back to Inbox;
  delete Sites + sub-folder → folders gone on the server, all mail back in INBOX (none deleted); Delete from a folder.
- `scripts/mail-folders-prefix.mjs`: **6/6** — the same on a cPanel-style server (Dovecot namespace `INBOX.` with
  `.`): paths `INBOX.Projects` / `INBOX.Projects.Gulshan Tower`, "a.b" refused, tree from the server, move, rename keeps
  the prefix, delete.
- `scripts/mail-folders-ui.cjs`: **15/15** (computer) — "Folders" + "New folder"; New folder → on the server; "⋯" →
  New sub-folder with "Inside" already set; tree; tick + "Move to folder" → on the server; drag a mail onto the folder →
  on the server; open the folder (title = path, its 2 mails, Inbox mail not there); reader "Move to folder"; Rename;
  Delete (red confirm "no mail is deleted") → folders gone, mail back in INBOX, screen back on Inbox; no page errors.
- `scripts/mail-folders-outside.mjs`: **5/5** — sub-folders made outside CredenceHR (straight on the IMAP server, as
  Outlook / cPanel webmail do), two levels deep: all appear, nested the same way (Clients > ABC Ltd > Invoices); their
  mail comes in when the folder is synced; renamed and deleted there → followed here.

Fixed while testing: the folder's "⋯" menu was trapped inside the glass sidebar (couldn't be clicked) → drawn in a
portal like the other popups.
