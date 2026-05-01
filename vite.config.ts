import { defineConfig, Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * Replace `__SW_VERSION__` in the built service worker with a unique-per-build
 * string. Ensures the `sw.js` bytes change on every deploy so the browser's
 * service-worker update detection fires and stale caches are evicted.
 */
function swVersionPlugin(): Plugin {
  return {
    name: 'sw-version',
    apply: 'build',
    closeBundle() {
      const swPath = resolve(__dirname, 'dist/sw.js');
      if (!existsSync(swPath)) return;

      // Read pkg version once so the stamp includes semver + build time.
      let pkgVersion = 'unknown';
      try {
        const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'));
        pkgVersion = pkg.version || 'unknown';
      } catch {
        // keep default
      }

      const stamp = `wildbloom-${pkgVersion}-${Date.now()}`;
      const content = readFileSync(swPath, 'utf-8').replace(/__SW_VERSION__/g, stamp);
      writeFileSync(swPath, content);
      console.log(`[sw-version] Stamped service worker: ${stamp}`);
    },
  };
}

export default defineConfig({
  // 'spa' mode serves index.html as fallback for all non-file routes,
  // so OAuth callback URLs like /auth/google/callback are handled client-side
  appType: 'spa',
  plugins: [tailwindcss(), swVersionPlugin()],
  build: {
    // Explicit (matches Vite default) — keeps source maps OUT of production
    // bundles so business logic, variable names, and comments aren't shipped
    // to end users. If Sentry/error-tracking is ever wired up, switch to
    // 'hidden' so maps are generated for upload but not referenced from JS.
    sourcemap: false,
  },
});
