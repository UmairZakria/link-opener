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
  var stableSince = 0;
  var completed = false;
  var scanTimer = null;
  var sessionTimer = null;
  var sessionStarted = false;
  var sessionDeadline = Date.now() + 10000;
  var LOOKUP_TIMEOUT_MS = 10000;
  var NO_RESULTS_SETTLE_MS = 5000;
  var RESULTS_SETTLE_MS = 1000;
  var NO_MATCH_TIMEOUT_MS = 2500;
  var MISSING_DOB_TIMEOUT_MS = 5000;

  function parseMonthYear(value) {
    var monthNames = [
      "january", "february", "march", "april", "may", "june",
      "july", "august", "september", "october", "november", "december"
    ];
    var text = String(value || "");
    var label = /\b(?:born(?:\s+on|\s+in)?|date\s+of\s+birth|birth\s+date|dob)\s*:?\s*/i;
    var labelMatch = label.exec(text);
    if (!labelMatch) return null;
    var dobText = text.slice(labelMatch.index + labelMatch[0].length);
    var namedDate = dobText.match(/^([A-Za-z]{3,9})\.?,?\s+(?:(\d{1,2})(?:st|nd|rd|th)?[,]?\s*)?(19\d{2}|20\d{2})\b/i);
    var monthIndex;
    var year;
    if (namedDate) {
      monthIndex = monthNames.findIndex(function (month) {
        return month === namedDate[1].toLowerCase() ||
          month.slice(0, 3) === namedDate[1].toLowerCase();
      });
      year = parseInt(namedDate[3], 10);
    } else {
      var numericDate = dobText.match(/^(?:(19\d{2}|20\d{2})[-/.](\d{1,2})[-/.]\d{1,2}|(\d{1,2})[-/.]\d{1,2}[-/.](19\d{2}|20\d{2}))\b/);
      if (!numericDate) return null;
      monthIndex = parseInt(numericDate[2] || numericDate[3], 10) - 1;
      year = parseInt(numericDate[1] || numericDate[4], 10);
    }
    if (monthIndex < 0 || monthIndex > 11) return null;
    return {
      month: monthIndex,
      year: year,
      text: monthNames[monthIndex].charAt(0).toUpperCase() +
        monthNames[monthIndex].slice(1) + " " + year
    };
  }

  function nameParts(value) {
    var parts = String(value || "")
      .replace(/,\s*\d{1,3}\s*$/, "")
      .replace(/\b(?:jr|sr|ii|iii|iv|v)\b\.?/gi, " ")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return parts.length > 1 ? parts : [];
  }

  function namesMatch(expectedName, candidateName) {
    var expected = nameParts(expectedName);
    var candidate = nameParts(candidateName);
    if (expected.length < 2 || candidate.length < 2) return false;

    var expectedFirst = expected[0];
    var candidateFirst = candidate[0];
    var expectedLast = expected[expected.length - 1];
    var candidateLast = candidate[candidate.length - 1];
    return expectedLast === candidateLast &&
      (expectedFirst === candidateFirst ||
        expectedFirst.charAt(0) === candidateFirst.charAt(0));
  }

  function report(session, status, dob, name, message) {
    if (completed) return;
    completed = true;
    if (scanTimer) clearInterval(scanTimer);
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = null;
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
    var cards = Array.from(document.querySelectorAll(".name-cards-block"));
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
      var heading = card.querySelector(".name-cards-head h2 a, .name-cards-head h2");
      var cardName = heading ? heading.textContent.replace(/\s+/g, " ").trim() : "";
      var identityMatches = targetNames.some(function (name) {
        return namesMatch(name, cardName);
      });
      if (!identityMatches) continue;

      var description =
        card.querySelector(".name-cards-grid-description .name-cards-block__text") ||
        card.querySelector(".name-cards-block__text");
      var date = parseMonthYear(description ? description.textContent : "");
      if (!date) date = parseMonthYear(card.textContent);
      if (!date) {
        targetIdentityWithoutDob = true;
        continue;
      }
      if (
        date &&
        date.month === session.expectedMonth &&
        date.year === session.expectedYear
      ) {
        report(session, "match", date.text, cardName, "Exact name and birth month/year match.");
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

    var match = String(session.targetDob || "").match(/^([A-Za-z]+)\s+(19\d{2}|20\d{2})$/);
    if (!match) {
      report(session, "error", "", "", "The expected birth month and year are invalid.");
      return;
    }
    var expectedDate = parseMonthYear("born " + match[1] + " " + match[2]);
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
      }, 350);
    }
  }

  function requestLookupSession() {
    if (sessionStarted) return;
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
