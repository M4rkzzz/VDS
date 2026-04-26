import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  root: __dirname,
  base: '/vds_web/',
  build: {
    outDir: path.resolve(__dirname, '../server/public/vds_web'),
    emptyOutDir: true,
    sourcemap: true
  }
});
