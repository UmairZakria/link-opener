(function () {
  "use strict";

  var THATSTHEM_BASE = "https://thatsthem.com/address/";
  var UNMASK_BASE = "https://unmask.com/address/";
  var ADVANCED_BASE = "https://www.advancedbackgroundchecks.com/find/address/";

  var THATSTHEM_NAME_BASE = "https://thatsthem.com/name/";
  var ADVANCED_NAME_BASE = "https://www.advancedbackgroundchecks.com/find/name/";

  var AMICA_BASE = "https://www.amica.com/";
  var MERCURY_BASE = "https://www.mercuryinsurance.com/";

  var DEFAULT_SETTINGS = {
    openAddressUnmask: true,
    openAddressThatsThem: true,
    openAddressAdvanced: true,
    openNameThatsThem: true,
    openNameAdvanced: true,
  };

  var currentSettings = Object.assign({}, DEFAULT_SETTINGS);
  var activeDobLookups = {};

  function ensurePoppinsFont() {
    if (document.getElementById("link-opener-poppins-font")) return;
    try {
      var preconnect1 = document.createElement("link");
      preconnect1.rel = "preconnect";
      preconnect1.href = "https://fonts.googleapis.com";

      var preconnect2 = document.createElement("link");
      preconnect2.rel = "preconnect";
      preconnect2.href = "https://fonts.gstatic.com";
      preconnect2.crossOrigin = "anonymous";

      var fontLink = document.createElement("link");
      fontLink.id = "link-opener-poppins-font";
      fontLink.rel = "stylesheet";
      fontLink.href =
        "https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&display=swap";

      document.head.appendChild(preconnect1);
      document.head.appendChild(preconnect2);
      document.head.appendChild(fontLink);
    } catch (e) {}
  }

  function applySettings(settings) {
    if (!settings) return;
    for (var key in DEFAULT_SETTINGS) {
      if (settings[key] !== undefined) {
        currentSettings[key] = !!settings[key];
      }
    }
  }

  // Initial load
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(null, function (items) {
      applySettings(items);
    });
  }

  // Listen for direct broadcast messages from popup
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (message && message.type === "SETTINGS_UPDATED" && message.settings) {
        applySettings(message.settings);
        if (sendResponse) sendResponse({ ok: true });
      } else if (message && message.action === "DOB_LOOKUP_EXACT_RESULT") {
        var activeLookup = activeDobLookups[message.lookupId];
        if (!activeLookup) return;
        activeLookup.unmaskDone = true;
        activeLookup.unmaskStatus = message.status;
        activeLookup.unmaskDob = message.dob || "";
        activeLookup.unmaskMessage = message.message || "";
        updateDobLookupResult(activeLookup);
        if (sendResponse) sendResponse({ ok: true });
      } else if (message && message.action === "DOB_LOOKUP_PEOPLE_RESULT") {
        var peopleLookup = activeDobLookups[message.lookupId];
        if (!peopleLookup) return;
        peopleLookup.peopleDone = true;
        peopleLookup.peopleStatus = message.status;
        peopleLookup.peopleDob = message.dob || "";
        peopleLookup.peopleName = message.name || "";
        peopleLookup.peopleMessage = message.message || "";
        updateDobLookupResult(peopleLookup);
        if (sendResponse) sendResponse({ ok: true });
      } else if (message && message.action === "DOB_LOOKUP_CANCELLED") {
        var cancelledLookup = activeDobLookups[message.lookupId];
        if (!cancelledLookup) return;
        if (message.source === "people") {
          cancelledLookup.peopleDone = true;
          cancelledLookup.peopleStatus = "cancelled";
          cancelledLookup.peopleMessage = "Stopped after the exact DOB was confirmed by Unmask.";
        } else if (message.source === "unmask") {
          cancelledLookup.unmaskDone = true;
          cancelledLookup.unmaskStatus = "cancelled";
          cancelledLookup.unmaskMessage = "Stopped after the exact DOB was confirmed by the parallel people search.";
        } else {
          return;
        }
        updateDobLookupResult(cancelledLookup);
        if (sendResponse) sendResponse({ ok: true });
      } else if (message && message.action === "DOB_LOOKUP_PEOPLE_PROGRESS") {
        var peopleProgressLookup = activeDobLookups[message.lookupId];
        if (!peopleProgressLookup || peopleProgressLookup.matchFound) return;
        setDobLookupStatus(
          peopleProgressLookup,
          "People · Scanning",
          "searching",
          message.message || "Scanning people-search result cards."
        );
        if (sendResponse) sendResponse({ ok: true });
      } else if (message && message.action === "DOB_LOOKUP_EXACT_PROGRESS") {
        var progressLookup = activeDobLookups[message.lookupId];
        if (!progressLookup || progressLookup.matchFound) return;
        var stageLabel = message.searchType === "address"
          ? "Address"
          : message.searchType === "phone"
            ? "Phone"
            : "Name";
        var completedSearches = Math.max(0, Number(message.searchIndex) || 0) + 1;
        var totalSearches = Math.max(completedSearches, Number(message.totalSearches) || completedSearches);
        var stageIndex = Math.max(1, Number(message.stageIndex) || 1);
        var stageTotal = Math.max(stageIndex, Number(message.stageTotal) || stageIndex);
        progressLookup.progress.value = completedSearches / totalSearches;
        progressLookup.progress.fill.style.width = Math.max(
          8,
          Math.round(progressLookup.progress.value * 100)
        ) + "%";
        setDobLookupStatus(
          progressLookup,
          stageLabel + " · " + stageIndex + "/" + stageTotal,
          "searching",
          "Searching " + stageLabel.toLowerCase() + " " + stageIndex + " of " + stageTotal
        );
        if (sendResponse) sendResponse({ ok: true });
      }
    });
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

  function updateDobLookupResult(lookup) {
    var matches = [];
    if (lookup.unmaskStatus === "match") {
      matches.push({ source: "Unmask", dob: lookup.unmaskDob, name: "" });
    }
    if (lookup.peopleStatus === "match") {
      matches.push({ source: "People search", dob: lookup.peopleDob, name: lookup.peopleName });
    }
    if (matches.length) {
      lookup.matchFound = true;
      copyToClipboard(matches[0].dob);
      setDobLookupStatus(
        lookup,
        "Exact match · " + matches[0].dob,
        "match",
        matches.map(function (match) {
          return match.source + ": " +
            (match.name ? match.name + " · " : "") + match.dob;
        }).join(" | ")
      );
      lookup.button.disabled = false;
      lookup.button.textContent = "Search";
      delete activeDobLookups[lookup.lookupId];
      return;
    }

    if (lookup.unmaskDone && lookup.peopleDone) {
      delete activeDobLookups[lookup.lookupId];
      lookup.button.disabled = false;
      lookup.button.textContent = "Search";
      var failed = lookup.unmaskStatus === "error" || lookup.peopleStatus === "error";
      var details = [
        lookup.unmaskMessage,
        lookup.peopleMessage
      ].filter(Boolean).join(" | ");
      setDobLookupStatus(
        lookup,
        failed ? "Search incomplete" : "No exact match",
        failed ? "error" : "no_match",
        details || (failed ? "One or more searches could not complete." : "Neither source found the exact birth month and year.")
      );
      return;
    }

    if (lookup.unmaskDone && !lookup.peopleDone) {
      setDobLookupStatus(lookup, "People · Searching", "searching", "Unmask is complete; the parallel people search is still running.");
    }
  }

  function setDobLookupStatus(lookup, label, state, title) {
    lookup.status.dataset.state = state;
    lookup.label.textContent = label;
    lookup.status.title = title || label;
    lookup.indicator.hidden = state !== "searching";
    lookup.progress.track.hidden = state !== "searching";
    if (state === "match") {
      lookup.status.style.color = "#166534";
      lookup.status.style.background = "#f0fdf4";
      lookup.status.style.borderColor = "#bbf7d0";
    } else if (state === "error" || state === "no_match") {
      lookup.status.style.color = state === "error" ? "#b91c1c" : "#92400e";
      lookup.status.style.background = state === "error" ? "#fef2f2" : "#fffbeb";
      lookup.status.style.borderColor = state === "error" ? "#fecaca" : "#fde68a";
    } else {
      lookup.status.style.color = "#1d4ed8";
      lookup.status.style.background = "#eff6ff";
      lookup.status.style.borderColor = "#bfdbfe";
    }
  }

  // Listen for storage changes
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes) {
      for (var key in changes) {
        if (changes[key] && changes[key].newValue !== undefined) {
          currentSettings[key] = !!changes[key].newValue;
        }
      }
    });
  }

  var STREET_SUFFIXES = {
    alley: "Aly",
    annex: "Anx",
    avenue: "Ave",
    boulevard: "Blvd",
    circle: "Cir",
    court: "Ct",
    drive: "Dr",
    expressway: "Expy",
    freeway: "Fwy",
    highway: "Hwy",
    lane: "Ln",
    parkway: "Pkwy",
    place: "Pl",
    road: "Rd",
    street: "St",
    terrace: "Ter",
    trail: "Trl",
    turnpike: "Tpke",
    way: "Way",
  };

  var NAME_SUFFIXES = new Set([
    "jr",
    "jr.",
    "sr",
    "sr.",
    "ii",
    "iii",
    "iv",
    "v",
    "md",
    "dds",
    "esq",
    "phd",
    "dvm",
  ]);

  var MONTH_NAMES = {
    jan: "01",
    january: "01",
    feb: "02",
    february: "02",
    mar: "03",
    march: "03",
    apr: "04",
    april: "04",
    may: "05",
    june: "06",
    jun: "06",
    july: "07",
    jul: "07",
    aug: "08",
    august: "08",
    sep: "09",
    september: "09",
    oct: "10",
    october: "10",
    nov: "11",
    november: "11",
    dec: "12",
    december: "12",
  };

  var SELECTOR_ADDRESS = 'a.address, a[href*="/address/"], a[class*="address"]';
  var SELECTOR_NAME = 'a.name-link, a[class*="name-link"], a.relative, a.associate';
  var SELECTOR_VIEW_DETAILS = [
    'a.btn[href*="/detail/"]',
    'a.btn-primary[href*="/detail/"]',
    'a[class*="btn"][href*="/detail/"]',
    'a[href*="pro.advancedbackgroundchecks.com/report/"]',
    'a[href*="/report/"]',
    'a.widget-link',
    'a[href*="tracking.truthfinder.com"]',
    'a[href*="tracking.instantcheckmate.com"]',
    'a[href*="peoplefinders.com"]',
    'a[class*="bg-red-600"]',
  ].join(", ");

  function titleCase(word) {
    if (!word) return word;
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }

  function titleCaseAll(str) {
    return str.split(/\s+/).map(titleCase).join(" ");
  }

  function slugify(str) {
    return str
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-");
  }

  function abbreviateAndTitle(words) {
    return words
      .split(/\s+/)
      .map(function (w) {
        var lower = w.toLowerCase().replace(/\.$/, "");
        return STREET_SUFFIXES[lower] || titleCase(w);
      })
      .join(" ");
  }

  function buildStreetSlug(street) {
    street = street.replace(/\s+/g, " ").trim();
    var m = street.match(/^(\d+)\s+(.+?)\s+(\d+)\s*$/);
    if (m) {
      return m[1] + "-" + m[3] + "-" + slugify(abbreviateAndTitle(m[2]));
    }
    return slugify(abbreviateAndTitle(street));
  }

  function parseAddress(text) {
    if (!text) return null;
    var s = text
      .replace(/\[.*?\]|\(.*?\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    s = s.replace(/.*?associated with\s+/i, "").trim();

    var stateZipMatch = s.match(/,\s*([A-Za-z]{2})\s+(\d{5})(?:[-\s]*\d{4})?\s*$/);
    if (stateZipMatch) {
      var state = stateZipMatch[1].toUpperCase();
      var zip = stateZipMatch[2];
      var beforeState = s.slice(0, stateZipMatch.index).trim();

      var parts = beforeState.split(",").map(function (p) { return p.trim(); }).filter(Boolean);
      if (parts.length >= 2) {
        var city = parts[parts.length - 1];
        var streetParts = parts.slice(0, parts.length - 1);
        var streetLine1 = streetParts[0];
        var unit = streetParts.length > 1 ? streetParts.slice(1).join(" ") : "";

        return {
          street: streetLine1,
          streetFull: streetParts.join(" "),
          unit: unit,
          city: city,
          state: state,
          zip: zip,
        };
      } else if (parts.length === 1) {
        return {
          street: "",
          streetFull: "",
          unit: "",
          city: parts[0],
          state: state,
          zip: zip,
        };
      }
    }

    var m = s.match(
      /(?:^|.*?)([0-9A-Za-z\s.#-]+?),\s*([A-Za-z\s.-]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:[-\s]*\d{4})?/
    );
    if (m) {
      return {
        street: m[1].trim(),
        streetFull: m[1].trim(),
        unit: "",
        city: m[2].trim(),
        state: m[3].toUpperCase(),
        zip: m[4].trim(),
      };
    }

    var mCity = s.match(
      /(?:^|.*?\bin\s+)?([A-Za-z\s.-]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:[-\s]*\d{4})?/i
    );
    if (mCity) {
      return {
        street: "",
        streetFull: "",
        unit: "",
        city: mCity[1].trim(),
        state: mCity[2].toUpperCase(),
        zip: mCity[3].trim(),
      };
    }

    return null;
  }

  function parseName(rawName) {
    if (!rawName) return null;
    var cleaned = rawName.replace(/[^\w\s.-]/g, " ").replace(/\s+/g, " ").trim();
    var parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;

    var suffix = "";
    while (
      parts.length > 1 &&
      NAME_SUFFIXES.has(parts[parts.length - 1].toLowerCase().replace(/\.$/, ""))
    ) {
      suffix = parts.pop();
    }

    if (parts.length === 0) return null;

    var first = parts[0];
    var last = parts.length > 1 ? parts[parts.length - 1] : "";
    var middle = parts.length > 2 ? parts.slice(1, parts.length - 1).join(" ") : "";
    var fullWithoutSuffix = parts.map(titleCase).join("-");

    return {
      first: first,
      middle: middle,
      last: last,
      suffix: suffix,
      parts: parts,
      fullNameSlug: fullWithoutSuffix,
      firstLastSlug: last
        ? slugify(first).toLowerCase() + "-" + slugify(last).toLowerCase()
        : slugify(first).toLowerCase(),
    };
  }

  function extractNameFromContainer(card, btn) {
    if (card) {
      var nameGiven = card.querySelector(".name-given");
      if (nameGiven && nameGiven.textContent.trim()) {
        return nameGiven.textContent.trim();
      }

      var nameLink = card.querySelector("a.name-link");
      if (nameLink && nameLink.textContent.trim()) {
        return nameLink.textContent.trim();
      }

      var personH1 = card.querySelector("#personDetails h1");
      if (personH1 && personH1.textContent.trim()) {
        return personH1.textContent.trim();
      }

      var dts = card.querySelectorAll("dt");
      for (var i = 0; i < dts.length; i++) {
        if (dts[i].textContent.trim().toLowerCase().includes("full name")) {
          var dd = dts[i].nextElementSibling || dts[i].parentElement.querySelector("dd");
          if (dd && dd.textContent.trim()) return dd.textContent.trim();
        }
      }

      var cardH2 = card.querySelector(".card-header h2, h2");
      if (cardH2) {
        var clone = cardH2.cloneNode(true);
        clone.querySelectorAll(".age-label, .age, i, svg").forEach(function (el) { el.remove(); });
        var h2Text = clone.textContent.trim();
        if (h2Text) return h2Text;
      }
    }

    if (btn) {
      var title = btn.getAttribute("title") || "";
      var nameMatch = title.match(/more for\s+(.+?)\s+in\s+[A-Za-z\s.-]+,\s*[A-Za-z]{2}/i) ||
        title.match(/for\s+(.+?)\s+in\s+[A-Za-z\s.-]+,\s*[A-Za-z]{2}/i);
      if (nameMatch) return nameMatch[1].trim();

      var origHref = btn.getAttribute("data-original-href") || btn.getAttribute("href") || "";
      var detailMatch = origHref.match(/\/detail\/([^\/]+)\//i);
      if (detailMatch) {
        return titleCaseAll(detailMatch[1].replace(/-/g, " "));
      }
    }

    var globalPersonH1 = document.querySelector("#personDetails h1");
    if (globalPersonH1 && globalPersonH1.textContent.trim()) {
      return globalPersonH1.textContent.trim();
    }

    return "";
  }

  function findAddressFromContainer(el) {
    var currentAddressHeader = document.getElementById("toc-current-address");
    if (currentAddressHeader) {
      var sec = currentAddressHeader.closest("section");
      if (sec) {
        var addrLink = sec.querySelector('a[href*="/address/"], a[data-original-href*="/address/"], a');
        if (addrLink) {
          var text = (addrLink.textContent || "").trim();
          var parsed = parseAddress(text);
          if (parsed && parsed.zip && parsed.street) {
            return parsed;
          }

          var origHref = addrLink.getAttribute("data-original-href") || addrLink.getAttribute("href") || "";
          var findMatch = origHref.match(/\/address\/([^\/]+)\/([A-Za-z_-]+)-([A-Za-z]{2})-(\d{5})/i);
          if (findMatch) {
            return {
              street: titleCaseAll(findMatch[1].replace(/-/g, " ")),
              streetFull: titleCaseAll(findMatch[1].replace(/-/g, " ")),
              unit: "",
              city: titleCaseAll(findMatch[2].replace(/[_-]/g, " ")),
              state: findMatch[3].toUpperCase(),
              zip: findMatch[4],
            };
          }
        }
      }
    }

    var curr = el.parentElement;
    while (curr && curr !== document.body) {
      if (
        curr.matches &&
        (curr.matches('.card, [class*="card"], [class*="result"], [class*="record"], [class*="person"], .max-w-3xl, [class*="max-w-"]') ||
          curr.querySelector(".address-current, a.address, a[href*='/address/'], #toc-current-address"))
      ) {
        var addrLinks = curr.querySelectorAll(
          ".address-current a.address, .address-current, a.address, .address-previous a.address, a[href*='/address/'], a[href*='/find/address/']"
        );
        for (var i = 0; i < addrLinks.length; i++) {
          var addrEl = addrLinks[i];

          var text = (addrEl.textContent || "").trim();
          var parsed = parseAddress(text);
          if (parsed && parsed.zip && parsed.street) return parsed;

          var title = (addrEl.getAttribute("title") || "").trim();
          parsed = parseAddress(title);
          if (parsed && parsed.zip && parsed.street) return parsed;

          var href = addrEl.getAttribute("data-original-href") || addrEl.getAttribute("href") || "";

          var findMatch = href.match(/\/address\/([^\/]+)\/([A-Za-z_-]+)-([A-Za-z]{2})-(\d{5})/i);
          if (findMatch) {
            return {
              street: titleCaseAll(findMatch[1].replace(/-/g, " ")),
              streetFull: titleCaseAll(findMatch[1].replace(/-/g, " ")),
              unit: "",
              city: titleCaseAll(findMatch[2].replace(/[_-]/g, " ")),
              state: findMatch[3].toUpperCase(),
              zip: findMatch[4],
            };
          }

          var origMatch = href.match(/\/address\/([^\/]+)\/([^\/]+)\/([a-zA-Z]{2})/i);
          if (origMatch) {
            var rawZip = (text.match(/\b\d{5}\b/) || title.match(/\b\d{5}\b/) || [])[0] || "76133";
            return {
              street: titleCaseAll(origMatch[1].replace(/-/g, " ")),
              streetFull: titleCaseAll(origMatch[1].replace(/-/g, " ")),
              unit: "",
              city: titleCaseAll(origMatch[2].replace(/-/g, " ")),
              state: origMatch[3].toUpperCase(),
              zip: rawZip,
            };
          }

          var unmaskMatch = href.match(/address\/([A-Za-z0-9_-]+)--([A-Za-z0-9_]+)-([A-Za-z]{2})-(\d{5})/);
          if (unmaskMatch) {
            return {
              street: titleCaseAll(unmaskMatch[1].replace(/-/g, " ")),
              streetFull: titleCaseAll(unmaskMatch[1].replace(/-/g, " ")),
              unit: "",
              city: titleCaseAll(unmaskMatch[2].replace(/_/g, " ")),
              state: unmaskMatch[3].toUpperCase(),
              zip: unmaskMatch[4],
            };
          }

          if (parsed && parsed.zip) return parsed;
        }

        var viewDetails = curr.querySelector('a[title*=" in "], a.btn[href*="/detail/"]');
        if (viewDetails) {
          var parsedTitle = parseAddress(viewDetails.getAttribute("title") || "");
          if (parsedTitle && parsedTitle.zip) return parsedTitle;
        }

        var parsedContainer = parseAddress(curr.textContent || "");
        if (parsedContainer && parsedContainer.zip) return parsedContainer;
      }
      curr = curr.parentElement;
    }

    return null;
  }

  function findPhoneFromContainer(card) {
    if (!card) return null;

    var phoneEl = card.querySelector('a[href*="/find/phone/"], a[href*="/phone/"], a.phone, .phone');
    if (phoneEl) {
      var text = (phoneEl.textContent || "").trim();
      var digits = text.replace(/\D/g, "");
      if (digits.length === 10) {
        return digits.slice(0, 3) + "-" + digits.slice(3, 6) + "-" + digits.slice(6);
      }
    }

    var match = card.textContent.match(/\(?(\d{3})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
    if (match) {
      return match[1] + "-" + match[2] + "-" + match[3];
    }

    return null;
  }

  function findAgeAndDobFromContainer(card) {
    var result = { age: null, dob: null };
    if (!card) return result;

    var fullText = card.textContent || "";

    var bornMatch = fullText.match(/Born\s+([A-Za-z]+)\s+(\d{4})/i) ||
      fullText.match(/Birth Date[\s\S]*?<dd[^>]*>([A-Za-z]+)\s+(\d{4})/i) ||
      fullText.match(/Birth Date\s+([A-Za-z]+)\s+(\d{4})/i);

    if (bornMatch) {
      var monthStr = bornMatch[1].toLowerCase();
      var monthNum = MONTH_NAMES[monthStr] || "08";
      var yearNum = bornMatch[2];
      result.dob = monthNum + "/15/" + yearNum;

      var currentYear = new Date().getFullYear();
      result.age = currentYear - parseInt(yearNum, 10);
    }

    var ageEl = card.querySelector(".age, [class*='age']");
    if (ageEl) {
      var num = parseInt(ageEl.textContent.trim(), 10);
      if (!isNaN(num) && num > 18 && num < 110) result.age = num;
    }

    if (!result.age) {
      var ageMatch = fullText.match(/\bAge\s*[:\s]*(\d{2,3})\b/i) || fullText.match(/(\d{2,3})\s+years old/i);
      if (ageMatch) {
        result.age = parseInt(ageMatch[1], 10);
      }
    }

    return result;
  }

  function generateRealisticProfile(nameObj, addrObj, ageAndDob, phoneStr) {
    var age = ageAndDob.age || Math.floor(Math.random() * 35) + 40;
    var dob = ageAndDob.dob;

    if (!dob) {
      var currentYear = new Date().getFullYear();
      var birthYear = currentYear - age;
      var month = Math.floor(Math.random() * 12) + 1;
      var day = Math.floor(Math.random() * 28) + 1;
      var mm = month < 10 ? "0" + month : "" + month;
      var dd = day < 10 ? "0" + day : "" + day;
      dob = mm + "/" + dd + "/" + birthYear;
    }

    var firstClean = (nameObj.first || "Lloyd").toLowerCase().replace(/[^a-z]/g, "");
    var lastClean = (nameObj.last || "White").toLowerCase().replace(/[^a-z]/g, "");
    var domains = ["gmail.com", "yahoo.com", "outlook.com", "icloud.com", "hotmail.com"];
    var domain = domains[Math.floor(Math.random() * domains.length)];
    var numSuffix = Math.floor(Math.random() * 89) + 10;
    var email = firstClean + "." + lastClean + numSuffix + "@" + domain;

    var phone = phoneStr;
    if (!phone) {
      var area = Math.floor(Math.random() * 700) + 200;
      var mid = Math.floor(Math.random() * 800) + 100;
      var last4 = Math.floor(Math.random() * 8999) + 1000;
      phone = area + "-" + mid + "-" + last4;
    }

    var street = (addrObj && addrObj.street) ? addrObj.street : "3101 Highlawn Ter";
    var unit = (addrObj && addrObj.unit) ? addrObj.unit : "";

    return {
      fullName: nameObj.fullNameSlug ? nameObj.fullNameSlug.replace(/-/g, " ") : nameObj.first + " " + nameObj.last,
      name: {
        first: nameObj.first || "Lloyd",
        middle: nameObj.middle || (nameObj.parts && nameObj.parts.length > 2 ? nameObj.parts[1] : ""),
        last: nameObj.last || "White",
        suffix: nameObj.suffix || "",
      },
      address: {
        street: street,
        unit: unit,
        city: (addrObj && addrObj.city) ? addrObj.city : "Fort Worth",
        state: (addrObj && addrObj.state) ? addrObj.state : "TX",
        zip: (addrObj && addrObj.zip) ? addrObj.zip : "76133",
      },
      age: age,
      dob: dob,
      email: email,
      phone: phone,
      gender: "M",
      timestamp: Date.now(),
    };
  }

  function getUnmaskUrl(parsed) {
    var streetSlug = slugify(abbreviateAndTitle(parsed.street));
    var citySlug = titleCaseAll(parsed.city).replace(/\s+/g, "_");
    return (
      UNMASK_BASE +
      streetSlug +
      "--" +
      citySlug +
      "-" +
      parsed.state +
      "-" +
      parsed.zip +
      "/"
    );
  }

  function getThatsThemUrl(parsed) {
    var streetSlug = buildStreetSlug(parsed.street);
    var citySlug = slugify(titleCaseAll(parsed.city));
    return (
      THATSTHEM_BASE +
      streetSlug +
      "-" +
      citySlug +
      "-" +
      parsed.state +
      "-" +
      parsed.zip
    );
  }

  function getAdvancedBackgroundChecksUrl(parsed) {
    var streetSlug = slugify(abbreviateAndTitle(parsed.street)).toLowerCase();
    var citySlug = slugify(parsed.city).toLowerCase();
    return (
      ADVANCED_BASE +
      streetSlug +
      "/" +
      citySlug +
      "-" +
      parsed.state +
      "-" +
      parsed.zip
    );
  }

  function getThatsThemNameUrl(parsedName, parsedAddr) {
    var base = THATSTHEM_NAME_BASE + parsedName.fullNameSlug;
    if (parsedAddr && parsedAddr.city && parsedAddr.state && parsedAddr.zip) {
      var cityPart = slugify(titleCaseAll(parsedAddr.city));
      return base + "/" + cityPart + "-" + parsedAddr.state + "-" + parsedAddr.zip;
    } else if (parsedAddr && parsedAddr.city && parsedAddr.state) {
      var cityPart = slugify(titleCaseAll(parsedAddr.city));
      return base + "/" + cityPart + "-" + parsedAddr.state;
    }
    return base;
  }

  function getAdvancedNameUrl(parsedName, parsedAddr) {
    var base = ADVANCED_NAME_BASE + parsedName.firstLastSlug;
    if (parsedAddr && parsedAddr.state && parsedAddr.city) {
      var citySlug = slugify(parsedAddr.city).toLowerCase();
      return base + "/in/" + parsedAddr.state + "/" + citySlug;
    } else if (parsedAddr && parsedAddr.state) {
      return base + "/in/" + parsedAddr.state;
    }
    return base;
  }

  function openAll(urls) {
    if (!urls || urls.length === 0) return;
    if (
      typeof chrome !== "undefined" &&
      chrome.runtime &&
      chrome.runtime.sendMessage
    ) {
      try {
        chrome.runtime.sendMessage({
          type: "OPEN_URLS",
          urls: urls,
        });
        return;
      } catch (err) {
        // Fallback below
      }
    }
    urls.forEach(function (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  }

  function showChoiceModal(profile, originalHref) {
    ensurePoppinsFont();

    var existing = document.getElementById("vehicle-discovery-choice-modal");
    if (existing) existing.remove();

    var backdrop = document.createElement("div");
    backdrop.id = "vehicle-discovery-choice-modal";
    backdrop.style.cssText = [
      "position: fixed",
      "top: 0",
      "left: 0",
      "width: 100vw",
      "height: 100vh",
      "background: rgba(15, 23, 42, 0.72)",
      "backdrop-filter: blur(8px)",
      "z-index: 99999999",
      "display: flex",
      "align-items: center",
      "justify-content: center",
      "font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important",
      "font-weight: 300",
    ].join(";");

    var modal = document.createElement("div");
    modal.style.cssText = [
      "background: #0f172a",
      "color: #f1f5f9",
      "border-radius: 20px",
      "padding: 24px 28px",
      "width: 360px",
      "box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.1)",
      "font-family: 'Poppins', sans-serif !important",
    ].join(";");

    var fullName = profile.fullName || (profile.name ? profile.name.first + " " + profile.name.last : "Customer");
    var loc = profile.address ? profile.address.city + ", " + profile.address.state : "";

    modal.innerHTML = [
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">',
      '  <div>',
      '    <h3 style="margin:0; font-size:15px; font-weight:600; color:#f8fafc; font-family:Poppins, sans-serif;">Select Provider</h3>',
      '    <p style="margin:2px 0 0 0; font-size:11.5px; color:#94a3b8; font-weight:300; font-family:Poppins, sans-serif;">' + fullName + (loc ? " • " + loc : "") + '</p>',
      '  </div>',
      '  <button id="choice-modal-close" style="background:none; border:none; color:#94a3b8; font-size:14px; font-family:Poppins, sans-serif; cursor:pointer; padding:4px 6px;">Close</button>',
      '</div>',
      '<div style="display:flex; flex-direction:column; gap:10px;">',
      '  <button id="choice-btn-amica" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#f8fafc; border-radius:12px; padding:12px 16px; cursor:pointer; text-align:left; transition:all 0.15s ease; font-family:Poppins, sans-serif;">',
      '    <div style="font-size:14px; font-weight:500; color:#38bdf8;">Amica</div>',
      '    <div style="font-size:11.5px; color:#94a3b8; font-weight:300;">Automatic vehicle discovery</div>',
      '  </button>',
      '  <button id="choice-btn-mercury" style="background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12); color:#f8fafc; border-radius:12px; padding:12px 16px; cursor:pointer; text-align:left; transition:all 0.15s ease; font-family:Poppins, sans-serif;">',
      '    <div style="font-size:14px; font-weight:500; color:#fb923c;">Mercury</div>',
      '    <div style="font-size:11.5px; color:#94a3b8; font-weight:300;">Fast quote with Amica fallback</div>',
      '  </button>',
      '</div>',
    ].join("");

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    var amicaBtn = document.getElementById("choice-btn-amica");
    var mercuryBtn = document.getElementById("choice-btn-mercury");
    var closeBtn = document.getElementById("choice-modal-close");

    [amicaBtn, mercuryBtn].forEach(function (btn) {
      btn.addEventListener("mouseenter", function () {
        btn.style.background = "rgba(255,255,255,0.12)";
        btn.style.borderColor = "rgba(255,255,255,0.25)";
        btn.style.transform = "translateY(-1px)";
      });
      btn.addEventListener("mouseleave", function () {
        btn.style.background = "rgba(255,255,255,0.06)";
        btn.style.borderColor = "rgba(255,255,255,0.12)";
        btn.style.transform = "translateY(0)";
      });
    });

    closeBtn.addEventListener("click", function () {
      backdrop.remove();
    });

    backdrop.addEventListener("click", function (e) {
      if (e.target === backdrop) backdrop.remove();
    });

    amicaBtn.addEventListener("click", function () {
      backdrop.remove();
      profile.timestamp = Date.now();
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set({ amica_pending_quote: profile }, function () {
          openAll([AMICA_BASE]);
        });
      } else {
        openAll([AMICA_BASE]);
      }
    });

    mercuryBtn.addEventListener("click", function () {
      backdrop.remove();
      profile.timestamp = Date.now();
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.set(
          { mercury_pending_quote: profile },
          function () {
            openAll([MERCURY_BASE]);
          }
        );
      } else {
        openAll([MERCURY_BASE]);
      }
    });
  }

  function processAddressLink(a) {
    if (a.dataset && a.dataset.adsConverted) return;

    var originalHref = a.getAttribute("href") || a.href || "";
    if (a.dataset) a.dataset.originalHref = originalHref;

    var text =
      (a.textContent || "").trim() || (a.getAttribute("title") || "").trim();
    if (!text) return;

    var parsed = parseAddress(text);
    if (!parsed) return;

    var unmaskUrl = getUnmaskUrl(parsed);
    var thatsThemUrl = getThatsThemUrl(parsed);
    var advancedUrl = getAdvancedBackgroundChecksUrl(parsed);

    a.href = unmaskUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    function handleClick(e) {
      if (e.ctrlKey || e.metaKey) {
        if (originalHref) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          var fullOriginalUrl = new URL(originalHref, location.href).href;
          openAll([fullOriginalUrl]);
        }
        return;
      }

      if (e.button === 0 || e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        var toOpen = [];
        if (currentSettings.openAddressUnmask) toOpen.push(unmaskUrl);
        if (currentSettings.openAddressThatsThem) toOpen.push(thatsThemUrl);
        if (currentSettings.openAddressAdvanced) toOpen.push(advancedUrl);

        if (toOpen.length > 0) {
          openAll(toOpen);
        }
      }
    }

    a.addEventListener("click", handleClick, true);
    a.addEventListener("auxclick", handleClick, true);

    if (a.dataset) a.dataset.adsConverted = "1";
  }

  function processNameLink(a) {
    if (a.dataset && a.dataset.adsConverted) return;

    var originalHref = a.getAttribute("href") || a.href || "";
    if (a.dataset) a.dataset.originalHref = originalHref;

    var nameSpan = a.querySelector(".name-given, [class*='name']");
    var text = (nameSpan ? nameSpan.textContent : a.textContent) || "";
    text = text.trim();
    if (!text) return;

    var parsedName = parseName(text);
    if (!parsedName) return;

    var parsedAddr = findAddressFromContainer(a);

    var thatsThemUrl = getThatsThemNameUrl(parsedName, parsedAddr);
    var advancedUrl = getAdvancedNameUrl(parsedName, parsedAddr);

    a.href = thatsThemUrl;
    a.target = "_blank";
    a.rel = "noopener noreferrer";

    function handleClick(e) {
      if (e.ctrlKey || e.metaKey) {
        if (originalHref) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          var fullOriginalUrl = new URL(originalHref, location.href).href;
          openAll([fullOriginalUrl]);
        }
        return;
      }

      if (e.button === 0 || e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        var toOpen = [];
        if (currentSettings.openNameThatsThem) toOpen.push(thatsThemUrl);
        if (currentSettings.openNameAdvanced) toOpen.push(advancedUrl);

        if (toOpen.length > 0) {
          openAll(toOpen);
        }
      }
    }

    a.addEventListener("click", handleClick, true);
    a.addEventListener("auxclick", handleClick, true);

    if (a.dataset) a.dataset.adsConverted = "1";
  }

  function processViewDetailsLink(btn) {
    if (btn.dataset && btn.dataset.amicaBound) return;

    var originalHref = btn.getAttribute("href") || btn.href || "";
    if (btn.dataset) btn.dataset.originalHref = originalHref;

    var card =
      btn.closest('.card, [class*="card"], .result, [class*="result"], .max-w-3xl, [class*="max-w-"]') ||
      document.body;

    var nameText = extractNameFromContainer(card, btn);
    var parsedName = parseName(nameText) || {
      first: "Lloyd",
      middle: "D",
      last: "White",
      parts: ["Lloyd", "D", "White"],
      fullNameSlug: "Lloyd-D-White",
    };

    var parsedAddr = findAddressFromContainer(btn);
    var phoneStr = findPhoneFromContainer(card);
    var ageAndDob = findAgeAndDobFromContainer(card);

    var profile = generateRealisticProfile(parsedName, parsedAddr, ageAndDob, phoneStr);

    function handleButtonClick(e) {
      if (e.ctrlKey || e.metaKey) {
        if (originalHref) {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          var fullOriginalUrl = new URL(originalHref, location.href).href;
          openAll([fullOriginalUrl]);
        }
        return;
      }

      if (e.button === 0 || e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        showChoiceModal(profile, originalHref);
      }
    }

    btn.addEventListener("click", handleButtonClick, true);
    btn.addEventListener("auxclick", handleButtonClick, true);

    if (btn.dataset) btn.dataset.amicaBound = "1";
  }

  function parseBirthMonthYear(value) {
    var match = String(value || "").trim().match(/^([A-Za-z]{3,9})\.?\s+(?:(?:\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})$/i);
    if (!match) return null;
    var month = MONTH_NAMES[match[1].toLowerCase()];
    if (!month) return null;
    var monthName = Object.keys(MONTH_NAMES).find(function (name) {
      return MONTH_NAMES[name] === month && name.length > 3;
    });
    return monthName
      ? { month: month, year: match[2], display: titleCase(monthName.slice(0, 3)) + " " + match[2] }
      : null;
  }

  function getAdvancedProfileValue(label) {
    var elements = document.querySelectorAll("dt");
    for (var i = 0; i < elements.length; i++) {
      if ((elements[i].textContent || "").trim().toLowerCase() !== label.toLowerCase()) continue;
      var value = elements[i].nextElementSibling;
      if (!value || value.tagName !== "DD") {
        value = elements[i].parentElement && elements[i].parentElement.querySelector("dd");
      }
      if (value) return value.textContent.replace(/\s+/g, " ").trim();
    }
    return "";
  }

  function getAdvancedProfileName() {
    var labeledName = getAdvancedProfileValue("Full Name");
    if (labeledName) return labeledName;
    var heading = document.querySelector("#personDetails h1");
    return heading ? heading.textContent.replace(/\s+/g, " ").trim() : "";
  }

  function getAdvancedProfileAliases() {
    var aliases = [];
    function addAlias(value) {
      var alias = String(value || "").replace(/\s+/g, " ").trim();
      if (!alias || aliases.some(function (existing) {
        return existing.toLowerCase() === alias.toLowerCase();
      })) {
        return;
      }
      aliases.push(alias);
    }

    var labels = document.querySelectorAll("dt");
    for (var i = 0; i < labels.length; i++) {
      var label = (labels[i].textContent || "").trim().toLowerCase();
      if (!/^(?:also\s+known\s+as|known\s+as|aka)$/.test(label)) continue;
      var value = labels[i].nextElementSibling;
      if (!value || value.tagName !== "DD") {
        value = labels[i].parentElement && labels[i].parentElement.querySelector("dd");
      }
      if (!value) continue;
      var aliasLinks = value.querySelectorAll("a");
      if (aliasLinks.length) {
        for (var linkIndex = 0; linkIndex < aliasLinks.length; linkIndex++) {
          addAlias(aliasLinks[linkIndex].textContent);
        }
      } else {
        (value.textContent || "").split(/[,;|]/).forEach(addAlias);
      }
    }

    var nameLinks = document.querySelectorAll('#personDetails a[href*="/find/name/"], a[href*="/find/name/"]');
    for (var nameIndex = 0; nameIndex < nameLinks.length; nameIndex++) {
      addAlias(nameLinks[nameIndex].textContent);
    }
    return aliases;
  }

  function findAdvancedProfileAddresses() {
    var addresses = [];
    var addressSections = ["toc-current-address", "toc-previous-addresses"];
    addressSections.forEach(function (id) {
      var heading = document.getElementById(id);
      var section = heading && heading.closest("section");
      if (!section) return;

      var links = section.querySelectorAll('a[href*="/address/"], a[data-original-href*="/find/address/"]');
      for (var i = 0; i < links.length; i++) {
        var parsed = parseAddress(links[i].textContent || "");
        if (!parsed || !parsed.street || !parsed.city || !parsed.state || !parsed.zip) continue;

        var url = "";
        try {
          var candidateUrl = new URL(links[i].href || links[i].getAttribute("href"), location.href);
          if (
            candidateUrl.protocol === "https:" &&
            candidateUrl.hostname === "unmask.com" &&
            candidateUrl.pathname.startsWith("/address/")
          ) {
            url = candidateUrl.href;
          }
        } catch (error) {}
        if (!url) url = getUnmaskUrl(parsed);

        if (!addresses.some(function (address) { return address.url === url; })) {
          parsed.url = url;
          addresses.push(parsed);
        }
      }
    });
    return addresses;
  }

  function findAdvancedProfilePhones(primaryPhone) {
    var phones = [];
    function addPhone(value) {
      var text = String(value || "");
      var match = text.match(/(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]+(\d{3})[\s.-]+(\d{4})/);
      var digits = text.replace(/\D/g, "");
      if (!match && digits.length >= 10) {
        digits = digits.slice(-10);
        match = [digits, digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)];
      }
      if (!match) return;
      var phone = match[1] + "-" + match[2] + "-" + match[3];
      if (phones.indexOf(phone) === -1) phones.push(phone);
    }

    addPhone(primaryPhone);
    var telephoneLinks = document.querySelectorAll(
      'a[href^="tel:"], a[href*="/find/phone/"], a[href*="/phone/"], [itemprop="telephone"]'
    );
    for (var i = 0; i < telephoneLinks.length; i++) {
      addPhone(telephoneLinks[i].getAttribute("href") || telephoneLinks[i].textContent);
    }

    var labels = document.querySelectorAll("dt");
    for (var labelIndex = 0; labelIndex < labels.length; labelIndex++) {
      if (!/phone/i.test(labels[labelIndex].textContent || "")) continue;
      var value = labels[labelIndex].nextElementSibling;
      if (!value || value.tagName !== "DD") {
        value = labels[labelIndex].parentElement && labels[labelIndex].parentElement.querySelector("dd");
      }
      if (value) addPhone(value.textContent);
    }
    return phones;
  }

  function scanAdvancedBirthDate(root) {
    if (
      location.hostname.replace(/^www\./, "") !== "advancedbackgroundchecks.com" ||
      !location.pathname.startsWith("/find/person/") ||
      !root.querySelectorAll
    ) {
      return;
    }

    var dateLabels = [];
    if (root.matches && root.matches("dt")) dateLabels.push(root);
    Array.prototype.push.apply(dateLabels, root.querySelectorAll("dt"));
    dateLabels.forEach(function (dt) {
      if ((dt.textContent || "").trim().toLowerCase() !== "birth date") return;
      var value = dt.nextElementSibling;
      if (!value || value.tagName !== "DD") {
        value = dt.parentElement && dt.parentElement.querySelector("dd");
      }
      if (!value || value.querySelector("[data-link-opener-dob-search]")) return;

      var dob = parseBirthMonthYear(value.textContent);
      var fullName = getAdvancedProfileName();
      var parsedName = parseName(fullName);
      if (!dob || !parsedName || !parsedName.first || !parsedName.last) return;

      if (!document.getElementById("link-opener-dob-status-animation")) {
        var animationStyle = document.createElement("style");
        animationStyle.id = "link-opener-dob-status-animation";
        animationStyle.textContent = "@keyframes link-opener-dob-spin{to{transform:rotate(360deg)}}";
        document.head.appendChild(animationStyle);
      }

      var button = document.createElement("button");
      button.type = "button";
      button.textContent = "Search";
      button.setAttribute("data-link-opener-dob-search", "true");
      button.style.cssText = "margin-right:8px;padding:2px 8px;border:1px solid #117fb6;border-radius:5px;background:#117fb6;color:#fff;font-size:12px;font-weight:600;line-height:1.5;cursor:pointer;vertical-align:middle;";

      var status = document.createElement("span");
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.dataset.state = "idle";
      status.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-left:7px;padding:3px 8px;border:1px solid #e2e8f0;border-radius:999px;background:#f8fafc;color:#64748b;font-family:inherit;font-size:11px;font-weight:600;line-height:1.25;vertical-align:middle;";
      var indicator = document.createElement("span");
      indicator.style.cssText = "width:8px;height:8px;flex:none;border:1.5px solid #bfdbfe;border-top-color:#2563eb;border-radius:50%;animation:link-opener-dob-spin .75s linear infinite;";
      indicator.hidden = true;
      var label = document.createElement("span");
      var progress = document.createElement("span");
      progress.track = document.createElement("span");
      progress.track.style.cssText = "width:26px;height:3px;overflow:hidden;border-radius:99px;background:#dbeafe;";
      progress.fill = document.createElement("span");
      progress.fill.style.cssText = "display:block;width:0;height:100%;border-radius:inherit;background:#3b82f6;transition:width .25s ease;";
      progress.track.appendChild(progress.fill);
      progress.track.hidden = true;
      progress.value = 0;
      status.appendChild(indicator);
      status.appendChild(label);
      status.appendChild(progress.track);
      value.insertBefore(button, value.firstChild);
      value.insertBefore(document.createTextNode(" "), button.nextSibling);
      value.appendChild(status);

      button.addEventListener("click", function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;

        var slug = slugify(parsedName.first + "-" + parsedName.last).toLowerCase();
        var lookupId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
        var targetAliases = getAdvancedProfileAliases();
        var phone = getAdvancedProfileValue("Primary Phone");
        var phones = findAdvancedProfilePhones(phone);
        var ageText = getAdvancedProfileValue("Age");
        if (!ageText) {
          var summaryText = document.querySelector("#personDetails");
          ageText = summaryText ? summaryText.textContent : "";
        }
        var ageMatch = ageText.match(/\b(\d{1,3})\b/);
        var addresses = findAdvancedProfileAddresses();
        var searches = addresses.map(function (address) {
          return { type: "address", url: address.url };
        });
        phones.forEach(function (number) {
          var digits = number.replace(/\D/g, "");
          searches.push({
            type: "phone",
            url: "https://unmask.com/phone/" +
              digits.slice(0, 3) + "-" + digits.slice(3, 6) + "-" + digits.slice(6) + "/"
          });
        });
        var nameSearchSlugs = [slug];
        targetAliases.forEach(function (alias) {
          var aliasName = parseName(alias);
          if (!aliasName || !aliasName.first || !aliasName.last) return;
          var aliasSlug = slugify(aliasName.first + "-" + aliasName.last).toLowerCase();
          if (nameSearchSlugs.indexOf(aliasSlug) === -1) nameSearchSlugs.push(aliasSlug);
        });
        nameSearchSlugs.forEach(function (nameSlug) {
          searches.push({ type: "name", url: "https://unmask.com/" + nameSlug + "/" });
        });

        var session = {
          lookupId: lookupId,
          targetName: fullName,
          targetAliases: targetAliases,
          peopleSearchUrl: "https://www.menstoppingviolence.org/people/" + slug + "/",
          targetAge: ageMatch ? parseInt(ageMatch[1], 10) : null,
          targetYear: dob.year,
          targetDob: dob.display,
          phone: phone,
          phones: phones,
          addresses: addresses,
          searches: searches,
          searchIndex: 0,
          currentSearchType: searches[0].type,
          person: {
            fullName: fullName,
            phone: phone,
            phones: phones
          },
          searchUrl: searches[0].url
        };

        button.disabled = true;
        var activeLookup = {
          button: button,
          status: status,
          label: label,
          indicator: indicator,
          progress: progress,
          lookupId: lookupId,
          unmaskDone: false,
          peopleDone: false,
          unmaskStatus: "",
          peopleStatus: ""
        };
        activeDobLookups[lookupId] = activeLookup;
        setDobLookupStatus(
          activeLookup,
          searches[0].type === "address" ? "Address · 1/" + searches.length : "Starting",
          "searching",
          "Searching " + addresses.length + " addresses, " + phones.length + " phone numbers, then name for " + dob.display
        );
        progress.value = 1 / searches.length;
        progress.fill.style.width = Math.max(8, Math.round(progress.value * 100)) + "%";

        chrome.runtime.sendMessage(
          { action: "START_EXACT_DOB_LOOKUP", session: session },
          function (response) {
            if (chrome.runtime.lastError || !response || !response.ok) {
              delete activeDobLookups[lookupId];
              button.disabled = false;
              button.textContent = "Search";
              setDobLookupStatus(
                activeLookup,
                "Start failed",
                "error",
                chrome.runtime.lastError
                  ? chrome.runtime.lastError.message
                  : (response && response.error) || "Extension did not respond."
              );
            }
          }
        );
      });
    });
  }

  function scan(root) {
    scanAdvancedBirthDate(root);
    if (root.nodeType === Node.ELEMENT_NODE && root.matches) {
      if (root.matches(SELECTOR_ADDRESS)) processAddressLink(root);
      if (
        root.matches(SELECTOR_VIEW_DETAILS) ||
        (root.tagName === "A" &&
          /get unlimited background details|view full background report|view details/i.test(
            root.textContent || ""
          ))
      ) {
        processViewDetailsLink(root);
      } else if (root.matches(SELECTOR_NAME)) {
        processNameLink(root);
      }
    }
    if (root.querySelectorAll) {
      root.querySelectorAll(SELECTOR_ADDRESS).forEach(processAddressLink);
      root.querySelectorAll(SELECTOR_VIEW_DETAILS).forEach(processViewDetailsLink);

      var allAnchors = root.querySelectorAll("a");
      allAnchors.forEach(function (a) {
        var txt = (a.textContent || "").trim().toLowerCase();
        if (
          txt.includes("get unlimited background details") ||
          txt.includes("view full background report") ||
          txt.includes("view details")
        ) {
          processViewDetailsLink(a);
        }
      });

      root.querySelectorAll(SELECTOR_NAME).forEach(processNameLink);
    }
  }

  scan(document);

  var observer = new MutationObserver(function (mutations) {
    mutations.forEach(function (mutation) {
      mutation.addedNodes.forEach(function (node) {
        if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      });
    });
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
