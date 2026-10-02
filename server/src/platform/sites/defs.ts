export * from "../../defs/db_schema";
export * from "../../defs/db_relations";
export * from "./schema";
export type { VarKey, SecretKey } from "../../defs/runtime";
import * as appSchema from "../../defs/db_schema";
import * as siteSchema from "./schema";
import * as buckets from "../../defs/storage_schema";
export { buckets };
export const drizzleSchema = { ...appSchema, ...siteSchema };
