import { sql } from 'drizzle-orm'
import { boolean, check, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    plan: text('plan').notNull().default('free'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    clerkUserId: text('clerk_user_id').notNull().unique(),
  },
  (table) => [
    check('plan_check', sql`${table.plan} IN ('free', 'indie', 'pro', 'team')`),
  ],
)

export const apiCredentials = pgTable(
  'api_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    encryptedKey: text('encrypted_key').notNull(),
    isValid: boolean('is_valid').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('api_credentials_user_provider_unique').on(table.userId, table.provider),
  ],
)

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type ApiCredential = typeof apiCredentials.$inferSelect
export type NewApiCredential = typeof apiCredentials.$inferInsert
