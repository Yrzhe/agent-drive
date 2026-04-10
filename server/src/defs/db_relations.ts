/**
 * Database Relations
 *
 * Define app-level Drizzle ORM relations here.
 *
 * Notes:
 * - Relations help Drizzle with typed joins and nested query shapes at runtime.
 * - Relation-only edits usually do not change generated migration SQL.
 * - You can split relations across multiple files, but re-export them here.
 */

import { relations } from "drizzle-orm";

// Example relation — uncomment after you have matching tables/foreign keys:
//
// import { users, posts } from "./db_schema";
//
// export const postsRelations = relations(posts, ({ one }) => ({
//   author: one(users, {
//     fields: [posts.authorId],
//     references: [users.id],
//   }),
// }));
