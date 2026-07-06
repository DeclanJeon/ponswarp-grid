import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist/app', emptyOutDir: true },
  server: {
    proxy: {
      '/ws': { target: 'http://localhost:8787', ws: true }
    }
  }
});
