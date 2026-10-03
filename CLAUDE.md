# CredenceHR — working rules

## Every new feature is permission-gated

Anything added to any interface — a new module, page, tab, report, sub-view,
button or API route — must be behind a permission from the day it is created.
Nothing new may be visible or usable just because an account can open the
surrounding page.

- **Admin Panel module** — add its key to `ADMIN_MODULE_KEYS` (server.ts) and
  `ADMIN_MODULES` (src/types.ts) so it appears in Admin Panel -> Users ->
  Module Access; guard every API route with `requireModule("<key>")`; show the
  sidebar item / tab only through `canSeeModule` / `canSee`.
- **Part of an existing module** (a second report, an extra view, a sensitive
  action) — give it its own permission layer: add the key to the module's
  layer set (`MODULE_LAYER_KEY_SETS` in server.ts, `MODULE_LAYER_OPTIONS` in
  src/types.ts), check it with `requireModuleLayer(...)` on the API and with
  the module's layer helper in the UI. A new layer that grants more than
  plain reading goes in `EXPLICIT_ONLY_LAYERS` (src/types.ts) and is left out
  of the server's no-saved-layers default, so existing accounts don't get it
  without being ticked.
- **Self Service feature** — an off-by-default per-account switch
  (`users.can_view_*`, toggled in Module Access), checked on the API and in
  the menu.
- A Superadmin always has access. Hide the UI *and* block the API — never
  only one of them.
