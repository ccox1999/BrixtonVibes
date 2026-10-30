# OneDrive recording uploads

**Superseded for the current app:** the user requires no new signup, payment
card, freemium hosting or laptop dependency. Use [Save to OneDrive](onedrive-button.md)
instead. The app now runs its local journal in native-only mode. The backend
below is preserved as an optional design reference, is not deployed, and is
not required or being configured under those constraints.

Implemented, tested with simulated Microsoft/Graph responses, and **not yet connected to a real Microsoft account or deployed**. App registration, owner approval and hosting configuration below are still required. No Microsoft credentials have been created, read or committed by this development cycle.

## Why a small server is necessary here

A normal static single-page app can securely use Microsoft authorization-code login with PKCE without a client secret. Random visitors then receive access only to their own OneDrive, never Cameron's. However, that design necessarily passes a short-lived Microsoft access token through browser JavaScript. It therefore fails the explicit requirement that Microsoft access/refresh tokens must not be exposed in client-side JavaScript. [Microsoft SPA authentication](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/about-msal-browser) and [token caching](https://learn.microsoft.com/en-us/entra/msal/javascript/browser/caching).

The implemented backend keeps all Microsoft tokens on Cloudflare, encrypted in a small D1 database. Browser JavaScript sees only success/failure and a login destination. The browser sends an opaque, random session cookie that is `Secure`, `HttpOnly`, `SameSite=Lax` and restricted to the host. JavaScript cannot read that cookie. This design still needs an ordinary authenticated browser session; it does not promise protection against someone controlling the unlocked phone or malicious changes to deployed app code.

The complete app and its API must be on **one HTTPS origin**. Cross-site cookies between GitHub Pages and a `workers.dev` backend are unreliable on iOS Safari, so that arrangement is deliberately unsupported. Cloudflare Worker static assets host the same public app, with the upload API beside it. The repository remains public, and GitHub Pages continues to work for recording and local backups. Use the Worker URL on the iPhone when automatic upload is wanted. [Cloudflare static assets](https://developers.cloudflare.com/workers/static-assets/binding/).

This is designed for the Cloudflare **Workers Free** and **D1 Free** plans. No paid dependency is introduced, and the expected handful of journeys is comfortably below published free allowances. Free limits and providers can change; if a limit is reached, uploads pause and local recordings remain. [D1 pricing and limits](https://developers.cloudflare.com/d1/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

## Permissions and destination

Only delegated `Files.ReadWrite.AppFolder` is requested for file access, plus `openid profile offline_access` for verified identity and session renewal. No application-wide file permissions, full-drive permissions, public upload links or anonymous write capability are used. Microsoft limits this file permission to the app's special folder. The Worker additionally accepts only the configured Microsoft object ID **and** tenant ID; signing in as another account never creates an upload session. [Microsoft app-folder security](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder), [Microsoft identity claims](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).

The default destination is **OneDrive / Apps / BrixtonVibes**. It is deliberately narrower than arbitrary access to the existing project directory. Each journey is a portable version-3 JSON file named `victoria-recording-RECORDING_ID.json`; retries and later labels replace the same filename rather than creating duplicates. A short interrupted recording is kept locally as a draft and cannot upload until explicitly finished/recovered.

If the app folder must sit inside the existing project directory, first make one test upload, then use OneDrive to move the app folder into `Victoria Line Predictor/BrixtonVibes/Recordings`. Microsoft documents that special-folder addressing follows renamed or moved folders. Verify a second upload reaches the moved folder before relying on it; do not broaden the app's permissions if the account refuses the move. Add downloaded/synced `victoria-recording-*.json` files to Git ignore rules (already included in this project). [Special-folder addressing](https://learn.microsoft.com/en-us/graph/api/drive-get-specialfolder?view=graph-rest-1.0).

## One-time setup through the provider websites

The following steps require the account owner's interactive sign-in. No terminal commands need to be pasted. The build/deploy fields below are settings in Cloudflare's website, not commands the app asks you to run locally.

Microsoft currently lists an Azure account with an active subscription, an Entra tenant, and app-registration rights as prerequisites. It offers a free account; this design creates no Azure compute resources. A personal OneDrive login alone does not guarantee access to app registration. Confirm this prerequisite before creating the Cloudflare resources; if the account cannot register an app, setup remains blocked rather than silently requiring a paid upgrade. [Microsoft registration prerequisites](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app?tabs=client-secret).

1. In [Cloudflare](https://dash.cloudflare.com/), choose the free Workers plan, reserve a Worker named `brixtonvibes`, and note its exact `https://brixtonvibes.YOUR-SUBDOMAIN.workers.dev` origin. Keep this origin consistent throughout setup; do not include a trailing slash. Create a D1 database named `brixtonvibes-auth`, note its database ID, and open its SQL console. Execute the two statements from [`schema.sql`](../onedrive-worker/schema.sql) to create the sessions table and expiry index. No recording samples are stored in D1.

2. In [Microsoft Entra app registrations](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade), register **BrixtonVibes** with **Personal Microsoft accounts only** (for personal OneDrive). Add a **Web** redirect URI, exactly `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/api/onedrive/callback`. This is a confidential web app, **not** an SPA registration. Do not enable implicit access-token or ID-token grants. Authorization-code login requests its ID token through `openid`.

3. Under API permissions, remove the automatically added `User.Read` if present. Add **Microsoft Graph → Delegated permissions → Files.ReadWrite.AppFolder**. Keep application permissions empty. Copy the public **Application (client) ID**. Under Certificates & secrets, create a client secret; copy its **Value** into the Cloudflare secret below, never into GitHub, app JavaScript or this guide. Note its expiry and replace it before that date. [Microsoft registration instructions](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).

4. Obtain the owner's immutable Microsoft object ID. Microsoft documents the Graph user `id` as the same value as the ID-token `oid`. For a personal account, sign in to [Microsoft Graph Explorer](https://developer.microsoft.com/en-us/graph/graph-explorer) as the intended OneDrive owner and run **GET `https://graph.microsoft.com/v1.0/me?$select=id`**. Copy only the returned `id`, never the displayed access token. Graph Explorer's own `User.Read` consent is separate from BrixtonVibes; BrixtonVibes does not request it. Store the value as Cloudflare **ALLOWED_OBJECT_ID**. The personal-account tenant is `9188040d-6c67-4c5b-b112-36a304b66dad`. For a work/school OneDrive, use its actual tenant GUID and register a single-tenant Web app; app-folder availability must be confirmed with that tenant's policy before use.

5. In Cloudflare Worker **Settings → Variables and Secrets**, create these as **Secrets**, not plain public build variables:

   | Secret | Value |
   | --- | --- |
   | `MICROSOFT_CLIENT_SECRET` | The Entra client-secret **Value** |
   | `ALLOWED_OBJECT_ID` | The owner's immutable Microsoft object ID |
   | `TOKEN_ENCRYPTION_KEY` | A fresh 32-byte base64url key |

   Open [`key-generator.html`](../onedrive-worker/key-generator.html) locally to generate the encryption key without sending it anywhere; copy it straight into Cloudflare and close the page. Keep a private recovery copy if wanted. Replacing this key makes existing encrypted sessions unreadable; reconnect OneDrive afterwards. Never store any of these values in a checked-in configuration file.

6. Connect the **public `ccox1999/BrixtonVibes` repository** to Cloudflare Workers Builds. Set the root directory to the repository root. Use the following **Build variables** (these settings are not credentials):

   | Build variable | Value |
   | --- | --- |
   | `ONEDRIVE_APP_ORIGIN` | Exact Worker HTTPS origin, no trailing slash |
   | `ONEDRIVE_DB_ID` | D1 database ID from step 1 |
   | `MICROSOFT_CLIENT_ID` | Entra application/client ID |
   | `ONEDRIVE_WORKER_NAME` | `brixtonvibes`, or the chosen Worker name |
   | `ALLOWED_TENANT_ID` | Optional; defaults to the personal-account tenant above |

   Set the **Build command** field to:

   ```text
   npm --prefix onedrive-worker ci --ignore-scripts && node onedrive-worker/build-assets.mjs && node onedrive-worker/build-config.mjs
   ```

   Set the **Deploy command** field to:

   ```text
   npx wrangler deploy --config onedrive-worker/wrangler.jsonc
   ```

   The build script creates the D1 binding and copies only an explicit list of app assets into `.onedrive-public`; it never copies raw recordings, `.claude` sessions, local environment files or server credentials. `jose` is pinned in a separate backend lockfile and bundled into the server only. Cloudflare's connected Git integration handles deployment authentication; no Cloudflare API key goes into the public repository. Confirm that the three runtime secrets from step 5 remain configured on the deployed Worker. [Cloudflare dashboard deployment](https://developers.cloudflare.com/workers/get-started/dashboard/).

7. Open the Worker app on the iPhone in Safari. Before recording, use **Connect OneDrive**, complete Microsoft's login/consent page, and return to the same Worker app. Make a short test recording, finish, and confirm **Saved on phone and OneDrive** plus the file's presence in OneDrive. Use Safari's **Add to Home Screen** from this Worker URL. Browser and installed-app sessions/storage can differ; connect once in the installed app too if requested. Restore an existing full training backup into the Worker app because local storage is isolated by origin; the GitHub Pages copy's saved journeys do not migrate automatically.

Do not publish from a directory of personal exports. Keep GitHub's existing ignored exports private. Deployment has not been attempted here because the Microsoft registration and Cloudflare account resources do not exist in the supplied environment.

## Runtime behaviour and remaining limits

`onedrive-sync.js` stores full raw samples in a separate IndexedDB journal before attempting any network request. During recording, the app periodically updates the same local draft. Finish marks it complete; any later label updates its revision. A compact metadata store is committed atomically alongside each raw recording: counters, history and upload selection never deserialize the full recording archive during capture. The upload queue retains both successful and pending files locally. A storage failure throws visibly instead of falsely reporting a save. No authentication redirect or new upload starts while recording.

Uploads retry after network failure, online events, app visibility changes and a bounded backoff. The browser queue checks revisions so a label arriving during an upload is not falsely marked uploaded. Deterministic filenames make a retry safe even if OneDrive saved a file but the phone lost the acknowledgement. Expired access tokens renew on the server; revoked/expired refresh sessions pause uploads and ask the owner to reconnect outside recording. Token-service outages preserve the session rather than treating them as logout.

The server verifies Microsoft's signed identity token, issuer, audience, expiry, nonce, owner object ID and tenant before creating a session. Authorization-code login uses PKCE and single-use state, tied to an HttpOnly cookie. Every state-changing browser API request requires the exact app Origin and a custom header; no cross-origin access is granted. Microsoft tokens are AES-GCM encrypted in D1, database session IDs are hashes, and API responses never include Graph tokens or upload-session URLs. The service worker must exclude **all `/api/` requests**, including the OAuth callback, from caching.

Safari can suspend or close a home-screen app. **Background upload after the app is closed is not promised**; keep/reopen it when online to retry. iOS can evict website storage, so local saving is a protection, not an absolute guarantee against device reset, app deletion or storage eviction. Keep OneDrive/manual backups. A crash can lose samples since the last successful autosave, and a storage-full failure requires immediate manual export. The server deliberately limits an individual recording to 12 MB; larger files remain locally available for manual export. No full upload-session protocol is needed for the current few-megabyte journeys. [Graph simple uploads](https://learn.microsoft.com/en-us/graph/api/driveitem-put-content?view=graph-rest-1.0).

## Verification completed in this workspace

`onedrive-sync.test.mjs`: 16 automated checks pass, covering local draft recovery, failed durable saves, network interruption, expired authentication, draft exclusion, idempotent completion, updates during upload, recording-time restrictions, portable backup, metadata-only archive access, encrypted token storage, signed-token validation, unauthorised account rejection, CSRF, server-side refresh, payload limits and logout. `tools/test-journal.mjs` additionally passes real Edge IndexedDB checks for legacy migration, compact metadata, preserved raw samples and rollback of both stores after an interrupted transaction. The Cloudflare Worker passes a deployment dry-run and bundles successfully. **Real Microsoft consent, real OneDrive delivery, Cloudflare deployment and physical iOS Safari authentication remain unverified until the external setup is completed.**
