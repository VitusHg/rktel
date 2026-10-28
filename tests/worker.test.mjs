// Worker: Zugriffsschutz, kein offener Proxy, CORS, Fehlerfälle.
// Upstream wird gemockt; alle Adressen und Daten sind fiktiv.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { handleRequest } from "../worker/src/index.js";

const TOKEN = "fiktiver-test-schluessel-0123456789abcdefghij";
const ORIGIN = "https://beispiel.github.io";
const ICS_URL = "https://dienstplan.st.roteskreuz.at/Calendar/FIKTIV-0000/Private.ics";
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
const WORKER = "https://rktel-dienstplan.beispiel.workers.dev";

const env = (over = {}) => ({
  ICS_URL,
  ACCESS_TOKEN: TOKEN,
  ALLOWED_ORIGINS: ORIGIN + ", http://localhost:8080",
  UPSTREAM_HOST: "dienstplan.st.roteskreuz.at",
  ...over,
});

function mockFetch(impl) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    return impl ? impl(url, init) : new Response(ICS, { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

function req(path = "/dienstplan.ics", { method = "GET", token = TOKEN, origin = ORIGIN, headers = {} } = {}) {
  const h = { ...headers };
  if (token !== null) h.Authorization = "Bearer " + token;
  if (origin !== null) h.Origin = origin;
  return new Request(WORKER + path, { method, headers: h });
}

test("gültiger Schlüssel + erlaubte Herkunft -> ICS mit CORS, ohne Caching", async () => {
  const f = mockFetch();
  const res = await handleRequest(req(), env(), { fetch: f });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), ICS);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.match(res.headers.get("Cache-Control"), /no-store/);
  assert.match(res.headers.get("Content-Type"), /text\/calendar/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, ICS_URL, "ruft ausschließlich die Secret-Adresse ab");
});

test("fehlender, falscher oder fast richtiger Schlüssel -> 401, kein Upstream-Abruf", async () => {
  for (const token of [null, "", "falsch", TOKEN + "x", TOKEN.slice(0, -1), TOKEN.toUpperCase()]) {
    const f = mockFetch();
    const res = await handleRequest(req("/dienstplan.ics", { token }), env(), { fetch: f });
    assert.equal(res.status, 401, "Token: " + token);
    assert.equal(f.calls.length, 0);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), ORIGIN, "Fehlerstatus für die PWA lesbar");
    const body = await res.text();
    assert.ok(!body.includes(ICS_URL) && !body.includes(TOKEN));
  }
});

test("Schlüssel nur im Authorization-Header, nicht als Query-Parameter", async () => {
  const f = mockFetch();
  const res = await handleRequest(req("/dienstplan.ics?token=" + TOKEN, { token: null }), env(), { fetch: f });
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test("kein offener Proxy: Ziel-URL-Parameter und andere Pfade werden abgelehnt", async () => {
  const f = mockFetch();
  const evil = [
    "/dienstplan.ics?url=https://example.com/",
    "/?url=" + encodeURIComponent("https://example.com/"),
    "/https://example.com/",
    "/dienstplan.ics/../../x",
    "/proxy",
  ];
  for (const p of evil) {
    const res = await handleRequest(req(p), env(), { fetch: f });
    assert.ok([400, 404].includes(res.status), p + " -> " + res.status);
  }
  assert.equal(f.calls.length, 0);
});

test("fremde Herkunft -> 403 ohne CORS-Freigabe", async () => {
  const f = mockFetch();
  const res = await handleRequest(req("/dienstplan.ics", { origin: "https://boese.example" }), env(), { fetch: f });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
  assert.equal(f.calls.length, 0);
});

test("CORS allein reicht nicht: ohne Origin (z. B. curl) wird trotzdem der Schlüssel verlangt", async () => {
  const f = mockFetch();
  assert.equal((await handleRequest(req("/dienstplan.ics", { origin: null, token: null }), env(), { fetch: f })).status, 401);
  assert.equal((await handleRequest(req("/dienstplan.ics", { origin: null }), env(), { fetch: f })).status, 200);
});

test("Preflight (OPTIONS) nur für erlaubte Herkunft", async () => {
  const ok = await handleRequest(req("/dienstplan.ics", { method: "OPTIONS", token: null }), env(), { fetch: mockFetch() });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Headers"), "Authorization");
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  const bad = await handleRequest(req("/dienstplan.ics", { method: "OPTIONS", token: null, origin: "https://boese.example" }), env(), {});
  assert.equal(bad.status, 403);
});

test("andere Methoden -> 405", async () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    const res = await handleRequest(req("/dienstplan.ics", { method }), env(), { fetch: mockFetch() });
    assert.equal(res.status, 405);
  }
});

test("Fehlkonfiguration -> 500 worker_config, ohne Upstream-Abruf", async () => {
  const cases = [
    { ACCESS_TOKEN: undefined },
    { ACCESS_TOKEN: "zu-kurz" },
    { ICS_URL: undefined },
    { ICS_URL: "kein-link" },
    { ICS_URL: "http://dienstplan.st.roteskreuz.at/Calendar/FIKTIV/Private.ics" },
    { ICS_URL: "https://andere-seite.example/Private.ics" },
  ];
  for (const c of cases) {
    const f = mockFetch();
    const res = await handleRequest(req(), env(c), { fetch: f });
    assert.equal(res.status, 500, JSON.stringify(c));
    assert.deepEqual(await res.json(), { error: "worker_config" });
    assert.equal(f.calls.length, 0);
  }
});

test("Upstream-Fehler werden ohne Details zur ICS-Adresse gemeldet", async () => {
  const cases = [
    [() => new Response("nicht gefunden", { status: 404 }), 502, { error: "upstream_status", status: 404 }],
    [() => new Response("<html>Anmeldung</html>", { status: 200 }), 502, { error: "upstream_invalid" }],
    [() => { throw new TypeError("fetch failed " + ICS_URL); }, 502, { error: "upstream_unreachable" }],
    [() => { const e = new Error("t"); e.name = "TimeoutError"; throw e; }, 504, { error: "upstream_timeout" }],
    [() => new Response("x", { status: 200, headers: { "Content-Length": String(6 * 1024 * 1024) } }), 502, { error: "upstream_too_large" }],
  ];
  for (const [impl, status, body] of cases) {
    const res = await handleRequest(req(), env(), { fetch: mockFetch(impl) });
    assert.equal(res.status, status);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), body);
    assert.ok(!text.includes("FIKTIV"), "ICS-Adresse nicht in der Antwort");
  }
});

test("ICS mit BOM/Leerzeilen am Anfang wird akzeptiert", async () => {
  const res = await handleRequest(req(), env(), { fetch: mockFetch(() => new Response("﻿\r\n" + ICS)) });
  assert.equal(res.status, 200);
});

test("Standard-Export fängt unerwartete Fehler ab, ohne Details preiszugeben", async () => {
  const res = await worker.fetch(req(), { get ALLOWED_ORIGINS() { throw new Error(ICS_URL); } });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "server" });
});
