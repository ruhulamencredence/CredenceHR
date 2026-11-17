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
- `scripts/mail-folders-sent-tree.mjs`: **11/11** — the owner's real Roundcube layout on a cPanel-style server: Sent ▸
  "Daily & Market Labor Actual Report" ▸ CDW, RPRT, Zone-1/3/4/5 and Sent ▸ Monthly Reports ▸ 7 folders. Sent is a heading
  (opens Sent, can't be renamed / deleted — 400), both report folders inside it, the name with "&" kept, every sub-folder
  in its place; Junk / Trash / Drafts with nothing inside not repeated; Roundcube's Archive shows as a folder and its mail
  comes in; Monthly Reports ▸ Zone-1's mail comes in (the list shows "To: …" like Sent); a new Zone-6 made from here lands
  at `INBOX.Sent.Monthly Reports.Zone-6`. Before this fix those folders would have come in loose (not under Sent) and
  Archive not at all.
- `scripts/mail-folders-older-bg.cjs`: **8/8** — the three limits removed. Older mail: a folder with 250 mails brings the
  latest 200 first, "Older mail from the server" the other 50 (0 left; again → nothing more), the very first mail is there;
  Inbox the same (200 → 210). Background: with the mail page open, a folder nobody opened came in by itself, and a mail
  filed straight into a folder on the server (an Outlook rule) came in by itself after 302 s — nobody opened the folder.
  On screen: long names wrap ("Daily & Market Labor Actual Report" in full), the button sits at the end of the list.

Fixed while testing: the folder's "⋯" menu was trapped inside the glass sidebar (couldn't be clicked) → drawn in a
portal like the other popups.

## Light Glass on a phone: the slide-in menu no longer washed out

Light Glass + the orange theme: the phone menu was 35–55 % white, so the orange header and cards behind it showed
through and the text looked faded. Now (`src/index.css`, `html[data-lglass] .gsidebar.fixed`, phone menu only — the
computer sidebar is as before) it is nearly solid frosted white (94 % → 92 %), with a short accent-coloured band at the
top so the white Credence logo stays visible, a thin edge and a soft shadow.

- `scripts/lightglass-phone-menu.cjs` (Pixel 7, Light Glass, orange): screenshot before / after — menu text dark on
  white, the page behind no longer showing through, logo on the accent band.

