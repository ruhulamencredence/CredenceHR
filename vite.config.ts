import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // Allowed hosts for subdomains and reverse proxy
      allowedHosts: [
        'hr.credencehousinglimited.com',
        'localhost',
        '127.0.0.1',
      ],
      // অথবা যেকোনো হোস্ট এলাউ করতে চাইলে নিচের লাইনটি ব্যবহার করতে পারেন:
      // allowedHosts: true,

      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});