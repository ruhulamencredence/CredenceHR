# "We'll be right back" page (instead of nginx's 502 Bad Gateway)

While the Node app is restarting (a deploy, `pm2 restart`, a crash) nginx
cannot reach it and shows its own plain **502 Bad Gateway**. With the block
below it shows `credence-down.html` instead: the CredenceHR icon on the app's
orange screen, English + Bangla text, and it **reloads by itself** as soon as
the app answers again (it checks every 5 seconds; "Try again" checks at once).
nginx serves the file from disk, so it works with the app fully down — the
icon is inside the file, nothing else is loaded.

App calls (`/api/...`, `/socket.io/...`) get a short JSON error instead of
the page, so the app's own error handling still works.

## Laragon (Windows) — hr.credencegroupbd.com

1. The page is already in the repo: `deploy/error-pages/credence-down.html`.
   Point nginx at that folder (it then updates with every deploy), or copy
   the file to e.g. `D:/laragon/www/credence-errors/`.
2. In `hr.credencegroupbd.com.conf`, inside the `server { listen 443 ssl; ... }`
   block, after the `location / { ... }` block, add (change the `root` path
   to where the file is — forward slashes, in quotes):

```nginx
    # CredenceHR: our own page instead of nginx's "502 Bad Gateway"
    # while the app is restarting (deploy/error-pages/README.md).
    error_page 502 503 504 @credence_down;
    location @credence_down {
        root "D:/laragon/www/CredenceHR/deploy/error-pages";
        default_type application/json;
        add_header Cache-Control "no-store" always;
        if ($uri ~ ^/(api|socket\.io)/) {
            return 503 '{"error":"CredenceHR is restarting. Try again in a moment."}';
        }
        rewrite ^ /credence-down.html break;
    }
```

3. Laragon → Menu → Nginx → Reload (or `nginx -t` then `nginx -s reload`).
4. Check: stop the app for a moment (`pm2 stop all`), open the site — the page
   shows; `pm2 start all` — it opens the app by itself within a few seconds.

The status code stays 502 (search engines and monitors still see "down");
only what people see changes. Tested with nginx 1.24.
