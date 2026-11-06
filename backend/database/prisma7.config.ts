import { fileURLToPath } from "node:url";

import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({
  path: fileURLToPath(new URL("../../.env", import.meta.url)),
  override: false,
});

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
