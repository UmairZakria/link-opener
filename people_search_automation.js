(function () {
  "use strict";

  if (window.__peopleSearchDobLoaded) return;
  window.__peopleSearchDobLoaded = true;

  if (
    !/^(?:www\.)?menstoppingviolence\.org$/i.test(location.hostname) ||
    !/^\/people(?:\/|$)/i.test(location.pathname)
  ) {
    return;
  }

  var startedAt = Date.now();
  var lastSignature = "";
  var stableSince = Date.now();
  var completed = false;
  var scanTimer = null;
  var sessionTimer = null;
  var mutationObserver = null;
  var sessionStarted = false;
  var sessionDeadline = Date.now() + 30000;
  var LOOKUP_TIMEOUT_MS = 20000;
  var NO_RESULTS_SETTLE_MS = 6000;
  var RESULTS_SETTLE_MS = 1500;
  var NO_MATCH_TIMEOUT_MS = 4000;
  var MISSING_DOB_TIMEOUT_MS = 6000;

  var MONTH_NAMES = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];
  var MONTH_ABBR = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec"
  ];

  function toTitleCase(s) {
    if (!s) return "";
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  }

  function getMonthIndex(name) {
    if (!name) return -1;
    var lower = name.toLowerCase().replace(/\.$/, "");
    var idx = MONTH_NAMES.indexOf(lower);
    if (idx !== -1) return idx;
    return MONTH_ABBR.indexOf(lower.slice(0, 3));
  }

  function parseDateFromText(text) {
    if (!text) return null;
    var str = String(text).replace(/\s+/g, " ").trim();

    // Pattern 1: explicit label + Month Day Year or Month Year
    // e.g. "born on February 28, 1948", "born in February 1948", "born February 28, 1948", "DOB: Feb 28, 1948"
    var p1 = /\b(?:born(?:\s+on|\s+in|\s+at)?|birth\s*date|date\s+of\s+birth|dob|birthday)\s*:?\s*([A-Za-z]{3,9})\.?\s*(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})\b/i;
    var m = p1.exec(str);
    if (m) {
      var mIdx = getMonthIndex(m[1]);
      if (mIdx !== -1) {
        var yr = parseInt(m[3], 10);
        var day = m[2] ? parseInt(m[2], 10) : null;
        var fullMonth = toTitleCase(MONTH_NAMES[mIdx]);
        return {
          month: mIdx,
          year: yr,
          day: day,
          text: day ? (fullMonth + " " + day + ", " + yr) : (fullMonth + " " + yr)
        };
      }
    }

    // Pattern 2: explicit label + Day Month Year
    // e.g. "born on 28 February 1948", "born 28th Feb, 1948"
    var p2 = /\b(?:born(?:\s+on|\s+in|\s+at)?|birth\s*date|date\s+of\s+birth|dob|birthday)\s*:?\s*(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/i;
    m = p2.exec(str);
    if (m) {
      var mIdx2 = getMonthIndex(m[2]);
      if (mIdx2 !== -1) {
        var yr2 = parseInt(m[3], 10);
        var day2 = parseInt(m[1], 10);
        var fullMonth2 = toTitleCase(MONTH_NAMES[mIdx2]);
        return {
          month: mIdx2,
          year: yr2,
          day: day2,
          text: fullMonth2 + " " + day2 + ", " + yr2
        };
      }
    }

    // Pattern 3: explicit label + numeric date
    // e.g. "born on 02/28/1948", "DOB: 2-28-1948"
    var p3 = /\b(?:born(?:\s+on|\s+in|\s+at)?|birth\s*date|date\s+of\s+birth|dob|birthday)\s*:?\s*(0?[1-9]|1[0-2])[\/\-](0?[1-9]|[12]\d|3[01])[\/\-](\d{4})\b/i;
    m = p3.exec(str);
    if (m) {
      var mIdx3 = parseInt(m[1], 10) - 1;
      var day3 = parseInt(m[2], 10);
      var yr3 = parseInt(m[3], 10);
      var fullMonth3 = toTitleCase(MONTH_NAMES[mIdx3]);
      return {
        month: mIdx3,
        year: yr3,
        day: day3,
        text: fullMonth3 + " " + day3 + ", " + yr3
      };
    }

    // Pattern 4: Month Day, Year followed by age
    // e.g. "February 28, 1948, is 78 years of age"
    var p4 = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s*[,;(]?\s*(?:and\s+)?(?:is\s+)?(?:age\s*)?(\d{1,3})\s*(?:years?(?:\s+old)?|yrs?|yo)\b/i;
    m = p4.exec(str);
    if (m) {
      var mIdx4 = getMonthIndex(m[1]);
      if (mIdx4 !== -1) {
        var yr4 = parseInt(m[3], 10);
        var day4 = parseInt(m[2], 10);
        var fullMonth4 = toTitleCase(MONTH_NAMES[mIdx4]);
        return {
          month: mIdx4,
          year: yr4,
          day: day4,
          text: fullMonth4 + " " + day4 + ", " + yr4
        };
      }
    }

    return null;
  }

  function parseTargetDob(targetDob, targetYear) {
    var str = String(targetDob || "").trim();

    // Try named month: "Feb 1948", "February 1948", "Feb 28, 1948", "February 28, 1948"
    var m = str.match(/^([A-Za-z]{3,9})\.?\s*(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/i);
    if (m) {
      var mIdx = getMonthIndex(m[1]);
      if (mIdx !== -1) {
        return { month: mIdx, year: parseInt(m[3], 10) };
      }
    }

    // Try numeric: "02/1948", "02/28/1948"
    var num = str.match(/^(0?[1-9]|1[0-2])[\/\-](?:(0?[1-9]|[12]\d|3[01])[\/\-])?(\d{4})$/);
    if (num) {
      return { month: parseInt(num[1], 10) - 1, year: parseInt(num[2] || num[3], 10) };
    }

    // Try using targetYear if month word exists
    if (targetYear) {
      var wordMatch = str.match(/([A-Za-z]{3,9})/);
      if (wordMatch) {
        var wIdx = getMonthIndex(wordMatch[1]);
        if (wIdx !== -1) {
          return { month: wIdx, year: parseInt(targetYear, 10) };
        }
      }
    }

    return null;
  }

  function nameParts(value) {
    var parts = String(value || "")
      .replace(/,\s*\d{1,3}.*$/, "")
      .replace(/\b(?:jr|sr|ii|iii|iv|v)\b\.?/gi, " ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return parts.length >= 2 ? parts : [];
  }

  function namesMatch(expectedName, candidateName) {
    var expected = nameParts(expectedName);
    var candidate = nameParts(candidateName);
    if (expected.length < 2 || candidate.length < 2) return false;

    var expectedFirst = expected[0];
    var candidateFirst = candidate[0];
    var expectedLast = expected[expected.length - 1];
    var candidateLast = candidate[candidate.length - 1];

    if (expectedLast !== candidateLast) return false;
    return (
      expectedFirst === candidateFirst ||
      expectedFirst.charAt(0) === candidateFirst.charAt(0)
    );
  }

  function getCardNames(card) {
    var names = [];
    var headingAnchor = card.querySelector(".name-cards-head h2 a, h2 a, .name-cards-head a");
    if (headingAnchor) {
      var text = headingAnchor.textContent.replace(/\s+/g, " ").trim();
      if (text) names.push(text);
    }
    var heading = card.querySelector(".name-cards-head h2, h2");
    if (heading) {
      var clone = heading.cloneNode(true);
      var loc = clone.querySelector(".person-location");
      if (loc) loc.remove();
      var hText = clone.textContent.replace(/\s+/g, " ").trim();
      if (hText && names.indexOf(hText) === -1) names.push(hText);
    }
    var descElem = card.querySelector(".name-cards-grid-description p, .name-cards-block__text p, p");
    if (descElem) {
      var descMatch = (descElem.textContent || "").trim().match(/^([A-Za-z]+(?:\s+[A-Za-z]\.?)?\s+[A-Za-z]+)(?:,|\s+born)/i);
      if (descMatch && names.indexOf(descMatch[1]) === -1) {
        names.push(descMatch[1]);
      }
    }
    return names;
  }

  function copyToClipboard(text) {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).catch(function () {
          fallbackCopy(text);
        });
      } else {
        fallbackCopy(text);
      }
    } catch (e) {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    try {
      var textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    } catch (e) {}
  }

  function cleanup() {
    if (scanTimer) clearInterval(scanTimer);
    if (sessionTimer) clearInterval(sessionTimer);
    if (mutationObserver) mutationObserver.disconnect();
    scanTimer = null;
    sessionTimer = null;
    mutationObserver = null;
  }

  function report(session, status, dob, name, message) {
    if (completed) return;
    completed = true;
    cleanup();

    if (status === "match" && dob) {
      copyToClipboard(dob);
    }

    try {
      chrome.runtime.sendMessage({
        action: "DOB_LOOKUP_PEOPLE_RESULT",
        lookupId: session.lookupId,
        status: status,
        dob: dob || "",
        name: name || "",
        message: message || ""
      }, function () {
        if (chrome.runtime.lastError) {
          console.error("[People Search DOB] Could not relay the result:", chrome.runtime.lastError.message);
        }
      });
    } catch (error) {
      console.error("[People Search DOB] Could not report the search result:", error);
    }
  }

  function scanCards(session) {
    if (completed) return;

    var cards = Array.from(document.querySelectorAll(".name-cards-block, [class*='name-cards-block']"));
    var signature = cards.map(function (card) {
      return (card.textContent || "").replace(/\s+/g, " ").trim();
    }).join("|");

    if (signature !== lastSignature) {
      lastSignature = signature;
      stableSince = Date.now();
    }

    var targetNames = [session.targetName].concat(
      Array.isArray(session.targetAliases) ? session.targetAliases : []
    ).filter(Boolean);
    var targetIdentityWithoutDob = false;

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var candidateNames = getCardNames(card);
      var identityMatches = candidateNames.some(function (cName) {
        return targetNames.some(function (tName) {
          return namesMatch(tName, cName);
        });
      });
      if (!identityMatches) continue;

      var description =
        card.querySelector(".name-cards-grid-description .name-cards-block__text p") ||
        card.querySelector(".name-cards-grid-description .name-cards-block__text") ||
        card.querySelector(".name-cards-grid-description") ||
        card.querySelector(".name-cards-block__text p") ||
        card.querySelector(".name-cards-block__text");

      var date = parseDateFromText(description ? description.textContent : "");
      if (!date) date = parseDateFromText(card.textContent);
      if (!date) {
        targetIdentityWithoutDob = true;
        continue;
      }

      if (
        date.month === session.expectedMonth &&
        date.year === session.expectedYear
      ) {
        var cardDisplayHeading = candidateNames.length ? candidateNames[0] : session.targetName;
        report(session, "match", date.text, cardDisplayHeading, "Exact name and birth month/year match.");
        return;
      }
    }

    var settledFor = Date.now() - stableSince;
    if (
      cards.length &&
      settledFor >= RESULTS_SETTLE_MS &&
      Date.now() - startedAt >= NO_MATCH_TIMEOUT_MS &&
      !targetIdentityWithoutDob
    ) {
      report(
        session,
        "no_match",
        "",
        "",
        "No result card matched both a known name and the exact birth month and year."
      );
      return;
    }
    if (!cards.length && Date.now() - startedAt >= NO_RESULTS_SETTLE_MS) {
      report(session, "no_match", "", "", "No people-search result cards were found.");
      return;
    }
    if (targetIdentityWithoutDob && Date.now() - startedAt >= MISSING_DOB_TIMEOUT_MS) {
      report(session, "error", "", "", "A matching name card appeared, but its birth date could not be extracted.");
      return;
    }
    if (Date.now() - startedAt >= LOOKUP_TIMEOUT_MS) {
      report(
        session,
        "error",
        "",
        "",
        "People-search results did not finish loading."
      );
    }
  }

  function startLookup(lookupId, session) {
    if (sessionStarted || !session || !session.exactDobSearch || session.lookupId !== lookupId) return;
    sessionStarted = true;
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = null;

    var expectedDate = parseTargetDob(session.targetDob, session.targetYear);
    if (!expectedDate) {
      report(session, "error", "", "", "The expected birth month and year are invalid.");
      return;
    }
    session.expectedMonth = expectedDate.month;
    session.expectedYear = expectedDate.year;

    try {
      chrome.runtime.sendMessage({
        action: "DOB_LOOKUP_PEOPLE_PROGRESS",
        lookupId: session.lookupId,
        message: "Scanning people-search result cards."
      });
    } catch (error) {
      console.error("[People Search DOB] Could not report scan progress:", error);
    }

    scanCards(session);
    if (!completed) {
      scanTimer = setInterval(function () {
        scanCards(session);
      }, 300);

      try {
        mutationObserver = new MutationObserver(function () {
          scanCards(session);
        });
        mutationObserver.observe(document.documentElement, {
          childList: true,
          subtree: true
        });
      } catch (e) {}
    }
  }

  function requestLookupSession() {
    if (sessionStarted || completed) return;
    chrome.runtime.sendMessage({ action: "DOB_LOOKUP_PEOPLE_READY" }, function (response) {
      if (chrome.runtime.lastError) {
        if (Date.now() >= sessionDeadline) {
          console.error("[People Search DOB] Could not get lookup details from the extension:", chrome.runtime.lastError.message);
        }
      } else if (response && response.ok && response.session) {
        startLookup(response.session.lookupId, response.session);
      } else if (Date.now() >= sessionDeadline) {
        console.error(
          "[People Search DOB] No active lookup was assigned to this tab:",
          response && response.error ? response.error : "No lookup details were returned."
        );
      }
    });
    if (Date.now() >= sessionDeadline && sessionTimer) {
      clearInterval(sessionTimer);
      sessionTimer = null;
    }
  }

  requestLookupSession();
  if (!sessionStarted) sessionTimer = setInterval(requestLookupSession, 300);
})();
