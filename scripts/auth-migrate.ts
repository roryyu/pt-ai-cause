import {readFile} from "node:fs/promises";
try { process.loadEnvFile(); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
const {prisma} = await import("../lib/db");
// Additive and idempotent; keep the existing business tables and legacy sessions.
const source=await readFile(new URL("../prisma/migrations/20261009_shared_auth/migration.sql",import.meta.url),"utf8");
try {
  await prisma.$transaction(async db=>{
    for(const statement of source.split(";").map(s=>s.trim()).filter(s=>s && s!=="BEGIN" && s!=="COMMIT")) await db.$executeRawUnsafe(statement);
  }, {maxWait:10000,timeout:60000});
  console.log("Cause shared authentication schema ready (data preserved)");
}finally {await prisma.$disconnect();}
