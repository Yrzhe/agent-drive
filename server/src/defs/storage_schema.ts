import type { BucketDef } from "@sdk/server-types";

export const drive: BucketDef<"drive"> = {
  bucket_name: "drive",
  description: "Agent Drive file storage",
};
