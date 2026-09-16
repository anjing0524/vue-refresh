import { defineConfig } from 'vite'
import { httpFixture } from './examples/http-fixture.ts'

export default defineConfig({
  define: { __VUE_OPTIONS_API__: false, __VUE_PROD_DEVTOOLS__: false, __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false },
  plugins: [httpFixture()],
  server: { host: '127.0.0.1', port: 4173, strictPort: true },
})
