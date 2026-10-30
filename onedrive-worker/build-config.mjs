// Reads nonsecret deployment settings only. Never copies OAuth/token secrets.
import { writeFile } from "node:fs/promises";
const required = ["ONEDRIVE_APP_ORIGIN", "ONEDRIVE_DB_ID", "MICROSOFT_CLIENT_ID"];
for (const name of required) if (!process.env[name]) throw new Error(`Set ${name} in Cloudflare Build variables before deploying`);
const origin = new URL(process.env.ONEDRIVE_APP_ORIGIN);
if (origin.protocol !== "https:" || origin.origin !== process.env.ONEDRIVE_APP_ORIGIN) throw new Error("ONEDRIVE_APP_ORIGIN must be an HTTPS origin with no trailing slash");
const config = {
  name: process.env.ONEDRIVE_WORKER_NAME || "brixtonvibes",
  main: "worker.mjs", compatibility_date: "2026-10-30",
  assets: { directory: "../.onedrive-public", binding: "ASSETS", run_worker_first: ["/api/*"] },
  triggers: { crons: ["17 3 * * 0"] },
  vars: { APP_ORIGIN: origin.origin, MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID, ALLOWED_TENANT_ID: process.env.ALLOWED_TENANT_ID || "9188040d-6c67-4c5b-b112-36a304b66dad" },
  d1_databases: [{ binding: "DB", database_name: "brixtonvibes-auth", database_id: process.env.ONEDRIVE_DB_ID }]
};
await writeFile(new URL("wrangler.jsonc", import.meta.url), JSON.stringify(config, null, 2));
console.log("Created worker deployment settings; no secrets written to files.");
