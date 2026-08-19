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
  },
})
