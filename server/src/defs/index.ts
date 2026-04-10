// !! BARREL FILE — exports only, no logic !!
//
// Wires all definitions into the EdgeSpark framework bundle.
// Path: src/defs/index.ts (convention — do not move or rename)
//
// REQUIRED EXPORTS (framework depends on these — do not remove):
//   drizzleSchema  — merged tables + relations for Drizzle ORM initialization
//   buckets        — storage bucket definitions for R2 operations
//   VarKey         — typed runtime var key union for VarClient
//   SecretKey      — typed runtime secret key union for SecretClient
//
// HOW TO ORGANIZE APP TABLES AND RELATIONS:
//   1. Create your files in src/defs/ (e.g., src/defs/posts_schema.ts, src/defs/posts_relations.ts)
//   2. Re-export table definitions from src/defs/db_schema.ts
//   3. Re-export relation definitions from src/defs/db_relations.ts
//   4. This barrel merges app schema + app relations + generated system schema
//
// DO NOT:
//   - Delete or rename this file
//   - Remove drizzleSchema or buckets exports
//   - Edit files under __generated__/ (managed by edgespark pull schema)

// User tables
export * from "./db_schema";
// User app relations
export * from "./db_relations";

// System tables (pulled — do not edit)
export * from "../__generated__/sys_schema";

// System relations (pulled — do not edit)
export * from "../__generated__/sys_relations";

// Storage buckets
import * as buckets from "./storage_schema";
export { buckets };

// Runtime input key types (vars + secrets)
export type { VarKey, SecretKey } from "./runtime";

// Drizzle ORM schema (all tables + relations merged)
import * as _user from "./db_schema";
import * as _userRels from "./db_relations";
import * as _system from "../__generated__/sys_schema";
import * as _systemRels from "../__generated__/sys_relations";
export const drizzleSchema = { ..._user, ..._userRels, ..._system, ..._systemRels };
