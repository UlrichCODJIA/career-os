import { migrate } from "../packages/db/src/migrations.ts";

const result = await migrate();
console.log(
  result.applied.length > 0
    ? `Applied ${result.applied.length} migration(s): ${result.applied.join(", ")}`
    : `Schema is current (${result.alreadyApplied.length} migration(s) verified).`,
);
