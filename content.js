(function () {
  "use strict";

  var THATSTHEM_BASE = "https://thatsthem.com/address/";
  var UNMASK_BASE = "https://unmask.com/address/";
  var ADVANCED_BASE = "https://www.advancedbackgroundchecks.com/find/address/";

  var THATSTHEM_NAME_BASE = "https://thatsthem.com/name/";
  var ADVANCED_NAME_BASE = "https://www.advancedbackgroundchecks.com/find/name/";

  var AMICA_BASE = "https://www.amica.com/";

  var DEFAULT_SETTINGS = {
    openAddressUnmask: true,
    openAddressThatsThem: true,
    openAddressAdvanced: true,
    openNameThatsThem: true,
    openNameAdvanced: true,
  };

  var currentSettings = Object.assign({}, DEFAULT_SETTINGS);

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
      }
    });
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

  // "900 County Road 310" -> "900-310-County-Rd"
  function buildStreetSlug(street) {
    street = street.replace(/\s+/g, " ").trim();
    var m = street.match(/^(\d+)\s+(.+?)\s+(\d+)\s*$/);
    if (m) {
      return m[1] + "-" + m[3] + "-" + slugify(abbreviateAndTitle(m[2]));
    }
    return slugify(abbreviateAndTitle(street));
  }

  // Robust parser that properly handles Apt/Unit/Suite:
  // "3101 Highlawn Ter, UNIT O, Fort Worth, TX 76133 7231"
  // "305 Elda Dr, Brownsville, TX 78521"
  function parseAddress(text) {
    if (!text) return null;
    var s = text
      .replace(/\[.*?\]|\(.*?\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    s = s.replace(/.*?associated with\s+/i, "").trim();

    // 1. Match State and 5-digit Zip at the end
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

    // 2. Fallback regex
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

    // 3. City, State Zip only
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
      // 1. Direct name-given inside card
      var nameGiven = card.querySelector(".name-given");
      if (nameGiven && nameGiven.textContent.trim()) {
        return nameGiven.textContent.trim();
      }

      // 2. Name link inside card
      var nameLink = card.querySelector("a.name-link");
      if (nameLink && nameLink.textContent.trim()) {
        return nameLink.textContent.trim();
      }

      // 3. Details page heading in #personDetails
      var personH1 = card.querySelector("#personDetails h1");
      if (personH1 && personH1.textContent.trim()) {
        return personH1.textContent.trim();
      }

      // 4. Key Facts definition list
      var dts = card.querySelectorAll("dt");
      for (var i = 0; i < dts.length; i++) {
        if (dts[i].textContent.trim().toLowerCase().includes("full name")) {
          var dd = dts[i].nextElementSibling || dts[i].parentElement.querySelector("dd");
          if (dd && dd.textContent.trim()) return dd.textContent.trim();
        }
      }

      // 5. Card header h2
      var cardH2 = card.querySelector(".card-header h2, h2");
      if (cardH2) {
        var clone = cardH2.cloneNode(true);
        clone.querySelectorAll(".age-label, .age, i, svg").forEach(function (el) { el.remove(); });
        var h2Text = clone.textContent.trim();
        if (h2Text) return h2Text;
      }
    }

    // 6. Button title match
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

    // 7. Global #personDetails h1
    var globalPersonH1 = document.querySelector("#personDetails h1");
    if (globalPersonH1 && globalPersonH1.textContent.trim()) {
      return globalPersonH1.textContent.trim();
    }

    return "";
  }

  function findAddressFromContainer(el) {
    // 1. Check for Modern Details Page "#toc-current-address" section
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

    // 2. Ascend parent containers
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

          // e.g. /find/address/3101-highlawn-ter/fort-worth-TX-76133
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

          // e.g. /address/3101-highlawn-ter/fort-worth/tx
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

          // e.g. unmask URL: https://unmask.com/address/3101-Highlawn-Ter--Fort_Worth-TX-76133/
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

    // 1. Check for explicit "Born Month Year" (e.g. Born August 1941)
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

    // 2. Check for Age element / text (e.g. Age 85, 85 years old)
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

    function handleAmicaClick(e) {
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

        profile.timestamp = Date.now();

        if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
          chrome.storage.local.set({ amica_pending_quote: profile }, function () {
            openAll([AMICA_BASE]);
          });
        } else {
          openAll([AMICA_BASE]);
        }
      }
    }

    btn.addEventListener("click", handleAmicaClick, true);
    btn.addEventListener("auxclick", handleAmicaClick, true);

    if (btn.dataset) btn.dataset.amicaBound = "1";
  }

  function scan(root) {
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
