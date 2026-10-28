/*
 * RKTel Dienstplan-Proxy (Cloudflare Worker)
 *
 * Liefert genau EINEN Kalender aus: die private ICS-Adresse aus dem Secret
 * ICS_URL. Es gibt keinen Ziel-URL-Parameter – der Worker ist kein offener Proxy.
 *
 * Zugriff nur mit "Authorization: Bearer <ACCESS_TOKEN>" (Secret, mind. 32 Zeichen).
 * CORS-Header nur für Herkünfte aus ALLOWED_ORIGINS – CORS ist dabei nur eine
 * Browser-Regel, der eigentliche Schutz ist der Zugangsschlüssel.
 *
 * Die ICS-Adresse und der Zugangsschlüssel werden nie geloggt oder in
 * Antworten zurückgegeben.
 *
 * Konfiguration:
 *   Secret ICS_URL          vollständiger privater Kalenderlink (https)
 *   Secret ACCESS_TOKEN     zufälliger Zugangsschlüssel (>= 32 Zeichen)
 *   Var    ALLOWED_ORIGINS  kommagetrennt, z. B. "https://vitushg.github.io"
 *   Var    UPSTREAM_HOST    erlaubter Host der ICS_URL (Schutz vor Fehlkonfiguration)
 */

const ENDPOINT = "/dienstplan.ics";
const MIN_TOKEN_LENGTH = 32;
const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_ICS_BYTES = 5 * 1024 * 1024;

const BASE_HEADERS = {
  "Cache-Control": "no-store, private",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};

function parseOrigins(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

function corsHeaders(origin, allowed) {
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function json(status, body, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "Content-Type": "application/json; charset=utf-8", Vary: "Origin", ...extra },
  });
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

// Vergleich in konstanter Zeit (über Hashes gleicher Länge).
async function tokenMatches(given, expected) {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function configError(env) {
  if (typeof env.ACCESS_TOKEN !== "string" || env.ACCESS_TOKEN.length < MIN_TOKEN_LENGTH) return true;
  let url;
  try {
    url = new URL(env.ICS_URL);
  } catch {
    return true;
  }
  if (url.protocol !== "https:") return true;
  if (env.UPSTREAM_HOST && url.hostname !== env.UPSTREAM_HOST) return true;
  return false;
}

export async function handleRequest(request, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  const allowed = parseOrigins(env.ALLOWED_ORIGINS);
  const cors = corsHeaders(origin, allowed);

  if (url.pathname !== ENDPOINT) return json(404, { error: "not_found" }, cors);

  // Fremde Browser-Herkünfte grundsätzlich abweisen (Anfragen ohne Origin,
  // z. B. curl, brauchen trotzdem den Zugangsschlüssel).
  if (origin && !allowed.includes(origin)) return json(403, { error: "forbidden" });

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...BASE_HEADERS, Vary: "Origin", ...cors } });
  }
  if (request.method !== "GET") {
    return json(405, { error: "method_not_allowed" }, { ...cors, Allow: "GET, OPTIONS" });
  }
  if (url.search) return json(400, { error: "bad_request" }, cors);

  if (configError(env)) return json(500, { error: "worker_config" }, cors);

  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(\S+)$/);
  if (!match || !(await tokenMatches(match[1], env.ACCESS_TOKEN))) {
    return json(401, { error: "unauthorized" }, { ...cors, "WWW-Authenticate": 'Bearer realm="dienstplan"' });
  }

  let upstream;
  try {
    upstream = await fetchImpl(env.ICS_URL, {
      method: "GET",
      headers: { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.1", "User-Agent": "RKTel-Dienstplan-Worker" },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    const timeout = err && (err.name === "TimeoutError" || err.name === "AbortError");
    return json(timeout ? 504 : 502, { error: timeout ? "upstream_timeout" : "upstream_unreachable" }, cors);
  }

  if (!upstream.ok) {
    return json(502, { error: "upstream_status", status: upstream.status }, cors);
  }

  const declared = Number(upstream.headers.get("Content-Length") || 0);
  if (declared > MAX_ICS_BYTES) return json(502, { error: "upstream_too_large" }, cors);

  let body;
  try {
    body = await upstream.text();
  } catch {
    return json(502, { error: "upstream_unreachable" }, cors);
  }
  if (body.length > MAX_ICS_BYTES) return json(502, { error: "upstream_too_large" }, cors);
  if (!/^\s*BEGIN:VCALENDAR/i.test(body.slice(0, 1024).replace(/^﻿/, ""))) {
    return json(502, { error: "upstream_invalid" }, cors);
  }

  return new Response(body, {
    status: 200,
    headers: { ...BASE_HEADERS, "Content-Type": "text/calendar; charset=utf-8", Vary: "Origin", ...cors },
  });
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch {
      // Bewusst ohne Details: keine URLs oder Schlüssel in Logs/Antworten.
      return json(500, { error: "server" });
    }
  },
};
