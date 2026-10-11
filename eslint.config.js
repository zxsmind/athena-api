import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * The product is a server API plus the browser console that drives it: the
 * server and the local smart-routing package are linted as Node sources, the
 * web console as browser sources, and nothing else.
 */
export default defineConfig([
  globalIgnores(['dist', 'node_modules', 'server/dist', 'server/data', 'server/smart-routing-core/dist']),
  {
    files: ['server/src/**/*.ts', 'server/tests/**/*.ts', 'smart-routing-core/src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser },
    },
  },
])
