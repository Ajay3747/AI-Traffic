import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'

// https://vite.dev/config/
export default defineConfig({
  // Self-signed HTTPS: browsers (Chrome/Android in particular) block
  // navigator.geolocation on plain http:// unless the host is localhost.
  // The ambulance page is opened from a phone over LAN, so it needs a real
  // https:// origin to be allowed to prompt for GPS permission at all.
  plugins: [react(), tailwindcss(), basicSsl()],
  server: {
    https: true,
    host: true,
    // Forward /api to the Express backend's plain-HTTP listener (5001).
    // This proxying happens server-to-server (Vite -> Express on the same
    // machine), so it never touches the backend's self-signed HTTPS cert
    // at all -- the phone only ever has to trust ONE cert (this dev
    // server's, on 5173) instead of two.
    proxy: {
      '/api': {
        target: 'http://localhost:5001',
        changeOrigin: true,
      },
    },
  },
})
