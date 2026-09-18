# RKTel

RKTel ist ein lokales Telefonbuch für Einsatzmittel als Progressive Web App (PWA). Alle Daten bleiben ausschließlich auf dem Gerät der Nutzerin/des Nutzers – es gibt keinen Server und keine Übertragung von Daten.

## Funktionen

- **Kontakte verwalten**: Hinzufügen, Bearbeiten, Löschen – mit Name, Dienststelle, mehreren Telefonnummern und Notiz.
- **PDF-Import**: Telefonlisten als PDF importieren (Drag & Drop oder Dateiauswahl unter Einstellungen). Die Verarbeitung erfolgt vollständig im Browser, es wird nichts hochgeladen.
- **Favoriten**: Kontakte anpinnen – sie erscheinen dann oben auf der Kontakte-Seite für schnellen Zugriff.
- **Kurzwahl für Einsatzmittel**: Eine Basisnummer (z. B. Diensthandy-Präfix) in den Einstellungen hinterlegen; auf der Kontakte-Seite wird sie live mit der eingegebenen Einsatzmittel-Nummer zur vollständigen Rufnummer kombiniert.
- **Installierbar als App**: Über „Zum Home-Bildschirm hinzufügen" (iOS/Android) lässt sich RKTel wie eine native App nutzen, inklusive Offline-Fähigkeit über einen Service Worker.
- **JSON-Export**: Alle Kontakte lassen sich als JSON-Datei sichern.

## PDF-Import im Detail

Der Import ist auf das PDF-Format des ÖRK-Online-Dienstplans zugeschnitten (*Mitarbeiter → Downloads → „Telefonnummern"-Export*). Aus jeder importierten Liste werden automatisch erkannt:

- **Dienststelle** – aus der Kopfzeile „TELEFON \<Dienststelle\>"
- **Erstellungsdatum** – aus der Fußzeile „Online erstellt am … Seite …"

Beim Import werden E-Mail-Adressen sowie Qualifikationszusätze in Klammern (z. B. „(RS, SEF)") verworfen. Neue Kontakte werden anhand des Namens mit bereits vorhandenen zusammengeführt: Telefonnummern werden ergänzt, mehrere Quellen (Dienststelle + Datum) je Kontakt gesammelt und in den Kontaktdetails angezeigt.

Liegt ein PDF in einem anderen Format vor, werden keine oder falsche Kontakte erkannt – der Import meldet dann „Keine Kontakte erkannt."

## Datenhaltung & Datenschutz

- Alle Kontakte, die Kurzwahl-Basisnummer und sonstige Einstellungen werden ausschließlich im `localStorage` des Browsers gespeichert.
- Es gibt keinen Server, keine Analyse- oder Tracking-Skripte, keine externe Datenübertragung.
- „Alle Daten löschen" in den Einstellungen entfernt alle lokal gespeicherten Kontakte unwiderruflich.

## Technik

Eine einzelne statische `index.html`-Datei (kein Build-Schritt nötig). Das PDF-Parsing läuft client-seitig mit eingebettetem [pdf.js](https://mozilla.github.io/pdf.js/) (Mozilla, Apache-2.0-Lizenz). Als GitHub-Pages-taugliche PWA mit `manifest.json` und Service Worker (`sw.js`) für Offline-Nutzung ausgelegt.

## Kontakt

Fragen oder Feedback: vitus[at]duck.com
