import { fileURLToPath } from 'node:url'
import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../vitest.shared.ts'

const baseTsconfig = fileURLToPath(new URL('../../tsconfig.base.json', import.meta.url))

// Resolves workspace packages from source, like the repository's root vitest config.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: [baseTsconfig] }), standardDecoratorPlugin()],
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
