// Client: Worker-Abruf und Fehlermeldungen, Entprellung der Abrufe,
// Adressprüfung, Formatierung. Läuft unter TZ=Europe/Vienna. Daten fiktiv.
const test = require("node:test");
const assert = require("node:assert/strict");
const DP = require("../dienstplan.js");

const CFG = { url: "https://rktel-dienstplan.beispiel.workers.dev", token: "fiktiv-0123456789abcdefghijklmnopqrstuv" };
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";

function jsonRes(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

test("Abruf sendet Schlüssel als Bearer-Header an den festen Endpunkt, nie in der URL", async () => {
  let seen;
  const text = await DP.fetchCalendarText(CFG, {
    fetch: async (url, init) => { seen = { url, init }; return new Response(ICS); },
  });
  assert.equal(text, ICS);
  assert.equal(seen.url, CFG.url + "/dienstplan.ics");
  assert.ok(!seen.url.includes(CFG.token));
  assert.equal(seen.init.headers.Authorization, "Bearer " + CFG.token);
  assert.equal(seen.init.cache, "no-store");
  assert.equal(seen.init.credentials, "omit");
});

test("Fehlercodes werden auf verständliche Meldungen abgebildet", async () => {
  const cases = [
    [() => jsonRes(401, { error: "unauthorized" }), "unauthorized", /Zugangsschlüssel ungültig/],
    [() => jsonRes(404, { error: "not_found" }), "not_found", /Worker-Adresse falsch/],
    [() => jsonRes(429, {}), "rate_limited", /Zu viele Anfragen/],
    [() => jsonRes(500, { error: "worker_config" }), "worker_config", /Secrets/],
    [() => jsonRes(502, { error: "upstream_status", status: 404 }), "upstream_status", /HTTP 404/],
    [() => jsonRes(502, { error: "upstream_invalid" }), "upstream_invalid", /keine Kalenderdaten/],
    [() => jsonRes(504, { error: "upstream_timeout" }), "upstream_timeout", /antwortet nicht/],
    [() => new Response("<html>Fehlerseite</html>", { status: 503 }), "server", /Unerwarteter Fehler/],
    [() => new Response("kein Kalender", { status: 200 }), "invalid", /kein gültiger Kalender/],
  ];
  for (const [impl, code, msg] of cases) {
    await assert.rejects(DP.fetchCalendarText(CFG, { fetch: async () => impl() }), (err) => {
      assert.equal(err.code, code);
      assert.match(err.message, msg);
      return true;
    });
  }
});

test("Netzwerkfehler: offline vs. Worker nicht erreichbar", async () => {
  const fail = async () => { throw new TypeError("Failed to fetch"); };
  await assert.rejects(DP.fetchCalendarText(CFG, { fetch: fail, isOnline: () => false }), { code: "offline" });
  await assert.rejects(DP.fetchCalendarText(CFG, { fetch: fail, isOnline: () => true }), { code: "network" });
});

test("Zeitüberschreitung bricht den Abruf ab", async () => {
  const hang = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  await assert.rejects(DP.fetchCalendarText(CFG, { fetch: hang, timeoutMs: 20 }), { code: "timeout" });
});

test("ohne Einrichtung kein Abruf", async () => {
  let called = false;
  const f = async () => { called = true; return new Response(ICS); };
  await assert.rejects(DP.fetchCalendarText({ url: "", token: "" }, { fetch: f }), { code: "not_configured" });
  await assert.rejects(DP.fetchCalendarText({ url: CFG.url, token: "" }, { fetch: f }), { code: "not_configured" });
  assert.equal(called, false);
});

test("Worker-Adresse: nur https, ohne Zugangsdaten/Query; Pfad wird normalisiert", () => {
  assert.equal(DP.normalizeWorkerUrl("https://a.b.workers.dev/"), "https://a.b.workers.dev");
  assert.equal(DP.normalizeWorkerUrl(" https://a.b.workers.dev/dienstplan.ics "), "https://a.b.workers.dev");
  assert.equal(DP.normalizeWorkerUrl("http://localhost:8787"), "http://localhost:8787");
  assert.equal(DP.normalizeWorkerUrl("http://a.b.workers.dev"), null);
  assert.equal(DP.normalizeWorkerUrl("https://a.b.workers.dev/?url=https://x"), null);
  assert.equal(DP.normalizeWorkerUrl("https://user:pw@a.b.workers.dev"), null);
  assert.equal(DP.normalizeWorkerUrl("javascript:alert(1)"), null);
  assert.equal(DP.normalizeWorkerUrl(""), null);
});

test("Entprellung: gleichzeitige Abrufe teilen sich eine Anfrage", async () => {
  let runs = 0, release;
  const r = DP.createRefresher({ run: () => { runs++; return new Promise((res) => { release = res; }); } });
  const a = r.refresh(false), b = r.refresh(false), c = r.refresh(true);
  assert.equal(a, b);
  assert.equal(a, c);
  assert.equal(r.isRunning(), true);
  await new Promise((res) => setImmediate(res));
  release("ok");
  assert.equal(await a, "ok");
  assert.equal(runs, 1);
  assert.equal(r.isRunning(), false);
});

test("Entprellung: automatische Abrufe kurz nach Versuch/Erfolg werden übersprungen, manuelle nicht", async () => {
  let t = 1_000_000, runs = 0, lastSuccess = 0;
  const r = DP.createRefresher({
    now: () => t,
    getLastSuccess: () => lastSuccess,
    minAttemptGapMs: 60_000,
    minSuccessAgeMs: 300_000,
    run: async () => { runs++; },
  });
  await r.refresh(false);            // Start
  assert.equal(runs, 1);
  t += 1000;
  assert.deepEqual(await r.refresh(false), { skipped: true }); // z. B. visibilitychange + pageshow
  await r.refresh(true);             // Aktualisieren-Button
  assert.equal(runs, 2);
  lastSuccess = t;
  t += 120_000;                      // Versuch alt genug, Erfolg aber zu frisch
  assert.deepEqual(await r.refresh(false), { skipped: true });
  t += 300_000;
  await r.refresh(false);
  assert.equal(runs, 3);
});

test("Entprellung: Fehler werden weitergereicht, danach ist ein neuer Abruf möglich", async () => {
  let n = 0;
  const r = DP.createRefresher({ minAttemptGapMs: 0, run: async () => { if (++n === 1) throw new Error("x"); return "ok"; } });
  await assert.rejects(r.refresh(false));
  assert.equal(await r.refresh(false), "ok");
});

test("Formatierung: Tagdienst, Nachtdienst, mehrtägig, ganztägig, relative Hinweise", () => {
  const now = new Date(2026, 9, 28, 12, 0).getTime(); // Mi 28.10.2026 12:00 (Wien)
  const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime();

  let f = DP.formatOccurrence({ start: at(28, 7), end: at(28, 19) }, now);
  assert.equal(f.timeLabel, "07:00 – 19:00 Uhr");
  assert.equal(f.relative, "Läuft gerade");
  assert.equal(f.running, true);

  f = DP.formatOccurrence({ start: at(29, 19), end: at(30, 7) }, now);
  assert.equal(f.timeLabel, "19:00 – 07:00 Uhr");
  assert.equal(f.relative, "Morgen");
  assert.match(f.dateLabel, /29\.10\.2026/);

  f = DP.formatOccurrence({ start: at(30, 7), end: at(32, 19) }, now);
  assert.match(f.timeLabel, /^07:00 Uhr – .*01\.11\., 19:00 Uhr$/);
  assert.equal(f.relative, "in 2 Tagen");

  f = DP.formatOccurrence({ allDay: true, startDate: "2026-11-10", endDate: "2026-11-12", start: at(41, 0), end: at(44, 0) }, now);
  assert.match(f.timeLabel, /^Ganztägig bis .*12\.11\.2026$/);
  f = DP.formatOccurrence({ allDay: true, startDate: "2026-10-28", endDate: "2026-10-28", start: at(28, 0), end: at(29, 0) }, now);
  assert.equal(f.timeLabel, "Ganztägig");

  f = DP.formatOccurrence({ start: at(28, 7), end: at(28, 19), cancelled: true }, now);
  assert.equal(f.running, false, "abgesagt läuft nicht");
});

test("Formatierung über die Sommerzeit-Umstellung (Kalendertage stimmen)", () => {
  const now = new Date(2026, 9, 24, 12, 0).getTime(); // Sa vor der Umstellung
  const f = DP.formatOccurrence({ start: new Date(2026, 9, 25, 19).getTime(), end: new Date(2026, 9, 26, 7).getTime() }, now);
  assert.equal(f.relative, "Morgen");
  assert.equal(f.timeLabel, "19:00 – 07:00 Uhr");
});

test("Zeitstempel und Zufallsschlüssel", () => {
  assert.equal(DP.formatTimestamp(new Date(2026, 9, 28, 9, 5).getTime()), "28.10.2026, 09:05 Uhr");
  const a = DP.generateToken(), b = DP.generateToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= DP.MIN_TOKEN_LENGTH);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test("Kollegen-Abgleich mit dem Telefonbuch", () => {
  const contacts = [
    { name: "Beispiel Anna", phones: ["+43 660 1111111"] },
    { name: "Müller Jürgen (RS, SEF)", phones: ["+43 660 2222222"] },
    { name: "Bernd Karl Muster", phones: ["+43 660 3333333"] },
    { name: "Ohne Nummer", phones: [] },
    { name: "Anna Andere", phones: ["+43 660 4444444"] },
  ];
  const match = DP.createContactMatcher(contacts);
  const names = (n) => match(n).map((c) => c.name);
  assert.deepEqual(names("Anna Beispiel"), ["Beispiel Anna"], "Reihenfolge Vor-/Nachname egal");
  assert.deepEqual(names("anna  BEISPIEL"), ["Beispiel Anna"], "Groß/Klein, Leerzeichen");
  assert.deepEqual(names("Juergen Mueller"), ["Müller Jürgen (RS, SEF)"], "Umlaute und Qualifikationszusatz");
  assert.deepEqual(names("Bernd Muster"), ["Bernd Karl Muster"], "zweiter Vorname");
  assert.deepEqual(names("Ohne Nummer"), [], "Kontakte ohne Nummer nicht anrufbar");
  assert.deepEqual(names("Anna"), [], "Vorname allein reicht nicht");
  assert.deepEqual(names("Unbekannt Person"), []);
  assert.deepEqual(DP.createContactMatcher(null)("Anna Beispiel"), []);
});

test("Kollegen-Abgleich ignoriert Titel auf beiden Seiten", () => {
  const match = DP.createContactMatcher([
    { name: "Beispiel Anna", phones: ["+43 660 1111111"] },
    { name: "Mag. Test Carla (RS)", phones: ["+43 660 2222222"] },
    { name: "Probe Dora DI", phones: ["+43 660 3333333"] },
  ]);
  const names = (n) => match(n).map((c) => c.name);
  assert.deepEqual(names("Beispiel Anna, Mag."), ["Beispiel Anna"]);
  assert.deepEqual(names("Test Carla"), ["Mag. Test Carla (RS)"]);
  assert.deepEqual(names("Dr. Anna Beispiel"), ["Beispiel Anna"]);
  assert.deepEqual(names("Probe Dora, Dipl.-Ing."), ["Probe Dora DI"]);
  assert.deepEqual(names("Mag."), [], "Titel allein ist kein Name");
});
