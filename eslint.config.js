import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

/**
 * The product is a backend API. Linting covers the server sources and the local
 * smart-routing package; there is no web application in this repository.
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
])
