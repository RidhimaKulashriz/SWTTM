import { sql } from "drizzle-orm";
import { health } from "@/server/service";

export const dynamic = "force-dynamic";

export async function GET() {
  let database = false;
  try {
    const { db } = await import("@/db");
    await db.execute(sql`select 1`);
    database = true;
  } catch {
    database = false;
  }
  const status = health();
  return Response.json({
    ...status,
    database,
    services: { ...status.services, postgres: database },
    github: { ...status.github, ready: status.github.ready && database },
  });
}
