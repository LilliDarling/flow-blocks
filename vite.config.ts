import { defineConfig } from 'vite';

export default defineConfig({
  // 'spa' mode serves index.html as fallback for all non-file routes,
  // so OAuth callback URLs like /auth/google/callback are handled client-side
  appType: 'spa',
});
