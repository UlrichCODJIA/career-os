import { createDatabase } from "../packages/db/src/index.ts";
import { inspectSoakStartCounts } from "./check-soak-start.ts";
import { preflightCountsReady } from "./soak-preflight.ts";

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const database = createDatabase(databaseUrl);
  try {
    const counts = await inspectSoakStartCounts(database);
    console.log(JSON.stringify({
      checkedAt: new Date().toISOString(),
      preflightCountsReady: preflightCountsReady(counts),
      counts,
      note: "Aggregate preflight only; this does not verify release identity or start the soak timer.",
    }));
  } finally {
    await database.close();
  }
}
