import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const commitSha = process.env.PONSWARP_BUILD_SHA ?? (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); } catch { return 'dev'; } })();

export default defineConfig({
  base: './',
  plugins: [react()],
  define: { 'import.meta.env.VITE_COMMIT_SHA': JSON.stringify(commitSha) },
  build: { outDir: 'dist/app', emptyOutDir: true },
  server: {
    proxy: {
      '/ws': { target: 'http://localhost:8787', ws: true }
    }
  }
});
