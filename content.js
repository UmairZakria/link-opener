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

  var SELECTOR_ADDRESS = 'a.address, a[href*="/address/"], a[class*="address"]';
  var SELECTOR_NAME = 'a.name-link, a[class*="name-link"], a.relative, a.associate';
  var SELECTOR_VIEW_DETAILS =
    'a.btn[href*="/detail/"], a.btn-primary[href*="/detail/"], a[class*="btn"][href*="/detail/"]';

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

  function parseAddress(text) {
    if (!text) return null;
    var s = text
      .replace(/\[.*?\]|\(.*?\)/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    s = s.replace(/.*?associated with\s+/i, "").trim();

    // 1. Street, City, State Zip: "7603 E 8th Pl, Denver, CO 80230 7084"
    var m = s.match(
      /(?:^|.*?)([0-9A-Za-z\s.#-]+?),\s*([A-Za-z\s.-]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:[-\s]*\d{4})?/
    );
    if (m) {
      return {
        street: m[1].trim(),
        city: m[2].trim(),
        state: m[3].toUpperCase(),
        zip: m[4].trim(),
      };
    }

    // 2. City, State Zip: "Fort Worth, TX 76109"
    var mCity = s.match(
      /(?:^|.*?\bin\s+)?([A-Za-z\s.-]+?),\s*([A-Za-z]{2})\s+(\d{5})(?:[-\s]*\d{4})?/i
    );
    if (mCity) {
      return {
        street: "",
        city: mCity[1].trim(),
        state: mCity[2].toUpperCase(),
        zip: mCity[3].trim(),
      };
    }

    return null;
  }

  function parseName(rawName) {
    if (!rawName) return null;
    var cleaned = rawName.replace(/[^\w\s.-]/g, "").trim();
    var parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;

    var suffix = "";
    // Filter out trailing suffixes (JR, SR, III, etc.)
    while (
      parts.length > 1 &&
      NAME_SUFFIXES.has(parts[parts.length - 1].toLowerCase().replace(/\.$/, ""))
    ) {
      suffix = parts.pop();
    }

    if (parts.length === 0) return null;

    var first = parts[0];
    var last = parts.length > 1 ? parts[parts.length - 1] : "";
    var fullWithoutSuffix = parts.map(titleCase).join("-");

    return {
      first: first,
      last: last,
      suffix: suffix,
      parts: parts,
      fullNameSlug: fullWithoutSuffix,
      firstLastSlug: last
        ? slugify(first).toLowerCase() + "-" + slugify(last).toLowerCase()
        : slugify(first).toLowerCase(),
    };
  }

  function findAddressFromContainer(el) {
    var curr = el.parentElement;
    while (curr && curr !== document.body) {
      if (
        curr.matches &&
        (curr.matches('.card, [class*="card"], [class*="result"], [class*="record"], [class*="person"]') ||
          curr.querySelector(".address-current, a.address, a[href*='/address/']"))
      ) {
        // 1. Try address links and elements
        var addrLinks = curr.querySelectorAll(
          ".address-current a.address, .address-current, a.address, .address-previous a.address, a[href*='/address/']"
        );
        for (var i = 0; i < addrLinks.length; i++) {
          var addrEl = addrLinks[i];

          // Check text content first
          var text = (addrEl.textContent || "").trim();
          var parsed = parseAddress(text);
          if (parsed && parsed.zip && parsed.street) return parsed;

          // Check title attribute
          var title = (addrEl.getAttribute("title") || "").trim();
          parsed = parseAddress(title);
          if (parsed && parsed.zip && parsed.street) return parsed;

          // Check original href or current href
          var href = addrEl.getAttribute("data-original-href") || addrEl.getAttribute("href") || "";
          // e.g. /address/7603-e-8th-pl/denver/co
          var origMatch = href.match(/\/address\/([^\/]+)\/([^\/]+)\/([a-zA-Z]{2})/i);
          if (origMatch) {
            var rawZip = (text.match(/\b\d{5}\b/) || title.match(/\b\d{5}\b/) || [])[0] || "80230";
            return {
              street: titleCaseAll(origMatch[1].replace(/-/g, " ")),
              city: titleCaseAll(origMatch[2].replace(/-/g, " ")),
              state: origMatch[3].toUpperCase(),
              zip: rawZip,
            };
          }

          // e.g. unmask URL: https://unmask.com/address/7603-E-8th-Pl--Denver-CO-80230/
          var unmaskMatch = href.match(/address\/([A-Za-z0-9_-]+)--([A-Za-z0-9_]+)-([A-Za-z]{2})-(\d{5})/);
          if (unmaskMatch) {
            return {
              street: titleCaseAll(unmaskMatch[1].replace(/-/g, " ")),
              city: titleCaseAll(unmaskMatch[2].replace(/_/g, " ")),
              state: unmaskMatch[3].toUpperCase(),
              zip: unmaskMatch[4],
            };
          }

          // e.g. thatsThem URL: https://thatsthem.com/address/7603-E-8th-Pl-Denver-CO-80230
          var ttMatch = href.match(/address\/(.+?)-([A-Za-z]+)-([A-Za-z]{2})-(\d{5})/);
          if (ttMatch) {
            return {
              street: titleCaseAll(ttMatch[1].replace(/-/g, " ")),
              city: titleCaseAll(ttMatch[2].replace(/-/g, " ")),
              state: ttMatch[3].toUpperCase(),
              zip: ttMatch[4],
            };
          }

          if (parsed && parsed.zip) return parsed;
        }

        // 2. Try View Details button title
        var viewDetails = curr.querySelector('a[title*=" in "], a.btn[href*="/detail/"]');
        if (viewDetails) {
          var parsedTitle = parseAddress(viewDetails.getAttribute("title") || "");
          if (parsedTitle && parsedTitle.zip) return parsedTitle;
        }

        // 3. Fallback to searching the container text
        var parsedContainer = parseAddress(curr.textContent || "");
        if (parsedContainer && parsedContainer.zip) return parsedContainer;
      }
      curr = curr.parentElement;
    }

    return null;
  }

  function findPhoneFromContainer(card) {
    if (!card) return null;
    var phoneEl = card.querySelector("a.phone, .phone");
    if (phoneEl) {
      var text = (phoneEl.textContent || "").trim();
      var digits = text.replace(/\D/g, "");
      if (digits.length === 10) {
        return digits.slice(0, 3) + "-" + digits.slice(3, 6) + "-" + digits.slice(6);
      }
    }
    return null;
  }

  function findAgeFromContainer(card) {
    if (!card) return null;
    var ageEl = card.querySelector(".age, [class*='age']");
    if (ageEl) {
      var num = parseInt(ageEl.textContent.trim(), 10);
      if (!isNaN(num) && num > 18 && num < 110) return num;
    }
    return null;
  }

  function generateRealisticProfile(nameObj, addrObj, ageNum, phoneStr) {
    var age = ageNum || Math.floor(Math.random() * 35) + 40; // 40 to 75
    var currentYear = new Date().getFullYear();
    var birthYear = currentYear - age;
    var month = Math.floor(Math.random() * 12) + 1;
    var day = Math.floor(Math.random() * 28) + 1;
    var mm = month < 10 ? "0" + month : "" + month;
    var dd = day < 10 ? "0" + day : "" + day;
    var dob = mm + "/" + dd + "/" + birthYear;

    var firstClean = (nameObj.first || "Customer").toLowerCase().replace(/[^a-z]/g, "");
    var lastClean = (nameObj.last || "User").toLowerCase().replace(/[^a-z]/g, "");
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

    var street = (addrObj && addrObj.street) ? addrObj.street : "7603 E 8th Pl";

    return {
      fullName: nameObj.fullNameSlug ? nameObj.fullNameSlug.replace(/-/g, " ") : nameObj.first + " " + nameObj.last,
      name: {
        first: nameObj.first,
        middle: nameObj.parts && nameObj.parts.length > 2 ? nameObj.parts[1] : "",
        last: nameObj.last,
        suffix: nameObj.suffix || "",
      },
      address: {
        street: street,
        city: (addrObj && addrObj.city) ? addrObj.city : "Denver",
        state: (addrObj && addrObj.state) ? addrObj.state : "CO",
        zip: (addrObj && addrObj.zip) ? addrObj.zip : "80230",
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
      // Ctrl + Click (or Cmd + Click) opens original URL
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
      // Ctrl + Click (or Cmd + Click) opens original URL
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

    var card = btn.closest('.card, [class*="card"], .result, [class*="result"]');

    // Extract name
    var nameSpan = card ? card.querySelector(".name-given, a.name-link") : null;
    var nameText = nameSpan ? nameSpan.textContent.trim() : "";
    if (!nameText) {
      var title = btn.getAttribute("title") || "";
      var nameMatch = title.match(/more for\s+(.+?)\s+in\s+[A-Za-z\s.-]+,\s*[A-Za-z]{2}/i);
      if (nameMatch) nameText = nameMatch[1].trim();
    }

    var parsedName = parseName(nameText) || {
      first: "Travis",
      last: "Berry",
      parts: ["Travis", "Berry"],
      fullNameSlug: "Travis-Berry",
    };

    var parsedAddr = findAddressFromContainer(btn);
    var phoneStr = findPhoneFromContainer(card);
    var ageNum = findAgeFromContainer(card);

    var profile = generateRealisticProfile(parsedName, parsedAddr, ageNum, phoneStr);

    function handleAmicaClick(e) {
      // Ctrl + Click opens the original detail page URL
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

        // Refresh profile timestamp
        profile.timestamp = Date.now();

        // Save profile in storage for Amica tab to pick up
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
      if (root.matches(SELECTOR_VIEW_DETAILS)) processViewDetailsLink(root);
      else if (root.matches(SELECTOR_NAME)) processNameLink(root);
    }
    if (root.querySelectorAll) {
      root.querySelectorAll(SELECTOR_ADDRESS).forEach(processAddressLink);
      root.querySelectorAll(SELECTOR_VIEW_DETAILS).forEach(processViewDetailsLink);
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
