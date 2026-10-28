/*
 * RKTel – Dienstplan-Logik (ohne DOM): ICS verarbeiten, über den eigenen
 * Cloudflare Worker laden, Abrufe entprellen, Termine formatieren.
 * Im Browser als window.RKDienstplan verfügbar, in Node per require() (Tests).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vendor/ical.min.js"));
  } else {
    root.RKDienstplan = factory(root.ICAL);
  }
})(typeof self !== "undefined" ? self : this, function (ICAL) {
  "use strict";

  var DAY_MS = 24 * 60 * 60 * 1000;
  var MAX_ITERATIONS_PER_SERIES = 20000;

  // ---------- Zeitzonen ----------

  // Häufige Windows-/Outlook-Zeitzonennamen, die ohne VTIMEZONE vorkommen können.
  var WINDOWS_ZONES = {
    "W. Europe Standard Time": "Europe/Berlin",
    "Central Europe Standard Time": "Europe/Budapest",
    "Central European Standard Time": "Europe/Warsaw",
    "Romance Standard Time": "Europe/Paris",
    "GMT Standard Time": "Europe/London",
    "UTC": "UTC",
    "Coordinated Universal Time": "UTC"
  };

  var dtfCache = {};

  function isValidIanaZone(tz) {
    if (!tz) return false;
    if (Object.prototype.hasOwnProperty.call(dtfCache, tz)) return !!dtfCache[tz];
    try {
      dtfCache[tz] = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    } catch (e) {
      dtfCache[tz] = null;
    }
    return !!dtfCache[tz];
  }

  // TZID aus dem Kalender auf eine IANA-Zone abbilden, z. B.
  // "Europe/Vienna", "/mozilla.org/20050126_1/Europe/Vienna", "W. Europe Standard Time".
  function resolveTzid(tzid) {
    if (!tzid) return null;
    var id = String(tzid).trim().replace(/^"|"$/g, "");
    if (WINDOWS_ZONES[id] && isValidIanaZone(WINDOWS_ZONES[id])) return WINDOWS_ZONES[id];
    if (isValidIanaZone(id)) return id;
    var m = id.match(/([A-Za-z]+\/[A-Za-z_\-]+(?:\/[A-Za-z_\-]+)?)$/);
    if (m && isValidIanaZone(m[1])) return m[1];
    return null;
  }

  function zoneOffsetMs(tz, epochMs) {
    var parts = dtfCache[tz].formatToParts(new Date(epochMs));
    var v = {};
    parts.forEach(function (p) { v[p.type] = p.value; });
    var hour = Number(v.hour) % 24;
    var asUtc = Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day), hour, Number(v.minute), Number(v.second));
    return asUtc - Math.floor(epochMs / 1000) * 1000;
  }

  // Wandzeit in einer IANA-Zone -> UTC-Millisekunden (inkl. Sommerzeit).
  function wallTimeToEpoch(y, mo, d, h, mi, s, tz) {
    var guess = Date.UTC(y, mo - 1, d, h, mi, s);
    var off1 = zoneOffsetMs(tz, guess);
    var t = guess - off1;
    var off2 = zoneOffsetMs(tz, t);
    if (off2 !== off1) t = guess - off2;
    return t;
  }

  function isFloatingZone(time) {
    return !time.zone || time.zone.tzid === "floating";
  }

  // ICAL.Time -> UTC-Millisekunden. fallbackTzid: TZID-Parameter der Eigenschaft.
  function timeToEpoch(time, fallbackTzid) {
    if (time.isDate) {
      return new Date(time.year, time.month - 1, time.day).getTime();
    }
    if (!isFloatingZone(time)) {
      return time.toUnixTime() * 1000;
    }
    var tz = resolveTzid(time.timezone || fallbackTzid);
    if (tz) {
      return wallTimeToEpoch(time.year, time.month, time.day, time.hour, time.minute, time.second, tz);
    }
    // Echte "floating" Zeit oder unbekannte Zone: Gerätezeitzone.
    return new Date(time.year, time.month - 1, time.day, time.hour, time.minute, time.second).getTime();
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  function dateKey(time) {
    return time.year + "-" + pad2(time.month) + "-" + pad2(time.day);
  }

  // ---------- ICS -> kommende Termine ----------

  function propTzid(component, name) {
    var p = component.getFirstProperty(name);
    return p ? p.getParameter("tzid") : null;
  }

  function textProp(component, name) {
    var v = component.getFirstPropertyValue(name);
    return v == null ? "" : String(v).trim();
  }

  function isCancelled(component) {
    return textProp(component, "status").toUpperCase() === "CANCELLED";
  }

  function buildOccurrence(component, startTime, endTime, uid) {
    var allDay = !!startTime.isDate;
    var startTz = propTzid(component, "dtstart");
    var endTz = propTzid(component, "dtend") || startTz;
    var start = timeToEpoch(startTime, startTz);
    var end;
    var hasEnd = component.hasProperty("dtend") || component.hasProperty("duration");

    if (allDay) {
      end = hasEnd && endTime ? timeToEpoch(endTime, endTz) : start + DAY_MS;
      if (end <= start) end = new Date(startTime.year, startTime.month - 1, startTime.day + 1).getTime();
    } else {
      end = hasEnd && endTime ? timeToEpoch(endTime, endTz) : start;
      if (end < start) end = start;
    }

    var occ = {
      id: uid + "|" + start,
      uid: uid,
      title: textProp(component, "summary") || "(ohne Titel)",
      location: textProp(component, "location"),
      start: start,
      end: end,
      allDay: allDay,
      cancelled: isCancelled(component)
    };
    if (allDay) {
      occ.startDate = dateKey(startTime);
      // DTEND ist bei ganztägigen Terminen exklusiv -> letzter Tag = Ende - 1 Tag
      var last = new Date(end - 1);
      occ.endDate = last.getFullYear() + "-" + pad2(last.getMonth() + 1) + "-" + pad2(last.getDate());
    }
    return occ;
  }

  function CalendarError(code, message) {
    var err = new Error(message || code);
    err.name = "CalendarError";
    err.code = code;
    return err;
  }

  /**
   * Liest einen ICS-Text und liefert die kommenden Termine (Ende > now),
   * sortiert nach Beginn. Wiederholungen werden bis now + horizonDays
   * aufgelöst; EXDATE, RECURRENCE-ID-Ausnahmen und STATUS:CANCELLED werden
   * berücksichtigt.
   */
  function parseCalendar(icsText, options) {
    options = options || {};
    var now = options.now != null ? options.now : Date.now();
    var horizonEnd = now + (options.horizonDays || 365) * DAY_MS;
    var maxItems = options.maxItems || 500;

    if (typeof icsText !== "string" || icsText.indexOf("BEGIN:VCALENDAR") === -1) {
      throw CalendarError("invalid", "Keine gültigen Kalenderdaten (BEGIN:VCALENDAR fehlt).");
    }

    var root;
    try {
      var jcal = ICAL.parse(icsText);
      root = new ICAL.Component(jcal);
      if (root.name !== "vcalendar") root = root.getFirstSubcomponent("vcalendar");
    } catch (e) {
      throw CalendarError("invalid", "Kalenderdaten konnten nicht gelesen werden.");
    }
    if (!root) throw CalendarError("invalid", "Kein VCALENDAR gefunden.");

    // Nach UID gruppieren: Hauptereignis + geänderte Einzeltermine (RECURRENCE-ID)
    var groups = new Map();
    root.getAllSubcomponents("vevent").forEach(function (comp, idx) {
      var uid = textProp(comp, "uid") || "no-uid-" + idx;
      if (!groups.has(uid)) groups.set(uid, { master: null, exceptions: [] });
      var g = groups.get(uid);
      if (comp.hasProperty("recurrence-id")) g.exceptions.push(comp);
      else if (!g.master) g.master = comp;
    });

    var result = [];

    function consider(occ) {
      if (occ.end > now || (occ.end === occ.start && occ.start >= now)) {
        if (occ.start <= horizonEnd) result.push(occ);
      }
    }

    groups.forEach(function (g, uid) {
      if (!g.master) {
        // Ausnahme ohne Hauptereignis im Feed -> als Einzeltermin behandeln
        g.exceptions.forEach(function (exc) {
          var ev = new ICAL.Event(exc);
          if (!ev.startDate) return;
          consider(buildOccurrence(exc, ev.startDate, ev.endDate, uid));
        });
        return;
      }

      var event = new ICAL.Event(g.master, { strictExceptions: false });
      if (!event.startDate) return;
      g.exceptions.forEach(function (exc) {
        try { event.relateException(exc); } catch (e) { /* ungültige Ausnahme ignorieren */ }
      });

      if (!event.isRecurring()) {
        consider(buildOccurrence(g.master, event.startDate, event.endDate, uid));
        return;
      }

      var masterTz = propTzid(g.master, "dtstart");
      var iterator = event.iterator();
      var next, guard = 0;
      while ((next = iterator.next())) {
        if (++guard > MAX_ITERATIONS_PER_SERIES) break;
        // Ab hier liegt die (ursprüngliche) Terminzeit hinter dem Horizont
        if (timeToEpoch(next, masterTz) > horizonEnd) break;
        var details = event.getOccurrenceDetails(next);
        var comp = details.item.component;
        var occ = buildOccurrence(comp, details.startDate, details.endDate, uid);
        if (isCancelled(g.master)) occ.cancelled = true;
        consider(occ);
      }
    });

    result.sort(function (a, b) { return a.start - b.start || a.end - b.end || a.title.localeCompare(b.title); });
    if (result.length > maxItems) result = result.slice(0, maxItems);
    return result;
  }

  // ---------- Worker-Abruf ----------

  var MIN_TOKEN_LENGTH = 32;

  /** Worker-Adresse prüfen und normalisieren. Gibt null zurück, wenn ungültig. */
  function normalizeWorkerUrl(input) {
    var raw = String(input || "").trim();
    if (!raw) return null;
    var url;
    try { url = new URL(raw); } catch (e) { return null; }
    var isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (url.protocol !== "https:" && !(isLocal && url.protocol === "http:")) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    var path = url.pathname.replace(/\/dienstplan\.ics$/, "").replace(/\/+$/, "");
    return url.origin + path;
  }

  var ERROR_MESSAGES = {
    not_configured: "Dienstplan ist noch nicht eingerichtet. Worker-Adresse und Zugangsschlüssel unter Einstellungen eintragen.",
    offline: "Keine Internetverbindung.",
    network: "Worker nicht erreichbar. Worker-Adresse, Internetverbindung und erlaubte Herkunft (ALLOWED_ORIGINS) prüfen.",
    timeout: "Zeitüberschreitung beim Laden des Dienstplans.",
    unauthorized: "Zugangsschlüssel ungültig. Bitte unter Einstellungen prüfen.",
    forbidden: "Zugriff von dieser Adresse nicht erlaubt (ALLOWED_ORIGINS im Worker prüfen).",
    not_found: "Worker-Adresse falsch (Endpunkt nicht gefunden).",
    worker_config: "Worker ist unvollständig eingerichtet (Secrets ICS_URL / ACCESS_TOKEN prüfen).",
    upstream_timeout: "Der Dienstplan-Server antwortet nicht.",
    upstream_unreachable: "Der Dienstplan-Server ist nicht erreichbar.",
    upstream_status: "Der Dienstplan-Server meldet einen Fehler. Ist der private Kalenderlink noch gültig?",
    upstream_invalid: "Der Dienstplan-Server hat keine Kalenderdaten geliefert. Ist der private Kalenderlink noch gültig?",
    upstream_too_large: "Der Kalender ist zu groß.",
    rate_limited: "Zu viele Anfragen. Bitte später erneut versuchen (evtl. Tageslimit des kostenlosen Cloudflare-Tarifs erreicht).",
    invalid: "Die geladenen Daten sind kein gültiger Kalender.",
    server: "Unerwarteter Fehler im Worker.",
    storage: "Dienstplan konnte nicht lokal gespeichert werden (Speicher voll?)."
  };

  function errorMessage(code, detail) {
    var msg = ERROR_MESSAGES[code] || ERROR_MESSAGES.server;
    if (detail && detail.status && code === "upstream_status") msg += " (HTTP " + detail.status + ")";
    return msg;
  }

  function FetchError(code, detail) {
    var err = new Error(errorMessage(code, detail));
    err.name = "FetchError";
    err.code = code;
    err.detail = detail || null;
    return err;
  }

  /**
   * Lädt den ICS-Text vom eigenen Worker. Zugangsschlüssel geht als
   * Bearer-Token im Header mit (nie in der URL). Wirft FetchError.
   */
  async function fetchCalendarText(config, deps) {
    deps = deps || {};
    var fetchImpl = deps.fetch || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    var timeoutMs = deps.timeoutMs || 20000;
    var isOnline = deps.isOnline || function () {
      return typeof navigator === "undefined" || navigator.onLine !== false;
    };

    var base = config && normalizeWorkerUrl(config.url);
    if (!base || !config.token) throw FetchError("not_configured");

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; if (controller) controller.abort(); }, timeoutMs);

    var res;
    try {
      res = await fetchImpl(base + "/dienstplan.ics", {
        method: "GET",
        headers: { "Authorization": "Bearer " + config.token, "Accept": "text/calendar" },
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller ? controller.signal : undefined
      });
    } catch (e) {
      clearTimeout(timer);
      if (timedOut) throw FetchError("timeout");
      if (!isOnline()) throw FetchError("offline");
      throw FetchError("network");
    }

    var text;
    try {
      text = await res.text();
    } catch (e) {
      clearTimeout(timer);
      throw FetchError(timedOut ? "timeout" : "network");
    }
    clearTimeout(timer);

    if (!res.ok) {
      var body = null;
      try { body = JSON.parse(text); } catch (e) { /* kein JSON */ }
      var code;
      if (res.status === 401) code = "unauthorized";
      else if (res.status === 403) code = "forbidden";
      else if (res.status === 404) code = "not_found";
      else if (res.status === 429) code = "rate_limited";
      else if (body && body.error && ERROR_MESSAGES[body.error]) code = body.error;
      else code = "server";
      throw FetchError(code, { status: body && body.status, httpStatus: res.status });
    }
    if (text.indexOf("BEGIN:VCALENDAR") === -1) throw FetchError("invalid");
    return text;
  }

  // ---------- Abrufe entprellen ----------

  /**
   * Verhindert doppelte Abrufe: läuft bereits einer, wird dessen Promise
   * zurückgegeben. Automatische Abrufe (force=false) werden übersprungen,
   * wenn der letzte Versuch oder der letzte Erfolg zu kurz zurückliegt.
   */
  function createRefresher(opts) {
    var now = opts.now || Date.now;
    var minAttemptGapMs = opts.minAttemptGapMs != null ? opts.minAttemptGapMs : 60 * 1000;
    var minSuccessAgeMs = opts.minSuccessAgeMs != null ? opts.minSuccessAgeMs : 5 * 60 * 1000;
    var getLastSuccess = opts.getLastSuccess || function () { return 0; };
    var inflight = null;
    var lastAttempt = 0;

    return {
      refresh: function (force) {
        if (inflight) return inflight;
        var t = now();
        if (!force) {
          if (lastAttempt && t - lastAttempt < minAttemptGapMs) return Promise.resolve({ skipped: true });
          var ls = getLastSuccess();
          if (ls && t - ls < minSuccessAgeMs) return Promise.resolve({ skipped: true });
        }
        lastAttempt = t;
        inflight = Promise.resolve()
          .then(opts.run)
          .finally(function () { inflight = null; });
        return inflight;
      },
      isRunning: function () { return !!inflight; }
    };
  }

  // ---------- Formatierung ----------

  var LOCALE = "de-AT";
  var fmtDate = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  var fmtShortDate = new Intl.DateTimeFormat(LOCALE, { weekday: "short", day: "2-digit", month: "2-digit" });
  var fmtTime = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

  function parseDateKey(key) {
    var p = key.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]);
  }

  function dayDiff(a, b) {
    // Kalendertage zwischen zwei Daten (lokal), robust gegen Sommerzeit
    var ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    var ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((ub - ua) / DAY_MS);
  }

  /** Anzeige-Texte für einen Termin: Datum, Zeitraum, relativer Hinweis. */
  function formatOccurrence(occ, now) {
    now = now != null ? now : Date.now();
    var nowDate = new Date(now);
    var startDate = occ.allDay ? parseDateKey(occ.startDate) : new Date(occ.start);
    var dateLabel = fmtDate.format(startDate);
    var timeLabel;

    if (occ.allDay) {
      var lastDay = parseDateKey(occ.endDate);
      timeLabel = dayDiff(startDate, lastDay) > 0
        ? "Ganztägig bis " + fmtDate.format(lastDay)
        : "Ganztägig";
    } else {
      var endDate = new Date(occ.end);
      var s = fmtTime.format(startDate);
      var e = fmtTime.format(endDate);
      var diff = dayDiff(startDate, endDate);
      if (occ.end === occ.start) timeLabel = s + " Uhr";
      else if (diff === 0) timeLabel = s + " – " + e + " Uhr";
      else if (diff === 1) timeLabel = s + " – " + e + " Uhr (Folgetag)";
      else timeLabel = s + " Uhr – " + fmtShortDate.format(endDate) + ", " + e + " Uhr";
    }

    var relative = "";
    var running = !occ.cancelled && occ.start <= now && now < occ.end;
    if (running) relative = "Läuft gerade";
    else {
      var d = dayDiff(nowDate, startDate);
      if (d === 0) relative = "Heute";
      else if (d === 1) relative = "Morgen";
      else if (d > 1 && d < 7) relative = "in " + d + " Tagen";
    }

    return { dateLabel: dateLabel, timeLabel: timeLabel, relative: relative, running: running };
  }

  function formatTimestamp(ms) {
    var d = new Date(ms);
    return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + "." + d.getFullYear() + ", " +
      pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " Uhr";
  }

  /** Zufälliger Zugangsschlüssel (256 Bit, URL-sicheres Base64). */
  function generateToken() {
    var bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    var bin = "";
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  return {
    parseCalendar: parseCalendar,
    timeToEpoch: timeToEpoch,
    resolveTzid: resolveTzid,
    wallTimeToEpoch: wallTimeToEpoch,
    normalizeWorkerUrl: normalizeWorkerUrl,
    fetchCalendarText: fetchCalendarText,
    errorMessage: errorMessage,
    createRefresher: createRefresher,
    formatOccurrence: formatOccurrence,
    formatTimestamp: formatTimestamp,
    generateToken: generateToken,
    MIN_TOKEN_LENGTH: MIN_TOKEN_LENGTH
  };
});
