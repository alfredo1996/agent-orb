import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm --filter @agent-orb/studio dev` proxies /stream to the local server; `build` writes dist/, which the server serves at /.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { '/stream': 'http://127.0.0.1:4040' } },
});
