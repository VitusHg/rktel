# RKTel

RKTel ist ein lokales Telefonbuch für Einsatzmittel als Progressive Web App (PWA). Alle Telefonbuchdaten bleiben ausschließlich auf dem Gerät. Optional zeigt RKTel deinen Dienstplan an – geladen über einen eigenen, kostenlosen Cloudflare Worker (siehe unten).

## Funktionen

- **Kontakte verwalten**: Hinzufügen, Bearbeiten, Löschen – mit Name, Dienststelle, mehreren Telefonnummern und Notiz.
- **PDF-Import**: Telefonlisten als PDF importieren (Drag & Drop oder Dateiauswahl unter Einstellungen). Die Verarbeitung erfolgt vollständig im Browser, es wird nichts hochgeladen.
- **Favoriten**: Kontakte anpinnen – sie erscheinen dann oben auf der Kontakte-Seite für schnellen Zugriff.
- **Kurzwahl für Einsatzmittel**: Eine Basisnummer (z. B. Diensthandy-Präfix) in den Einstellungen hinterlegen; auf der Kontakte-Seite wird sie live mit der eingegebenen Einsatzmittel-Nummer zur vollständigen Rufnummer kombiniert.
- **Installierbar als App**: Über „Zum Home-Bildschirm hinzufügen" (iOS/Android) lässt sich RKTel wie eine native App nutzen, inklusive Offline-Fähigkeit über einen Service Worker.
- **JSON-Export**: Alle Kontakte lassen sich als JSON-Datei sichern.
- **Dienstplan** (optional): Kommende Dienste aus dem privaten ICS-Kalender mit Datum, Beginn, Ende, Titel und Ort – inkl. Zeitzonen, ganztägiger Termine, Wiederholungen, Ausnahmen und abgesagter Termine. Offline bleibt der zuletzt geladene Stand verfügbar.

## PDF-Import im Detail

Der Import ist auf das PDF-Format des ÖRK-Online-Dienstplans zugeschnitten (*Mitarbeiter → Downloads → „Telefonnummern"-Export*). Aus jeder importierten Liste werden automatisch erkannt:

- **Dienststelle** – aus der Kopfzeile „TELEFON \<Dienststelle\>"
- **Erstellungsdatum** – aus der Fußzeile „Online erstellt am … Seite …"

Beim Import werden E-Mail-Adressen sowie Qualifikationszusätze in Klammern (z. B. „(RS, SEF)") verworfen. Neue Kontakte werden anhand des Namens mit bereits vorhandenen zusammengeführt: Telefonnummern werden ergänzt, mehrere Quellen (Dienststelle + Datum) je Kontakt gesammelt und in den Kontaktdetails angezeigt.

Liegt ein PDF in einem anderen Format vor, werden keine oder falsche Kontakte erkannt – der Import meldet dann „Keine Kontakte erkannt."

## Datenhaltung & Datenschutz

- Alle Kontakte, die Kurzwahl-Basisnummer und sonstige Einstellungen werden ausschließlich im `localStorage` des Browsers gespeichert.
- Es gibt keine Analyse- oder Tracking-Skripte. Telefonbuchdaten werden nie übertragen.
- Dienstplan: Die App ruft ausschließlich deinen eigenen Worker auf. Worker-Adresse und Zugangsschlüssel gibst du selbst in den Einstellungen ein; sie werden nur lokal gespeichert. Vom Kalender werden nur die kommenden Termine (max. 1 Jahr) lokal zwischengespeichert. „Dienstplandaten löschen“ entfernt diese, „Zugang entfernen“ zusätzlich Adresse und Schlüssel.
- Der Service Worker cached nur die eigenen App-Dateien, nie Antworten des Dienstplan-Workers.
- „Alle Daten löschen" in den Einstellungen entfernt alle lokal gespeicherten Kontakte unwiderruflich.

## Technik

Statische Dateien (kein Build-Schritt nötig): `index.html` mit eingebettetem [pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla, Apache-2.0-Lizenz), `dienstplan.js` (ICS-Verarbeitung, Abruf, Formatierung) und `vendor/ical.min.js` ([ical.js](https://github.com/kewisch/ical.js) 2.2.1, Mozilla Public License 2.0). Als GitHub-Pages-taugliche PWA mit `manifest.json` und Service Worker (`sw.js`) für Offline-Nutzung ausgelegt. Der Cloudflare Worker liegt unter `worker/`.

Tests (Node ≥ 20, ohne Abhängigkeiten, nur fiktive Kalenderdaten): `npm test`

## Dienstplan einrichten (Cloudflare Worker, kostenlos)

**Warum ein Worker?** Der Dienstplan-Server erlaubt keinen direkten Abruf aus dem Browser (CORS). Der Worker holt den Kalender serverseitig und gibt ihn nur an dich weiter.

**Sicherheitskonzept**

- Der vollständige private ICS-Link steht **nur** als verschlüsseltes Worker-Secret `ICS_URL` bei Cloudflare – nicht im Code, nicht im Repository, nicht in der App.
- Der Worker ruft ausschließlich diese eine Adresse ab. Es gibt keinen Ziel-URL-Parameter (kein offener Proxy); Query-Parameter, andere Pfade und Methoden werden abgelehnt.
- Zugriff nur mit einem zufälligen **Zugangsschlüssel** (Secret `ACCESS_TOKEN`, mind. 32 Zeichen, Vergleich in konstanter Zeit), den die App als `Authorization: Bearer …`-Header sendet. CORS (`ALLOWED_ORIGINS`) schränkt zusätzlich die Browser-Herkunft ein, ist aber ausdrücklich kein Zugriffsschutz.
- Der Schlüssel wird nur von dir in der App eingegeben und im lokalen Speicher des iPhones abgelegt – nichts ist fest eingebaut.
- Der Worker loggt nichts, Antworten sind `no-store`, Fehlermeldungen enthalten weder Link noch Schlüssel.

> Warum kein Cloudflare Access/Login? Access arbeitet mit Cookies auf der Worker-Domain. Safari blockiert solche Drittanbieter-Cookies bei Abrufen aus einer anderen Domain (GitHub Pages), daher wäre das in der Home-Bildschirm-App unzuverlässig. Ein langer Zufallsschlüssel ist für eine persönliche PWA die robustere Wahl.

**Schritt für Schritt** (alles im Browser möglich, auch am iPhone; kein Mac, keine eigene Domain)

1. **Konto**: Kostenloses Konto auf [dash.cloudflare.com](https://dash.cloudflare.com) anlegen. Beim ersten Worker wird eine Subdomain `<name>.workers.dev` vergeben.
2. **Worker anlegen**: *Workers & Pages → Erstellen → Worker → „Hello World“* mit Namen `rktel-dienstplan` → *Bereitstellen*.
3. **Code einfügen**: *Code bearbeiten* → den Inhalt von [`worker/src/index.js`](worker/src/index.js) vollständig einfügen → *Bereitstellen*.
4. **Zugangsschlüssel erzeugen**: In RKTel unter *Einstellungen → Dienstplan → „Neuen Schlüssel erzeugen“* (wird in die Zwischenablage kopiert). Alternativ am Rechner: `openssl rand -base64 32`.
5. **Variablen und Secrets** (*Worker → Einstellungen → Variablen und Secrets → Hinzufügen*):
   - `ICS_URL` – Typ **Secret** – deinen vollständigen privaten Kalenderlink (`https://dienstplan.st.roteskreuz.at/Calendar/…/Private.ics`) einfügen.
   - `ACCESS_TOKEN` – Typ **Secret** – den Schlüssel aus Schritt 4.
   - `ALLOWED_ORIGINS` – Typ Text – Herkunft der App, z. B. `https://vitushg.github.io` (ohne Pfad, ohne `/` am Ende).
   - `UPSTREAM_HOST` – Typ Text – `dienstplan.st.roteskreuz.at`
   - Speichern/Bereitstellen.
6. **Logs aus**: *Worker → Einstellungen → Beobachtbarkeit* → Workers Logs/Traces deaktivieren (Datensparsamkeit).
7. **In RKTel verbinden**: *Einstellungen → Dienstplan* → Worker-Adresse `https://rktel-dienstplan.<name>.workers.dev` und Schlüssel eintragen → *Speichern & laden*.
8. **Prüfen** (optional): Der Aufruf von `https://rktel-dienstplan.<name>.workers.dev/dienstplan.ics` im Browser muss `{"error":"unauthorized"}` liefern.

Alternativ per Kommandozeile (im Ordner `worker/`): `npx wrangler login`, `npx wrangler secret put ICS_URL`, `npx wrangler secret put ACCESS_TOKEN`, `npx wrangler deploy` (Konfiguration in `worker/wrangler.toml`; `ALLOWED_ORIGINS` dort anpassen).

**Schlüssel wechseln**: Neuen Schlüssel erzeugen → Secret `ACCESS_TOKEN` im Worker ersetzen → in der App eintragen. Der alte Schlüssel ist sofort ungültig. Bei Verdacht auf ein kompromittiertes Gerät außerdem den privaten Kalenderlink im Dienstplan-System neu erzeugen (falls möglich) und `ICS_URL` aktualisieren.

**Verhalten der App**: Abruf beim Öffnen und beim erneuten Aktivieren der App (höchstens alle 5 Minuten, laufende Abrufe werden nicht doppelt gestartet) sowie jederzeit über *Aktualisieren*. Keine Hintergrundabrufe, keine Benachrichtigungen.

**Grenzen des kostenlosen Tarifs** (Stand der Umsetzung, bitte bei Cloudflare prüfen)

- 100.000 Anfragen pro Tag (Reset 00:00 UTC) – bei persönlicher Nutzung praktisch unerreichbar. Bei Überschreitung antwortet der Worker bis zum Reset mit einem Fehler; die App zeigt dann den gespeicherten Stand.
- 10 ms CPU-Zeit pro Anfrage. Die Wartezeit auf den Dienstplan-Server zählt nicht; das ICS wird erst auf dem iPhone ausgewertet. Sehr große Kalender (> 5 MB) lehnt der Worker ab.
- Der Dienstplan-Server sieht Cloudflare-IP-Adressen. Sollte er Rechenzentrums-IPs blockieren, meldet die App „Dienstplan-Server meldet einen Fehler“ – das ließe sich mit einem kostenlosen Worker nicht umgehen.
- `workers.dev`-Adressen sind öffentlich erreichbar; geschützt sind die Daten allein durch den Schlüssel. Kein Rate-Limit für Fehlversuche – bei 256-Bit-Zufallsschlüsseln ist Raten aussichtslos, ein kurzer/selbst ausgedachter Schlüssel wäre es nicht (der Worker verweigert Schlüssel unter 32 Zeichen).
- iOS: Daten von Home-Bildschirm-Apps bleiben erhalten; bei reiner Nutzung im Safari-Tab kann iOS lokale Daten nach längerer Nichtnutzung löschen – dann Zugang neu eintragen.


## Kontakt

Fragen oder Feedback: vitus[at]duck.com
