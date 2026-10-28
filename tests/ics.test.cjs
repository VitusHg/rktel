// ICS-Verarbeitung: Zeitzonen, ganztägige Termine, Wiederholungen, Ausnahmen.
// Läuft unter TZ=Europe/Vienna und TZ=America/New_York (siehe package.json),
// damit Ergebnisse mit fester Zeitzone unabhängig von der Gerätezeit sind.
// Alle Kalenderdaten sind fiktiv.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const DP = require("../dienstplan.js");

const FIXTURE = fs.readFileSync(path.join(__dirname, "fixtures", "dienstplan-fiktiv.ics"), "utf8");
const NOW = Date.parse("2026-10-28T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

function cal(events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Fiktiv//Test//DE", ...events, "END:VCALENDAR"].join("\r\n");
}

const parsed = DP.parseCalendar(FIXTURE, { now: NOW });
const byTitle = (t) => parsed.filter((o) => o.title === t);
const one = (t) => {
  const list = byTitle(t);
  assert.equal(list.length, 1, "genau ein Termin erwartet: " + t);
  return list[0];
};

test("vergangene Termine werden ausgeblendet, laufende bleiben", () => {
  assert.equal(byTitle("Vergangener Dienst").length, 0);
  const running = one("Laufender Dienst");
  assert.equal(iso(running.start), "2026-10-28T06:00:00.000Z");
  assert.equal(running.location, "Musterwache Nord");
  assert.equal(DP.formatOccurrence(running, NOW).running, true);
});

test("Ergebnis ist nach Beginn sortiert", () => {
  for (let i = 1; i < parsed.length; i++) assert.ok(parsed[i - 1].start <= parsed[i].start);
});

test("TZID ohne VTIMEZONE (Europe/Vienna) wird korrekt nach UTC umgerechnet (Winterzeit)", () => {
  const n = one("Nachtdienst RTW");
  assert.equal(iso(n.start), "2026-10-29T18:00:00.000Z");
  assert.equal(iso(n.end), "2026-10-30T06:00:00.000Z");
  assert.equal(n.location, "Musterwache Süd, Garage 2", "escapte Kommas werden aufgelöst");
});

test("TZID mit eingebetteter VTIMEZONE wird verwendet", () => {
  const v = one("Dienst mit eigener VTIMEZONE");
  assert.equal(iso(v.start), "2026-11-02T07:00:00.000Z");
  assert.equal(iso(v.end), "2026-11-02T15:00:00.000Z");
});

test("Windows-Zeitzonenname wird erkannt", () => {
  const w = one("Dienst mit Windows-Zeitzone");
  assert.equal(iso(w.start), "2026-11-04T06:00:00.000Z");
});

test("Zeit ohne Zeitzone (floating) gilt in Gerätezeit", () => {
  const f = one("Dienst ohne Zeitzone");
  assert.equal(f.start, new Date(2026, 10, 6, 7, 0, 0).getTime());
  assert.equal(f.end, new Date(2026, 10, 6, 13, 0, 0).getTime());
});

test("gefaltete Zeilen und DURATION", () => {
  const g = one("Sehr langer Titel für einen Dienst, der über mehrere Zeilen gefaltet wurde");
  assert.equal(iso(g.start), "2026-11-07T06:00:00.000Z");
  assert.equal(iso(g.end), "2026-11-07T14:00:00.000Z");
});

test("Wiederholung mit EXDATE, verschobener und abgesagter Ausnahme", () => {
  const series = parsed.filter((o) => o.uid === "serie-1@test.invalid");
  assert.deepEqual(
    series.map((o) => [iso(o.start), o.title, o.cancelled]),
    [
      ["2026-11-02T08:00:00.000Z", "Wochendienst Montag (verschoben)", false],
      ["2026-11-16T06:00:00.000Z", "Wochendienst Montag", true],
      ["2026-11-23T06:00:00.000Z", "Wochendienst Montag", false],
      ["2026-11-30T06:00:00.000Z", "Wochendienst Montag", false],
    ]
  );
  assert.equal(series[0].location, "Musterwache West", "Ausnahme überschreibt Ort");
  assert.equal(series[2].location, "Musterwache Nord");
  assert.ok(!series.some((o) => iso(o.start).startsWith("2026-11-09")), "EXDATE entfernt Termin");
});

test("Wiederholung über die Sommerzeit-Umstellung behält die Wandzeit", () => {
  const early = DP.parseCalendar(FIXTURE, { now: Date.parse("2026-10-18T00:00:00Z") });
  const s = early.filter((o) => o.uid === "serie-1@test.invalid").slice(0, 2);
  assert.equal(iso(s[0].start), "2026-10-19T05:00:00.000Z"); // 07:00 MESZ
  assert.equal(iso(s[1].start), "2026-10-26T06:00:00.000Z"); // 07:00 MEZ
});

test("Ganztägige Termine: exklusives DTEND, mehrtägig, ohne DTEND", () => {
  const a = one("Fortbildung (ganztägig)");
  assert.equal(a.allDay, true);
  assert.equal(a.startDate, "2026-11-05");
  assert.equal(a.endDate, "2026-11-05");
  const b = one("Ausbildungswoche");
  assert.equal(b.startDate, "2026-11-10");
  assert.equal(b.endDate, "2026-11-12");
  const c = one("Ganztägig ohne Ende");
  assert.equal(c.startDate, "2026-11-20");
  assert.equal(c.endDate, "2026-11-20");
});

test("Abgesagte Einzeltermine werden markiert", () => {
  assert.equal(one("Abgesagter Dienst").cancelled, true);
  assert.equal(one("Nachtdienst RTW").cancelled, false);
});

test("Ausnahme ohne Hauptereignis wird als Einzeltermin angezeigt", () => {
  const r = DP.parseCalendar(cal([
    "BEGIN:VEVENT", "UID:waise@test.invalid", "RECURRENCE-ID:20261105T060000Z",
    "DTSTART:20261105T070000Z", "DTEND:20261105T150000Z", "SUMMARY:Einzelne Ausnahme", "END:VEVENT",
  ]), { now: NOW });
  assert.equal(r.length, 1);
  assert.equal(iso(r[0].start), "2026-11-05T07:00:00.000Z");
});

test("Unendliche Serie wird durch Horizont und maxItems begrenzt", () => {
  const ics = cal([
    "BEGIN:VEVENT", "UID:taeglich@test.invalid",
    "DTSTART;TZID=Europe/Vienna:20200101T080000", "DTEND;TZID=Europe/Vienna:20200101T090000",
    "RRULE:FREQ=DAILY", "SUMMARY:Täglich", "END:VEVENT",
  ]);
  const r = DP.parseCalendar(ics, { now: NOW, horizonDays: 30 });
  assert.equal(r.length, 30);
  assert.equal(iso(r[0].start), "2026-10-29T07:00:00.000Z");
  assert.equal(DP.parseCalendar(ics, { now: NOW, horizonDays: 365, maxItems: 10 }).length, 10);
});

test("Mozilla-TZID-Präfix wird aufgelöst", () => {
  assert.equal(DP.resolveTzid("/mozilla.org/20050126_1/Europe/Vienna"), "Europe/Vienna");
  assert.equal(DP.resolveTzid("Unbekannt/Zone"), null);
});

test("Ungültige Daten werfen einen verständlichen Fehler", () => {
  assert.throws(() => DP.parseCalendar("<html>Login</html>"), { code: "invalid" });
  assert.throws(() => DP.parseCalendar(""), { code: "invalid" });
  assert.throws(() => DP.parseCalendar("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:kaputt"), { code: "invalid" });
});

test("Leerer Kalender liefert keine Termine", () => {
  assert.deepEqual(DP.parseCalendar(cal([]), { now: NOW }), []);
});

test("RK-Dienstplan-Format: Zeiten ohne TZID, Kollegen und Zusatzinfo aus DESCRIPTION", () => {
  const ics = fs.readFileSync(path.join(__dirname, "fixtures", "rk-format-fiktiv.ics"), "utf8");
  const r = DP.parseCalendar(ics, { now: NOW });
  assert.equal(r.length, 2);
  const [rtw, ktw] = r;
  assert.equal(rtw.title, "RTW");
  assert.equal(rtw.location, "Musterwache RKZ");
  assert.equal(rtw.start, new Date(2026, 9, 30, 18, 0).getTime(), "floating -> Gerätezeit");
  assert.equal(rtw.end, new Date(2026, 9, 31, 6, 0).getTime());
  assert.equal(rtw.cancelled, false, "STATUS:Confirmed (gemischte Schreibweise)");
  assert.deepEqual(rtw.colleagues, ["Anna Beispiel", "Bernd Muster"]);
  assert.equal(rtw.note, "Zimmer 7");
  assert.deepEqual(ktw.colleagues, ["Carla Testperson"]);
  assert.equal(ktw.note, "");
});

test("DESCRIPTION ohne Namensliste wird als Notiz übernommen", () => {
  assert.deepEqual(DP.parseDescription(""), { colleagues: [], note: "" });
  assert.deepEqual(DP.parseDescription("Treffpunkt: 18:00 Haupteingang"), { colleagues: [], note: "Treffpunkt: 18:00 Haupteingang" });
  assert.deepEqual(DP.parseDescription("Anna Beispiel; Bernd Muster"), { colleagues: ["Anna Beispiel", "Bernd Muster"], note: "" });
});

test("Titel als eigener Listeneintrag werden dem vorherigen Namen zugeordnet", () => {
  const ics = cal([
    "BEGIN:VEVENT", "UID:titel@test.invalid",
    "DTSTART:20261105T070000", "DTEND:20261105T190000", "SUMMARY:RTW",
    "DESCRIPTION:Muster Max\\, Beispiel Anna\\, Mag.\\, Test Carla\\, Dr. med. univ.\\, Probe Dora\\, Dipl.-Ing.\\, BSc MSc\\nZimmer 2",
    "END:VEVENT",
  ]);
  const [o] = DP.parseCalendar(ics, { now: NOW });
  assert.deepEqual(o.colleagues, [
    "Muster Max",
    "Beispiel Anna, Mag.",
    "Test Carla, Dr. med. univ.",
    "Probe Dora, Dipl.-Ing., BSc MSc",
  ]);
  assert.equal(o.note, "Zimmer 2");
});

test("Titel-Kombinationen aus dem RK-Dienstplan", () => {
  assert.deepEqual(
    DP.parseDescription("Muster Max, Prof. Ing. Mag., Beispiel Anna, OL, Test Carla, Ing. Mag., Probe Dora").colleagues,
    ["Muster Max, Prof. Ing. Mag.", "Beispiel Anna, OL", "Test Carla, Ing. Mag.", "Probe Dora"]
  );
});

test("Titel am Listenanfang und Namen, die nur ähnlich klingen", () => {
  assert.deepEqual(DP.parseDescription("Mag., Muster Max").colleagues, ["Muster Max"]);
  assert.deepEqual(DP.parseDescription("Maria Magdalena, Ing Bert").colleagues, ["Maria Magdalena", "Ing Bert"]);
});
