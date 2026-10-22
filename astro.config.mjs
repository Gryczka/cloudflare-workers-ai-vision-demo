// @ts-check
import { defineConfig } from 'astro/config';

import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  // `remoteBindings` tells the Astro Cloudflare adapter whether to proxy
  // bindings declared as `"remote": true` in wrangler.jsonc straight through
  // to Cloudflare's real services during local development (instead of trying
  // to emulate them locally). Workers AI has no local emulator — if you set
  // this `false`, `env.AI.run(...)` errors with "Binding AI needs to be run
  // remotely" from Vite.
  adapter: cloudflare({
    remoteBindings: true
  })
});
