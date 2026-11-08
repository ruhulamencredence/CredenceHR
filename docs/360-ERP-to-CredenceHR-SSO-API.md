# 360 ERP → CredenceHR sign-in (SSO) — API for the 360 ERP team

The mirror image of 360 ERP's own partner SSO (`POST /api/v1/service/sso/initiate`).
360 ERP's **server** asks CredenceHR for a one-time link and sends the person's browser to it.
Never call this from a browser — the App Secret must stay on the server.

## Credentials

CredenceHR Superadmin: Admin Panel → Active Users → **360 ERP sign-in** → *Make credentials for 360 ERP*.
You get an **App ID** and an **App Secret** (64 characters, shown once). Optionally the Superadmin
locks it to 360 ERP's server IP(s). A lost secret is replaced with *New secret* (the old one stops at once).

## 1. Ask for a link

```
POST https://hr.credencegroupbd.com/api/v1/service/sso/initiate
X-App-Id: erp360_xxxxxxxxxxxxxxxx
X-App-Secret: <64-character secret>
Content-Type: application/json
Accept: application/json

{
  "email": "someone@credencehousinglimited.com",   // required — login email or office email
  "employee_id": "CPL-0101",                       // required — must be the same person
  "name": "Someone",                               // optional, not used for matching
  "request_ip": "103.x.x.x",                       // optional — the person's IP, logged
  "redirect_path": "/"                             // optional — CredenceHR always opens the Dashboard
}
```

HTTPS only.

### Answers

| HTTP | Body | When |
|---|---|---|
| 200 | `{ "forward_url": "https://hr.credencegroupbd.com/sso/consume/<64 hex>", "expires_in": 120 }` | Link made |
| 401 | `{ "message": "Missing app credentials." }` / `"Invalid app credentials."` / `"This app is switched off."` | Credentials |
| 403 | `{ "message": "HTTPS is required." }` / `"This IP address is not allowed."` / `"This app may not use this route."` | Guard |
| 422 | `{ "message": "...", "errors": { "email": [...], "employee_id": [...] } }` | Missing field, no account with BOTH this email and employee ID, employee not active, account blocked |
| 429 | `{ "message": "Too many requests. Try again in a minute." }` | Per-minute limit (60 by default) |
| 500 | `{ "message": "Something went wrong. Please try again." }` | Unexpected |

Every call, refused ones too, is logged on CredenceHR's side (`api_access_logs`).

## 2. Send the browser to `forward_url`

Open it in a new tab (or redirect). The link works **once**, within `expires_in` seconds (120 by default).
CredenceHR signs the person in with the same checks as a password sign-in and opens the Dashboard;
an expired, used or refused link shows the reason and the normal sign-in.

On an Android phone the page offers **Open in the CredenceHR app** (if installed) or **Continue in the browser**.

## Example (PHP / Laravel)

```php
$res = Http::withHeaders([
    'X-App-Id' => config('services.credencehr.app_id'),
    'X-App-Secret' => config('services.credencehr.secret'),
])->acceptJson()->post('https://hr.credencegroupbd.com/api/v1/service/sso/initiate', [
    'email' => $user->email,
    'employee_id' => $user->employee_id,
    'name' => $user->name,
    'request_ip' => request()->ip(),
]);
if ($res->ok()) return redirect()->away($res->json('forward_url'));
return back()->withErrors($res->json('message') ?? 'CredenceHR sign-in failed');
```
