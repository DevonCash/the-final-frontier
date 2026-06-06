import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// Engine is consumed from source (sibling checkout) so engine changes are
// picked up without a publish/build step while the two evolve together.
const rlkit = fileURLToPath(new URL('../rlkit/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: { alias: { rlkit } },
  server: { port: 5180, strictPort: true },
});
