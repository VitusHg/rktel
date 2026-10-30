// Dienststellen-Import, Zuordnung Ort -> Dienststelle, Link ins Portal.
// Läuft unter TZ=Europe/Vienna. Alle Daten fiktiv.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const DP = require("../dienstplan.js");

const DEPTS = DP.parseDepartments(fs.readFileSync(path.join(__dirname, "fixtures", "dienststellen-fiktiv.json"), "utf8"));
const match = DP.createDepartmentMatcher(DEPTS);
const id = (loc) => (match(loc) || {}).deptId || null;

test("Import: gültige Liste", () => {
  assert.equal(DEPTS.length, 8);
  assert.deepEqual(DEPTS[0], { name: "MINA", deptId: "57", aliases: [] });
});

test("Import: deptId als Zahl, ungültige und doppelte Einträge", () => {
  const r = DP.parseDepartments(JSON.stringify({ abteilungen: [
    { name: "A", deptId: 12 },
    { name: "A", deptId: "12" },
    { name: "B", deptId: "12/../x" },
    { name: "C", deptId: "javascript:alert(1)" },
    { name: "", deptId: "13" },
    null,
  ] }));
  assert.deepEqual(r, [{ name: "A", deptId: "12", aliases: [] }]);
});

test("Import: verständliche Fehler", () => {
  assert.throws(() => DP.parseDepartments("kein json"), /kein gültiges JSON/);
  assert.throws(() => DP.parseDepartments('{"liste": []}'), /abteilungen/);
  assert.throws(() => DP.parseDepartments('{"abteilungen": [{"name": "X"}]}'), /Keine gültigen Einträge/);
});

test("RKZ und West werden bei der Zuordnung ignoriert", () => {
  assert.equal(id("MINA RKZ"), "57");
  assert.equal(id("MINA West"), "57");
  assert.equal(id("mina"), "57");
  assert.equal(id("MINA RKZ West"), "57");
});

test("Wörtlich passende Dienststelle hat Vorrang", () => {
  assert.equal(id("Musterdorf"), "58");
  assert.equal(id("Musterdorf Nord"), "59");
  assert.equal(id("Musterdorf RKZ"), "58");
});

test("Kurzname und Abkürzung aus dem Dienststellennamen", () => {
  assert.equal(id("SanHiSt"), "276");
  assert.equal(id("Sanitätshilfsstelle"), "276");
  assert.equal(id("Mobiles Sanitätsteam"), "277");
  assert.equal(id("KIT"), "309");
  assert.equal(id("Krisenintervention"), "309");
});

test("Unklare oder unbekannte Orte ergeben keinen Link", () => {
  assert.equal(id("Lehrsaal"), null, "zwei gleich gute Treffer");
  assert.equal(id("Unbekannter Ort"), null);
  assert.equal(id(""), null);
  assert.equal(id("RKZ"), null, "nur ignorierte Wörter");
  assert.equal(DP.createDepartmentMatcher(null)("MINA"), null);
});

test("Portal-Link: Datum des Dienstbeginns + Dienststellen-ID", () => {
  assert.equal(
    DP.portalUrl("2026-10-28", "57"),
    "https://dienstplan.st.roteskreuz.at/Home/Dienstplan/2026-10-28-00000000-0000-0000-0000-000000000000-57"
  );
  assert.equal(DP.portalUrl("2026-10-28", "57/x"), null);
  assert.equal(DP.portalUrl("28.10.2026", "57"), null);
});

test("Kalendertag eines Dienstes: Nachtdienst zählt zum Beginn, ganztägig zum Startdatum", () => {
  assert.equal(DP.occurrenceDateKey({ start: new Date(2026, 9, 28, 18).getTime(), end: new Date(2026, 9, 29, 6).getTime() }), "2026-10-28");
  assert.equal(DP.occurrenceDateKey({ start: new Date(2026, 9, 29, 0, 30).getTime() }), "2026-10-29");
  assert.equal(DP.occurrenceDateKey({ allDay: true, startDate: "2026-11-05", start: 0 }), "2026-11-05");
});

test("Safari-Link für iOS und Geräteerkennung", () => {
  const url = DP.portalUrl("2026-10-28", "57");
  assert.equal(DP.safariHref(url), "x-safari-" + url);
  assert.equal(DP.safariHref("http://localhost/x"), "http://localhost/x");
  assert.equal(DP.isIOS({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }), true);
  assert.equal(DP.isIOS({ userAgent: "Mozilla/5.0 (Macintosh)", platform: "MacIntel", maxTouchPoints: 5 }), true, "iPad mit Desktop-Modus");
  assert.equal(DP.isIOS({ userAgent: "Mozilla/5.0 (Windows NT 10.0)", platform: "Win32", maxTouchPoints: 0 }), false);
});

test("Manuelle Eingabe: Prüfung und verständliche Fehler", () => {
  assert.deepEqual(DP.makeDepartment(" MINA ", " 57 ", "MINA West, mina west, ; Garage Süd"),
    { name: "MINA", deptId: "57", aliases: ["MINA West", "Garage Süd"] });
  assert.throws(() => DP.makeDepartment("", "57"), /Dienststellennamen/);
  assert.throws(() => DP.makeDepartment("MINA", "57a"), /nur aus Ziffern/);
  assert.throws(() => DP.makeDepartment("MINA", ""), /nur aus Ziffern/);
});

test("Zusammenführen: gleiche ID wird aktualisiert, Ausnahmeregeln bleiben", () => {
  const a = [DP.makeDepartment("MINA alt", "57", ["MINA West"])];
  const r = DP.mergeDepartments(a, [DP.makeDepartment("MINA", "57", ["Garage"]), DP.makeDepartment("Musterdorf", "58")]);
  assert.deepEqual(r, [
    { name: "MINA", deptId: "57", aliases: ["MINA West", "Garage"] },
    { name: "Musterdorf", deptId: "58", aliases: [] },
  ]);
  assert.deepEqual(a[0].name, "MINA alt", "Original unverändert");
});

test("Ausnahmeregeln (Aliase) haben Vorrang vor der automatischen Zuordnung", () => {
  const m = DP.createDepartmentMatcher([
    DP.makeDepartment("MINA", "57"),
    DP.makeDepartment("MINA West", "60"),
    DP.makeDepartment("Lehrsaal A", "401", "Schulungsraum"),
    DP.makeDepartment("Hauptwache", "70", "Garage Süd"),
  ]);
  const id = (loc) => (m(loc) || {}).deptId || null;
  assert.equal(id("MINA West"), "60", "ohne Regel: wörtlich passende Dienststelle");
  assert.equal(id("Schulungsraum"), "401");
  assert.equal(id("garage süd"), "70", "Groß/Klein egal");
  assert.equal(id("Garage"), null, "Regel gilt nur für die ganze Bezeichnung");

  const m2 = DP.createDepartmentMatcher([
    DP.makeDepartment("MINA", "57", "MINA West"),
    DP.makeDepartment("MINA West", "60"),
  ]);
  assert.equal((m2("MINA West") || {}).deptId, "57", "Regel schlägt Namensgleichheit");
});

test("Import übernimmt Ausnahmeregeln aus dem JSON", () => {
  const r = DP.parseDepartments(JSON.stringify({ abteilungen: [{ name: "MINA", deptId: "57", aliases: ["MINA West", 5] }] }));
  assert.deepEqual(r[0].aliases, ["MINA West"]);
});
