/* Same-origin backend-for-frontend. Microsoft tokens are encrypted in D1 and
 * never returned to browser code. Deploy with static assets on the SAME origin. */
import { createRemoteJWKSet, jwtVerify } from "jose";

const GRAPH = "https://graph.microsoft.com/v1.0";
const PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
const SCOPE = "openid profile offline_access https://graph.microsoft.com/Files.ReadWrite.AppFolder";
const MAX_UPLOAD = 12 * 1024 * 1024;
const SESSION_SECONDS = 30 * 86400;
const enc = new TextEncoder();
const dec = new TextDecoder();
const microsoftKeys = createRemoteJWKSet(new URL("https://login.microsoftonline.com/common/discovery/v2.0/keys"));
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", ...headers } });
const b64 = value => {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 32768) binary += String.fromCharCode(...value.subarray(offset, offset + 32768));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = value => Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
const random = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const hash = async value => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
const cookie = (name, value, age) => `${name}=${value}; Path=/; Max-Age=${age}; Secure; HttpOnly; SameSite=Lax`;
function readCookie(request, name) { return request.headers.get("Cookie")?.split(";").map(x => x.trim()).find(x => x.startsWith(`${name}=`))?.slice(name.length + 1) || ""; }
function configured(env) { return !!(env.DB && env.APP_ORIGIN && env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET && env.TOKEN_ENCRYPTION_KEY && env.ALLOWED_OBJECT_ID); }
function tenant(env) { return env.ALLOWED_TENANT_ID || PERSONAL_TENANT; }
function authority(env) { return `https://login.microsoftonline.com/${tenant(env) === PERSONAL_TENANT ? "consumers" : tenant(env)}/oauth2/v2.0`; }
function callbackUri(env) { return `${env.APP_ORIGIN}/api/onedrive/callback`; }
export function validateOwner(claims, env) {
  return typeof claims?.oid === "string" && typeof claims.tid === "string" && claims.oid.toLowerCase() === env.ALLOWED_OBJECT_ID?.toLowerCase() && claims.tid.toLowerCase() === tenant(env).toLowerCase();
}
export async function verifyMicrosoftIdToken(token, env, keys = microsoftKeys) {
  return (await jwtVerify(token, keys, { algorithms: ["RS256"], audience: env.MICROSOFT_CLIENT_ID, issuer: `https://login.microsoftonline.com/${tenant(env)}/v2.0`, clockTolerance: 30, requiredClaims: ["exp", "iat", "sub", "oid", "tid", "nonce"] })).payload;
}
export function checkMutation(request, env) {
  return request.headers.get("Origin") === env.APP_ORIGIN && request.headers.get("X-BrixtonVibes") === "1" && !["cross-site", "same-site"].includes(request.headers.get("Sec-Fetch-Site"));
}
async function key(env) {
  const bytes = unb64(env.TOKEN_ENCRYPTION_KEY);
  if (bytes.length !== 32) throw new Error("Encryption key must contain exactly 32 random bytes");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function seal(value, env) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), enc.encode(JSON.stringify(value))));
  // Chunk conversion avoids argument-count overflow for token payloads.
  return `${b64(iv)}.${b64(encrypted)}`;
}
export async function unseal(value, env) {
  const [iv, ciphertext] = value.split(".");
  return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(env), unb64(ciphertext))));
}
async function saveSecret(env, id, kind, value, expires) {
  await env.DB.prepare("INSERT OR REPLACE INTO sessions (id,kind,secret,expires) VALUES (?,?,?,?)").bind(await hash(id), kind, await seal(value, env), expires).run();
}
async function loadSecret(env, id, kind) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  const row = await env.DB.prepare("SELECT secret,expires FROM sessions WHERE id=? AND kind=? AND expires>?").bind(await hash(id), kind, Date.now()).first();
  return row ? { ...(await unseal(row.secret, env)), sessionExpires: row.expires } : null;
}
async function removeSecret(env, id) {
  if (id) await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(await hash(id)).run();
}
async function tokenRequest(env, parameters, fetchImpl) {
  const response = await fetchImpl(`${authority(env)}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: env.MICROSOFT_CLIENT_ID, client_secret: env.MICROSOFT_CLIENT_SECRET, scope: SCOPE, ...parameters }) });
  const value = await response.json();
  if (!response.ok || !value.access_token) {
    const transient = response.status === 429 || response.status >= 500;
    const err = new Error(transient ? "Microsoft sign-in service temporarily unavailable" : "Microsoft sign-in needs renewing");
    err.status = transient ? 503 : 401; throw err;
  }
  if (!(value.scope || "").split(" ").some(s => s.toLowerCase().endsWith("files.readwrite.appfolder"))) throw new Error("App-folder permission was not granted");
  return value;
}
async function graphToken(env, sessionId, session, fetchImpl, force = false) {
  if (!force && session.accessExpires > Date.now() + 60000) return session.accessToken;
  try {
    const tokens = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: session.refreshToken }, fetchImpl);
    Object.assign(session, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token || session.refreshToken, accessExpires: Date.now() + tokens.expires_in * 1000 });
    await saveSecret(env, sessionId, "session", session, session.sessionExpires);
    return session.accessToken;
  } catch (e) { if (e.status === 401) await removeSecret(env, sessionId); throw e; }
}
export function validateRecording(value, id) {
  const ex = value?.examples?.[0];
  return value?.version === 3 && value.complete === true && value.recordingId === id && Array.isArray(value.examples) && value.examples.length === 1 && ex?.recordingId === id && ex.complete !== false && Array.isArray(ex.rawMotionData) && ex.rawMotionData.length > 0 && ex.rawMotionData.length <= 250000 && ex.rawMotionData.every(sample => sample && typeof sample === "object" && !Array.isArray(sample) && Number.isFinite(sample.time));
}

export async function handleRequest(request, env, { fetchImpl = fetch, verifyIdToken } = {}) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith("/api/onedrive/")) return env.ASSETS ? env.ASSETS.fetch(request) : new Response("Not found", { status: 404 });
  if (url.origin !== env.APP_ORIGIN && env.APP_ORIGIN) return json({ error: "Unexpected origin" }, 403);
  if (path === "/api/onedrive/status" && request.method === "GET") {
    if (!configured(env)) return json({ configured: false, authenticated: false });
    const session = await loadSecret(env, readCookie(request, "__Host-bv_session"), "session");
    return json({ configured: true, authenticated: !!session && validateOwner(session.owner, env) });
  }
  if (!configured(env)) return json({ error: "OneDrive needs external account configuration" }, 503);
  if (path === "/api/onedrive/callback" && request.method === "GET") {
    const state = url.searchParams.get("state") || "";
    const pendingCookie = readCookie(request, "__Host-bv_oauth");
    const pending = await loadSecret(env, pendingCookie, "oauth");
    if (!pending || state !== pending.state || !url.searchParams.get("code")) return json({ error: "Sign-in expired or was cancelled. Recordings remain on your phone." }, 400);
    // One-use state is consumed before redeeming the code.
    await removeSecret(env, pendingCookie);
    const tokens = await tokenRequest(env, { grant_type: "authorization_code", code: url.searchParams.get("code"), code_verifier: pending.verifier, redirect_uri: callbackUri(env) }, fetchImpl);
    const claims = verifyIdToken ? await verifyIdToken(tokens.id_token) : await verifyMicrosoftIdToken(tokens.id_token, env);
    if (claims.nonce !== pending.nonce || !validateOwner(claims, env)) return json({ error: "This Microsoft account is not authorised for BrixtonVibes uploads." }, 403, { "Set-Cookie": cookie("__Host-bv_oauth", "", 0) });
    if (!tokens.refresh_token) return json({ error: "Offline permission was not granted. Reconnect OneDrive." }, 400);
    const sessionId = random();
    await saveSecret(env, sessionId, "session", { owner: { oid: claims.oid, tid: claims.tid }, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, accessExpires: Date.now() + tokens.expires_in * 1000 }, Date.now() + SESSION_SECONDS * 1000);
    // Replace any prior session rather than accumulating it indefinitely.
    await removeSecret(env, readCookie(request, "__Host-bv_session"));
    const headers = new Headers({ Location: `${env.APP_ORIGIN}/?onedrive=connected`, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    headers.append("Set-Cookie", cookie("__Host-bv_session", sessionId, SESSION_SECONDS));
    headers.append("Set-Cookie", cookie("__Host-bv_oauth", "", 0));
    return new Response(null, { status: 303, headers });
  }
  if (!["POST", "PUT"].includes(request.method) || !checkMutation(request, env)) return json({ error: "Same-origin authenticated requests only" }, 403);
  if (path === "/api/onedrive/connect" && request.method === "POST") {
    const id = random();
    const state = random(); const nonce = random(); const verifier = random();
    await saveSecret(env, id, "oauth", { state, nonce, verifier }, Date.now() + 10 * 60000);
    const login = new URL(`${authority(env)}/authorize`);
    login.search = new URLSearchParams({ client_id: env.MICROSOFT_CLIENT_ID, response_type: "code", redirect_uri: callbackUri(env), response_mode: "query", scope: SCOPE, state, nonce, code_challenge: await hash(verifier), code_challenge_method: "S256" }).toString();
    return json({ url: login.href }, 200, { "Set-Cookie": cookie("__Host-bv_oauth", id, 600) });
  }
  const sessionId = readCookie(request, "__Host-bv_session");
  const session = await loadSecret(env, sessionId, "session");
  if (!session || !validateOwner(session.owner, env)) return json({ error: "Sign in again; local files are safe" }, 401);
  if (path === "/api/onedrive/disconnect" && request.method === "POST") {
    await removeSecret(env, sessionId);
    return json({ disconnected: true }, 200, { "Set-Cookie": cookie("__Host-bv_session", "", 0) });
  }
  const match = /^\/api\/onedrive\/recordings\/([A-Za-z0-9_-]{1,100})$/.exec(path);
  if (!match || request.method !== "PUT") return json({ error: "Not found" }, 404);
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) return json({ error: "JSON required" }, 415);
  const contentLength = Number(request.headers.get("Content-Length"));
  if (contentLength > MAX_UPLOAD) return json({ error: "Recording exceeds the 12 MB per-file safety limit; export manually" }, 413);
  // Bound chunked requests too; never trust the Content-Length header alone.
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "Empty recording" }, 400);
  const chunks = []; let total = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > MAX_UPLOAD) { await reader.cancel(); return json({ error: "Recording too large; export manually" }, 413); } chunks.push(value); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  const body = dec.decode(bytes);
  let parsed; try { parsed = JSON.parse(body); } catch { return json({ error: "Invalid JSON" }, 400); }
  if (!validateRecording(parsed, match[1])) return json({ error: "Only completed recordings with matching IDs can upload" }, 400);
  const filename = `victoria-recording-${match[1]}.json`;
  const target = `${GRAPH}/me/drive/special/approot:/${encodeURIComponent(filename)}:/content`;
  let token = await graphToken(env, sessionId, session, fetchImpl);
  let uploaded = await fetchImpl(target, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
  if (uploaded.status === 401) {
    token = await graphToken(env, sessionId, session, fetchImpl, true);
    uploaded = await fetchImpl(target, { method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
  }
  if (!uploaded.ok) {
    if (uploaded.status === 401) await removeSecret(env, sessionId);
    return json({ error: uploaded.status === 401 ? "Reconnect OneDrive; file safe on phone" : "OneDrive upload failed; file safe on phone" }, uploaded.status === 401 ? 401 : uploaded.status === 429 ? 429 : 502, uploaded.headers.get("Retry-After") ? { "Retry-After": uploaded.headers.get("Retry-After") } : {});
  }
  const remote = await uploaded.json();
  // Return no Graph tokens, upload URLs, or Microsoft response bodies.
  return json({ uploaded: true, filename, size: remote.size });
}

export default {
  async fetch(request, env) {
    try { return await handleRequest(request, env); }
    catch (error) { return json({ error: error.status === 401 ? "Reconnect OneDrive; local recordings retained" : "Upload service unavailable; local recordings retained" }, error.status === 401 ? 401 : 503); }
  },
  async scheduled(_event, env) {
    await env.DB.prepare("DELETE FROM sessions WHERE expires<?").bind(Date.now()).run();
  }
};
