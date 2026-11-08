import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    // The build date, shown as the website's version (feedback, Version Info).
    define: { __APP_BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')) },
    build: {
      rollupOptions: {
        output: {
          // Pages are split so each downloads only when opened. Without this
          // Rollup also cut dozens of tiny shared pieces (single icons, small
          // helpers) — each one more request on a phone; pieces under ~20 KB
          // are folded into the chunk that uses them.
          experimentalMinChunkSize: 20_000,
          // Each animation (src/assets/*.json) stays a file of its own, so it
          // is fetched only by the card that shows it (and the merging above
          // can't fold one into a chunk the Home page needs anyway).
          manualChunks(id: string) {
            const m = /[\\/]src[\\/]assets[\\/]([\w-]+)\.json$/.exec(id);
            return m ? `anim-${m[1]}` : undefined;
          },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // The live server answers on its domain through a reverse proxy; when
      // the app runs on the Vite dev server (npm run dev) Vite refuses any
      // Host it doesn't know, so the domain is listed here. (No effect on a
      // production build — npm run build / npm start.)
      allowedHosts: [
        'hr.credencegroupbd.com',
        'localhost',
        '127.0.0.1',
      ],
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify — file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
