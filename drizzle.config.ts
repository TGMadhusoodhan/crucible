import { defineConfig } from 'drizzle-kit'
import path from 'path'

const dataDir = process.env.DATA_DIR ?? './data'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: path.join(dataDir, 'crucible.db'),
  },
})
