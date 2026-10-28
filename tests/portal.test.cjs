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
  assert.deepEqual(DEPTS[0], { name: "MINA", deptId: "57" });
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
  assert.deepEqual(r, [{ name: "A", deptId: "12" }]);
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
