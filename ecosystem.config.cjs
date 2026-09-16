// PM2 cluster-mode config — runs multiple copies of the built server
// (dist/server.cjs, see package.json's "build" script) across CPU cores on
// this one machine, behind a single shared port (Node's built-in `cluster`
// module, which PM2 uses under the hood in exec_mode: 'cluster', accepts
// connections on one port and hands each one to a free worker — the
// EADDRINUSE port-fallback in server.ts's startListening() never triggers
// here, that's only a dev convenience for a single `npm run dev`).
//
// REDIS_URL is required once `instances` is more than 1: server.ts's
// Socket.IO Redis adapter only activates when it's set — without it, chat
// (messages/rooms/presence) only broadcasts within whichever single worker
// a given socket happened to land on. Point it at a real Redis instance
// (a local `redis-server`, or a managed one) before going to cluster mode
// in production. See server.ts around `new SocketIOServer` for the adapter
// wiring itself.
//
// Usage: npm run pm2:start (first run) / npm run pm2:reload (zero-downtime
// deploy of a new build) / npm run pm2:stop / npm run pm2:logs.
module.exports = {
  apps: [
    {
      name: 'credencehr',
      script: 'dist/server.cjs',
      exec_mode: 'cluster',
      // 'max' uses every CPU core; pin an explicit number (e.g. 2) instead
      // if this machine also runs MySQL/Redis/etc. and needs headroom left
      // for them. Each worker gets its own MySQL pool (see server.ts —
      // connectionLimit: 30), so raise MySQL's own max_connections to
      // comfortably cover instances * 30 once instances > 1.
      instances: 'max',
      // Restarts a worker that leaks past this instead of letting it
      // degrade the whole cluster silently.
      max_memory_restart: '500M',
      // Zero-downtime reload: wait for the new worker to actually report
      // ready before killing the old one, and give in-flight requests time
      // to finish instead of being cut off mid-response.
      wait_ready: false,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production'
        // PORT: 3000,                          // defaults to 3000 (server.ts) if unset
        // REDIS_URL: 'redis://127.0.0.1:6379'   // required once instances > 1 — see comment above
      }
    }
  ]
};
