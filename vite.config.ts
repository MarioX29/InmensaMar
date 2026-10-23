import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// A fresh build identifier allows installed PWAs to detect new deployments.
const buildId = new Date().toISOString();
const buildVersion = (): Plugin => ({
  name: 'inmensa-mar-build-version',
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'version.json',
      source: JSON.stringify({ buildId })
    });
  }
});

export default defineConfig({
  plugins: [react(), buildVersion()],
  define: { __APP_BUILD_ID__: JSON.stringify(buildId) }
});
