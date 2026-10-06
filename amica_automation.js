(function () {
  "use strict";

  // Whether this frame is one the extension itself put on the page is decided at the very bottom
  // of this file, by confirmRunnerIsOurs(): it is a message round-trip to the background, so it
  // cannot be answered here. Only the cheap de-duplication check happens up front, because a
  // second injection into the same document (the manifest can inject into every matching frame)
  // must not start a second quote run.
  if (window.__amicaAutomationLoaded) return;
  window.__amicaAutomationLoaded = true;

  function ensurePoppinsFont() {
    if (document.getElementById("amica-automation-poppins-font")) return;
    try {
      var preconnect1 = document.createElement("link");
      preconnect1.rel = "preconnect";
      preconnect1.href = "https://fonts.googleapis.com";

      var preconnect2 = document.createElement("link");
      preconnect2.rel = "preconnect";
      preconnect2.href = "https://fonts.gstatic.com";
      preconnect2.crossOrigin = "anonymous";

      var fontLink = document.createElement("link");
      fontLink.id = "amica-automation-poppins-font";
      fontLink.rel = "stylesheet";
      fontLink.href =
        "https://fonts.googleapis.com/css2?family=Poppins:ital,wght@0,300;0,400;0,500;0,600;0,700&display=swap";

      document.head.appendChild(preconnect1);
      document.head.appendChild(preconnect2);
      document.head.appendChild(fontLink);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // Tick engine
  //
  // Amica runs in the offscreen document's own iframe, which Chrome does not throttle at all.
  // It can still fall back to a real background tab (`chrome.tabs.create({ active: false })`)
  // when the offscreen document is unavailable, and Chrome clamps timers in a hidden tab to one
  // call per second - and to one call a minute once the tab has been hidden for five minutes.
  // Polling with setInterval(..., 50) is what made the whole funnel crawl in that case. DOM
  // mutation callbacks are NOT throttled, so the funnel is driven by a MutationObserver instead,
  // with a slow safety timer for the steps that wait on time rather than on a DOM change.
  // ---------------------------------------------------------------------------
  var TICK_MIN_GAP_MS = 60; // never step more than ~16x per second
  var SAFETY_TICK_MS = 400; // covers waiting that happens while the page sits still
  var MAX_RUNTIME_MS = 90000; // hard stop for the whole run

  // A step of the funnel fires once and then waits for the page to move on. Clicking the same
  // button again on every tick queued duplicate quote requests that Amica answered slowly,
  // which is what made each step feel sluggish.
  var STEP_RETRY_MS = 1500;

  // The background worker broadcasts every progress message to every tab, so the loop must
  // not repeat the same line while it waits on a step.
  var PROGRESS_DEDUP_MS = 1500;

  var lastProgressKey = "";
  var lastProgressAt = 0;

  // Only lets a step act once per STEP_RETRY_MS; a genuine page change moves to another step
  // and resets the gate.
  function stepGate(state, key, now) {
    if (state.stepKey === key && now - (state.stepAt || 0) < STEP_RETRY_MS) {
      return false;
    }
    state.stepKey = key;
    state.stepAt = now;
    return true;
  }

  function createTicker(step, options) {
    var opts = options || {};
    var minGap = opts.minGapMs || TICK_MIN_GAP_MS;
    var observer = null;
    var safetyTimer = null;
    var followUpTimer = null;
    var running = false;
    var stopped = false;
    var lastRunAt = 0;

    function run(reason) {
      if (stopped || running) return;

      var stamp = Date.now();
      if (stamp - lastRunAt < minGap) {
        // A burst of mutations arrived while we were stepping: come back once it is safe to
        // run again instead of dropping the work.
        if (!followUpTimer) {
          followUpTimer = setTimeout(function () {
            followUpTimer = null;
            run("follow-up");
          }, minGap);
        }
        return;
      }

      running = true;
      lastRunAt = stamp;
      try {
        step(stamp, reason);
      } catch (e) {
        if (typeof opts.onError === "function") {
          opts.onError(e);
        } else {
          console.error("[Amica] Automation step failed:", e);
        }
      }
      running = false;
    }

    function onWake() {
      run("wake");
    }

    function start() {
      if (stopped || observer) return;

      if (
        typeof MutationObserver === "function" &&
        document &&
        document.documentElement
      ) {
        observer = new MutationObserver(function () {
          run("mutation");
        });
        try {
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: [
              "class",
              "disabled",
              "hidden",
              "style",
              "aria-hidden",
              "aria-disabled",
            ],
          });
        } catch (e) {
          observer = null;
        }
      }

      safetyTimer = setInterval(function () {
        run("interval");
      }, opts.safetyMs || SAFETY_TICK_MS);

      if (window && window.addEventListener) {
        window.addEventListener("visibilitychange", onWake);
        window.addEventListener("focus", onWake);
        window.addEventListener("pageshow", onWake);
        window.addEventListener("popstate", onWake);
        window.addEventListener("hashchange", onWake);
      }

      run("start");
    }

    function stop() {
      stopped = true;
      if (observer) {
        try {
          observer.disconnect();
        } catch (e) {}
        observer = null;
      }
      if (safetyTimer) {
        clearInterval(safetyTimer);
        safetyTimer = null;
      }
      if (followUpTimer) {
        clearTimeout(followUpTimer);
        followUpTimer = null;
      }
      if (window && window.removeEventListener) {
        window.removeEventListener("visibilitychange", onWake);
        window.removeEventListener("focus", onWake);
        window.removeEventListener("pageshow", onWake);
        window.removeEventListener("popstate", onWake);
        window.removeEventListener("hashchange", onWake);
      }
    }

    return { start: start, stop: stop, run: run };
  }

  function sendProgress(step, totalSteps, message) {
    var key = step + "|" + totalSteps + "|" + message;
    var stamp = Date.now();
    if (key === lastProgressKey && stamp - lastProgressAt < PROGRESS_DEDUP_MS) {
      return;
    }
    lastProgressKey = key;
    lastProgressAt = stamp;

    try {
      chrome.runtime
        .sendMessage({
          action: "VEHICLE_LOOKUP_PROGRESS",
          provider: "amica",
          step: step,
          totalSteps: totalSteps,
          message: message,
        })
        .catch(function () {});
    } catch (e) {}
  }

  function sendSuccess(vehicles, profile) {
    try {
      chrome.runtime
        .sendMessage({
          action: "VEHICLE_LOOKUP_SUCCESS",
          provider: "amica",
          vehicles: vehicles,
          profile: profile,
        })
        .catch(function () {});
    } catch (e) {}
  }

  function sendError(error) {
    try {
      chrome.runtime
        .sendMessage({
          action: "VEHICLE_LOOKUP_ERROR",
          provider: "amica",
          error: error,
        })
        .catch(function () {});
    } catch (e) {}
  }

  // Check for pending Amica quote profile
  function getPendingQuote(callback) {
    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      chrome.storage.local.get(["amica_pending_quote"], function (items) {
        if (items && items.amica_pending_quote) {
          var quote = items.amica_pending_quote;
          // Valid within 15 minutes
          if (Date.now() - (quote.timestamp || 0) < 15 * 60 * 1000) {
            return callback(quote);
          }
        }
        callback(null);
      });
    } else {
      callback(null);
    }
  }

  function isPoBox(addrStr) {
    if (!addrStr) return false;
    var s = String(addrStr).toLowerCase().trim();
    return (
      /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|\d+\s+po\s+box|po\s+box\s+\d+|box\s+\d+)\b/i.test(
        s,
      ) ||
      /^\s*p\.?\s*o\.?\s*box\b/i.test(s) ||
      /^\s*box\s+\d+/i.test(s) ||
      /\bpobox\b/i.test(s)
    );
  }

  function clearPendingQuote() {
    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      chrome.storage.local.remove(["amica_pending_quote"]);
    }
  }

  // React/Angular/Vanilla safe input setter with valueTracker
  function fillAndTypeInput(input, value) {
    if (!input || value === undefined || value === null) return;
    var strVal = String(value).trim();
    if (
      String(input.value).trim() === strVal &&
      !input.classList.contains("invalid")
    )
      return;

    input.focus();
    input.value = "";

    var nativeSetter =
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set ||
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")
        ?.set;

    var lastValue = input.value;
    if (nativeSetter) {
      nativeSetter.call(input, strVal);
    } else {
      input.value = strVal;
    }

    var tracker = input._valueTracker;
    if (tracker) {
      tracker.setValue(lastValue);
    }

    try {
      input.dispatchEvent(new Event("focus", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "a", bubbles: true }),
      );
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          data: value,
          inputType: "insertText",
        }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "a", bubbles: true }),
      );
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch (e) {}

    input.classList.remove("invalid");
    input.classList.add("filled");
    input.setAttribute("data-valid", "true");

    var parentWrapper = input.closest(".input-wrapper, .form-group");
    if (parentWrapper) {
      var reqMsgs = parentWrapper.querySelectorAll(
        ".data-cmp-required-message, .data-cmp-constraint-message, [id*='Address_req']",
      );
      reqMsgs.forEach(function (el) {
        el.classList.add("hidden");
        el.style.display = "none";
      });
    }
  }

  function setSelectValue(select, value) {
    if (!select) return;
    select.focus();

    var options = select.options;
    var found = false;
    for (var i = 0; i < options.length; i++) {
      if (
        options[i].value === value ||
        options[i].value === "OnlineMarketingSearchLeads" ||
        options[i].value === "AmicaCom" ||
        options[i].text.toLowerCase().includes("search") ||
        options[i].text.toLowerCase().includes("other")
      ) {
        select.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found && options.length > 1) {
      select.selectedIndex = options.length - 1;
    }

    var nativeSelectValueSetter =
      Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        "value",
      )?.set ||
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value")
        ?.set;

    if (nativeSelectValueSetter) {
      nativeSelectValueSetter.call(select, select.value);
    }

    var tracker = select._valueTracker;
    if (tracker) tracker.setValue("");

    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    select.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function clickRadioOrCheckbox(el) {
    if (!el) return;
    el.checked = true;
    var tracker = el._valueTracker;
    if (tracker) tracker.setValue(!el.checked);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("click", { bubbles: true }));
    var parentLabel = el.closest("label");
    if (parentLabel) parentLabel.click();
  }

  function clickElement(el) {
    if (!el) return;
    var targetBtn = el.closest("button") || el;
    if (targetBtn.disabled || targetBtn.getAttribute("aria-disabled") === "true") {
      return;
    }
    // Smooth scrolling steals time from the next step without helping the click; jump there.
    targetBtn.scrollIntoView({ behavior: "auto", block: "center" });
    targetBtn.focus();

    // A real user produces the pointer pair before the click, and some React/Angular buttons
    // only react to those. Exactly ONE click is dispatched: the click event already runs the
    // handlers and the default action, so the old follow-up targetBtn.click() fired every
    // Amica handler a second time and queued duplicate quote requests.
    var sequence = [
      ["pointerdown", typeof PointerEvent === "function" ? PointerEvent : null],
      ["mousedown", typeof MouseEvent === "function" ? MouseEvent : null],
      ["pointerup", typeof PointerEvent === "function" ? PointerEvent : null],
      ["mouseup", typeof MouseEvent === "function" ? MouseEvent : null],
      ["click", typeof MouseEvent === "function" ? MouseEvent : null],
    ];

    for (var i = 0; i < sequence.length; i++) {
      var Ctor = sequence[i][1] || Event;
      try {
        targetBtn.dispatchEvent(
          new Ctor(sequence[i][0], { bubbles: true, cancelable: true }),
        );
      } catch (e) {}
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () {
        fallbackCopy(text);
      });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
    } catch (e) {}
    document.body.removeChild(textarea);
  }

  function showDiscoveredBanner(vehicles, profile) {
    ensurePoppinsFont();

    var existing = document.getElementById("amica-discovered-vehicles-banner");
    if (existing) existing.remove();

    var banner = document.createElement("div");
    banner.id = "amica-discovered-vehicles-banner";
    banner.style.cssText = [
      "position: fixed",
      "top: 20px",
      "right: 20px",
      "z-index: 99999999",
      "background: #0f172a",
      "color: #f1f5f9",
      "padding: 20px 24px",
      "border-radius: 16px",
      "box-shadow: 0 20px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.1)",
      "font-family: 'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif !important",
      "font-weight: 300",
      "min-width: 320px",
      "max-width: 420px",
    ].join(";");

    var listHtml = vehicles
      .map(function (v) {
        return (
          '<li style="padding: 8px 12px; margin-bottom: 4px; background: rgba(255,255,255,0.06); border-radius: 8px; font-size: 13px; font-weight: 400; color: #38bdf8; font-family:Poppins, sans-serif;">' +
          v +
          "</li>"
        );
      })
      .join("");

    banner.innerHTML = [
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">',
      '  <div style="font-size:13.5px; font-weight:500; color:#22c55e; font-family:Poppins, sans-serif;">',
      "    Vehicles Discovered (" + vehicles.length + ")",
      "  </div>",
      '  <button id="amica-banner-close" style="background:none; border:none; color:#94a3b8; font-size:13px; font-family:Poppins, sans-serif; cursor:pointer; padding:2px 4px;">Close</button>',
      "</div>",
      '<p style="font-size:11px; color:#94a3b8; margin-bottom:10px; font-family:Poppins, sans-serif;">For: <strong>' +
        (profile.fullName ||
          (profile.name
            ? (profile.name.first || "") + " " + (profile.name.last || "")
            : "Customer")) +
        "</strong> • " +
        (profile.address
          ? (profile.address.city || "") + ", " + (profile.address.state || "")
          : "") +
        "</p>",
      '<ul style="list-style:none; padding:0; margin:0 0 12px 0;">' +
        listHtml +
        "</ul>",
      '<div style="font-size:11.5px; color:#22c55e; background:rgba(34, 197, 94, 0.1); border:1px solid rgba(34, 197, 94, 0.2); padding:6px 10px; border-radius:8px; text-align:center; font-family:Poppins, sans-serif;">',
      "  Copied to Clipboard",
      "</div>",
    ].join("");

    document.body.appendChild(banner);

    document
      .getElementById("amica-banner-close")
      ?.addEventListener("click", function () {
        banner.remove();
      });
  }

  // The wide text scan below is the most expensive query of the whole loop, so its result is
  // reused for a moment instead of being recomputed on every tick.
  var NO_VEHICLES_SCAN_GAP_MS = 250;
  var noVehiclesScannedAt = 0;
  var noVehiclesResult = false;

  function checkAmicaNoVehiclesFound() {
    var stamp = Date.now();
    if (stamp - noVehiclesScannedAt < NO_VEHICLES_SCAN_GAP_MS) {
      return noVehiclesResult;
    }
    noVehiclesScannedAt = stamp;
    noVehiclesResult = scanForNoVehiclesScreen();
    return noVehiclesResult;
  }

  function scanForNoVehiclesScreen() {
    if (document.getElementById("VEHICLE_INFO_ENTRY_OPTION-fieldset"))
      return true;
    if (document.getElementById("VEHICLE_INFO_ENTRY_OPTION-label-0"))
      return true;
    if (document.querySelector('input[name="VEHICLE_INFO_ENTRY_OPTION"]'))
      return true;
    if (document.querySelector('input[data-id*="VEHICLE_INFO_ENTRY_OPTION"]'))
      return true;
    if (
      document.querySelector(
        'input[data-analytics-id*="VEHICLE_INFO_ENTRY_OPTION"]',
      )
    )
      return true;

    var textElements = document.querySelectorAll(
      'legend, p, h1, h2, h3, h4, [type="body-span"]',
    );
    for (var i = 0; i < textElements.length; i++) {
      var txt = (textElements[i].textContent || "").toLowerCase();
      if (
        txt.includes("how would you like to enter your vehicle info") ||
        txt.includes("i'll do it myself")
      ) {
        return true;
      }
    }
    return false;
  }

  function sendEmpty(message, profile) {
    try {
      chrome.runtime.sendMessage({
        action: "VEHICLE_LOOKUP_EMPTY",
        provider: "amica",
        vehicles: [],
        message: message || "No vehicle found on Amica",
        profile: profile,
      });
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // STEP 2 address handling
  //
  // Amica silently stays on the address step when it cannot match the address and marks
  // the street field with class "invalid". When that happens the person's other addresses
  // are tried one by one, and if every one of them is rejected Nominatim (through the
  // background worker) is asked for a validated address which is then tried too.
  // ---------------------------------------------------------------------------
  var ADDRESS_SETTLE_MS = 150; // let input events settle before submitting
  var ADDRESS_VERDICT_MS = 300; // briefly allow Amica's invalid marker to settle
  var ADDRESS_GIVE_UP_MS = 7000; // page neither moved on nor flagged -> treat as a dud

  function buildAddressCandidates(profile) {
    var list = [];
    var seen = {};

    function add(raw) {
      if (!raw) return;
      var addr = typeof raw === "string" ? { street: raw } : raw;
      var street = String(addr.street || addr.full || "").trim();
      if (!street || isPoBox(street)) return;

      var key = street.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (!key || seen[key]) return;
      seen[key] = true;

      list.push({
        street: street,
        unit: String(addr.unit || "").trim(),
        city: String(addr.city || "").trim(),
        state: String(addr.state || "").trim(),
        zip: String(addr.zip || "").trim(),
      });
    }

    add(profile && profile.address);
    if (profile && Array.isArray(profile.allAddresses)) {
      profile.allAddresses.forEach(add);
    }
    return list;
  }

  function describeAddress(addr) {
    if (!addr) return "the address";
    return [addr.street, addr.city, addr.state].filter(Boolean).join(", ");
  }

  function applyAddressTo(form, addr, fallback) {
    var street = addr && addr.street ? addr.street.replace(/[,]/g, "").trim() : fallback.street;
    var unit = addr && addr.unit ? addr.unit.replace(/[,]/g, "").trim() : "";
    var city = addr && addr.city ? addr.city.trim() : fallback.city;
    var state = addr && addr.state ? addr.state.trim() : fallback.state;
    var zip = addr && addr.zip ? String(addr.zip).trim() : fallback.zip;

    if (form.streetAutocomplete) {
      form.streetAutocomplete.value = street;
      form.streetAutocomplete.setAttribute("value", street);
      form.streetAutocomplete.dispatchEvent(new Event("input", { bubbles: true }));
      form.streetAutocomplete.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (form.streetInput) fillAndTypeInput(form.streetInput, street);
    if (form.streetTwoInput && unit) fillAndTypeInput(form.streetTwoInput, unit);
    if (form.cityInput) fillAndTypeInput(form.cityInput, city);
    if (form.stateInput) fillAndTypeInput(form.stateInput, state);
    if (form.zipAddrInput) fillAndTypeInput(form.zipAddrInput, zip);
  }

  function requestGeocodedAddress(addr, callback) {
    try {
      chrome.runtime.sendMessage(
        { action: "GEOCODE_ADDRESS", address: addr },
        function (res) {
          callback(res && res.success ? res.address : null);
        },
      );
    } catch (e) {
      callback(null);
    }
  }

  function handleAddressStep(state, profile, form, now) {
    var fallback = { street: "3101 Highlawn Ter", city: "Fort Worth", state: "TX", zip: "76133" };

    if (!state.addressCandidates) {
      state.addressCandidates = buildAddressCandidates(profile);
      state.addressAttempt = 0;
      state.addressFilledAt = 0;
      state.addressClickedAt = 0;
      sendProgress(2, 6, "Entering street address and location...");
    }

    var candidate = state.addressCandidates[state.addressAttempt] || null;

    // Every known address was rejected -> validate one with Nominatim (once)
    if (!candidate) {
      if (state.geocodePending) return;

      if (state.geocodeAsked) {
        sendEmpty("Amica rejected every known address for this person", profile);
        state.stopped = true;
        return;
      }

      state.geocodeAsked = true;
      state.geocodePending = true;
      var askFor = state.addressCandidates[0] || (profile && profile.address) || {};
      sendProgress(2, 6, "Amica rejected every address - validating one with OpenStreetMap...");

      requestGeocodedAddress(askFor, function (geo) {
        state.geocodePending = false;
        if (geo && state.addressCandidates) {
          state.addressCandidates.push(geo);
          state.addressAttempt = state.addressCandidates.length - 1;
          state.addressFilledAt = 0;
          state.addressClickedAt = 0;
          sendProgress(2, 6, "Retrying with the validated address: " + describeAddress(geo));
        }
      });
      return;
    }

    // 1. Type this address once per attempt (fillAndTypeInput clears the "invalid" mark)
    if (!state.addressFilledAt) {
      applyAddressTo(form, candidate, fallback);
      state.addressFilledAt = now;
      state.addressClickedAt = 0;
      return;
    }

    // 2. Press "Start Your Quote" once the fields have settled
    if (!state.addressClickedAt) {
      if (now - state.addressFilledAt < ADDRESS_SETTLE_MS) return;
      if (!form.startQuoteBtn) return;
      var quoteButton = form.startQuoteBtn.closest("button") || form.startQuoteBtn;
      if (
        quoteButton.disabled ||
        quoteButton.getAttribute("aria-disabled") === "true" ||
        (quoteButton.offsetParent === null &&
          quoteButton.getClientRects().length === 0)
      ) {
        return;
      }
      quoteButton.scrollIntoView({ behavior: "auto", block: "center" });
      quoteButton.focus();
      quoteButton.click();
      state.addressClickedAt = now;
      sendProgress(2, 6, "Submitted address with Start Your Quote...");
      return;
    }

    // 3. Still on the address step: Amica either flagged the address as invalid or it is
    //    simply not moving on. Both cases mean this address is a dud.
    var waited = now - state.addressClickedAt;

    if (form.streetInput.classList.contains("invalid") && waited > ADDRESS_VERDICT_MS) {
      sendProgress(2, 6, "Amica rejected " + describeAddress(candidate) + " - trying the next address...");
      state.addressAttempt += 1;
      state.addressFilledAt = 0;
      state.addressClickedAt = 0;
      return;
    }

    if (waited > ADDRESS_GIVE_UP_MS) {
      sendProgress(2, 6, "No response for " + describeAddress(candidate) + " - trying the next address...");
      state.addressAttempt += 1;
      state.addressFilledAt = 0;
      state.addressClickedAt = 0;
    }
  }

  // The quote finished but Amica returned no vehicles for the address it was given. Amica only
  // lists vehicles for an address it can tie to the person, and a record's primary address is not
  // always that one - so the person's other addresses are tried before the lookup is reported empty.
  //
  // A retry is a fresh quote: the background starts a new Amica session with the next address as the
  // primary one and points the runner at it, and the new page walks the funnel from the quoting ZIP.
  // Which addresses have already been tried is remembered by the background for the whole run, so
  // this can never bounce between two of them.
  function retryWithNextAddress(state, profile, reason) {
    var candidates = state.addressCandidates || buildAddressCandidates(profile);
    var usedUpTo = typeof state.addressAttempt === "number" ? state.addressAttempt : 0;
    var used = candidates[usedUpTo];

    state.stopped = true;

    sendProgress(
      4,
      6,
      (reason || "No vehicles found") +
        (used ? " for " + describeAddress(used) : "") +
        " - trying the next address...",
    );

    try {
      chrome.runtime.sendMessage(
        {
          action: "AMICA_NEXT_ADDRESS",
          candidates: candidates,
          usedUpTo: usedUpTo,
          reason: reason || "No vehicles found",
        },
        function (res) {
          // The background is pointing Amica at the next address; this page is done.
          if (res && res.ok) return;

          sendEmpty("No vehicle found on Amica for any known address", profile);
          clearPendingQuote();
        },
      );
    } catch (e) {
      sendEmpty("No vehicle found on Amica", profile);
      clearPendingQuote();
    }
  }

  // Automation Engine
  function runAutomation(profile) {
    var state = {
      vehiclesFound: false,
      startTime: Date.now(),
      clearedStorage: false,
      stopped: false,
      // Step gate: which step acted last and when (see stepGate)
      stepKey: "",
      stepAt: 0,
      // STEP 2 address retry bookkeeping
      addressCandidates: null,
      addressAttempt: 0,
      addressFilledAt: 0,
      addressClickedAt: 0,
      geocodeAsked: false,
      geocodePending: false,
    };

    // On fresh quote start, clear residual session storage
    try {
      if (window.location.pathname === "/" || window.location.pathname === "") {
        sessionStorage.clear();
      }
    } catch (e) {}

    sendProgress(1, 6, "Starting Amica vehicle automation...");

    var ticker = createTicker(function (now) {
      if (state.vehiclesFound || state.stopped) {
        ticker.stop();
        return;
      }

      // Timeout safety
      if (now - state.startTime > MAX_RUNTIME_MS) {
        ticker.stop();
        sendError("Amica vehicle lookup timed out after 90 seconds.");
        clearPendingQuote();
        return;
      }

      // ==========================================
      // STEP 6: Vehicles Discovered (Highest Priority)
      // ==========================================
      var vehicleFieldset = document.getElementById(
        "prefill-item-select-fieldset",
      );
      if (vehicleFieldset) {
        var vehicleLabels = vehicleFieldset.querySelectorAll(
          "span[type='body-span'], label, span",
        );
        var vehicles = [];
        vehicleLabels.forEach(function (el) {
          var t = (el.textContent || "").trim();
          if (/^\d{4}\s+[A-Z0-9\s-]+$/i.test(t) && !vehicles.includes(t)) {
            vehicles.push(t);
          }
        }, {
          onError: function (e) {
            state.stopped = true;
            ticker.stop();
            console.error("[Amica] Automation step failed:", e);
            sendError(
              "Amica automation error: " +
                (e && e.message ? e.message : String(e)),
            );
            clearPendingQuote();
          },
        });

        if (vehicles.length > 0) {
          state.vehiclesFound = true;
          ticker.stop();
          var textToCopy = vehicles.join("\n");
          copyToClipboard(textToCopy);
          showDiscoveredBanner(vehicles, profile);
          sendSuccess(vehicles, profile);
          clearPendingQuote();
          return;
        }
      }

      // Check if Amica indicates NO vehicles found for customer. Amica only lists vehicles for an
      // address it can tie to the person, so the person's other addresses are tried before this is
      // reported as empty (see retryWithNextAddress).
      if (checkAmicaNoVehiclesFound()) {
        state.vehiclesFound = false;
        ticker.stop();
        retryWithNextAddress(state, profile, "No vehicles found");
        return;
      }

      // ==========================================
      // STEP 5: Driver Information Form
      // ==========================================
      var doneBtnStep5 = document.querySelector(
        'button#DRIVER-0-done-adding, button[name="DRIVER-0-done-adding"], button[data-id*="DRIVER-0-done-adding"], button[data-id*="DRIVER-done-adding"]',
      );
      var genderRadio = document.querySelector(
        'input[data-id*="GENDER_IDENTITY"], input[name="GENDER_IDENTITY"]',
      );
      var relationRadio = document.querySelector(
        'input[data-id*="RELATIONSHIP_STATUS"], input[name="RELATIONSHIP_STATUS"]',
      );
      var ageLicensed =
        document.getElementById("AGE_LICENSED") ||
        document.querySelector('input[name="AGE_LICENSED"]');

      if (doneBtnStep5 || (genderRadio && relationRadio)) {
        sendProgress(5, 6, "Submitting driver profile...");
        var targetGender = profile.gender === "F" ? "F" : "M";
        var genEl =
          document.querySelector(
            'input[name="GENDER_IDENTITY"][value="' + targetGender + '"]',
          ) || genderRadio;
        if (genEl && !genEl.checked) clickRadioOrCheckbox(genEl);

        var relEl =
          document.querySelector(
            'input[name="RELATIONSHIP_STATUS"][value="M"]',
          ) || relationRadio;
        if (relEl && !relEl.checked) clickRadioOrCheckbox(relEl);

        if (ageLicensed && (!ageLicensed.value || ageLicensed.value !== "16")) {
          fillAndTypeInput(ageLicensed, "16");
        }

        var milNo = document.querySelector(
          'input[name="MILITARY_DISCOUNT"][value="no"]',
        );
        if (milNo && !milNo.checked) clickRadioOrCheckbox(milNo);

        var defNo = document.querySelector(
          'input[name="DEFENSIVE_DRIVING"][value="no"]',
        );
        if (defNo && !defNo.checked) clickRadioOrCheckbox(defNo);

        // The fields above are refreshed on every tick, but the submit itself only fires once
        // per attempt: a second one while Amica is still answering queued a duplicate request.
        if (doneBtnStep5 && stepGate(state, "driver", now)) {
          clickElement(doneBtnStep5);
        }
        return;
      }

      // ==========================================
      // STEP 4: Personal / Contact Information Form
      // ==========================================
      var continueBtnStep4 = document.querySelector(
        'button#INTRO_2-continue, button[name="INTRO_2-continue"], button[data-id*="INTRO_2-continue"], button[id="INTRO_2-continue"]',
      );
      var firstNameInput = document.querySelector('input[name="FirstName"]');
      var lastNameInput = document.querySelector('input[name="LastName"]');
      var middleInput = document.querySelector('input[name="MiddleInitial"]');
      var dobInput =
        document.getElementById("DOB") ||
        document.querySelector('input[name="DOB"]');
      var emailInput =
        document.getElementById("Email") ||
        document.querySelector('input[name="Email"]');
      var phoneInput = document.querySelector(
        'input[name="Cell Phone Number"]',
      );

      if (continueBtnStep4 || (firstNameInput && lastNameInput && dobInput)) {
        sendProgress(4, 6, "Entering personal & contact information...");
        var howHearSelect = document.querySelector(
          'select[name="HOW_DID_YOU_HEAR"]',
        );
        if (
          howHearSelect &&
          (!howHearSelect.value || howHearSelect.value === "")
        ) {
          setSelectValue(howHearSelect, "OnlineMarketingSearchLeads");
        }

        var fName =
          profile.name && profile.name.first ? profile.name.first : "Customer";
        var lName =
          profile.name && profile.name.last ? profile.name.last : "User";
        var mInitial =
          profile.name && profile.name.middle
            ? profile.name.middle.charAt(0)
            : "";
        var targetDob = profile.dob || "08/15/1975";
        var targetEmail = profile.email || "customer782@gmail.com";
        var targetPhone = profile.phone || "817-294-4402";

        if (firstNameInput && firstNameInput.value !== fName) {
          fillAndTypeInput(firstNameInput, fName);
        }

        if (middleInput && mInitial && middleInput.value !== mInitial) {
          fillAndTypeInput(middleInput, mInitial);
        }

        if (lastNameInput && lastNameInput.value !== lName) {
          fillAndTypeInput(lastNameInput, lName);
        }

        if (profile.name && profile.name.suffix) {
          var suffixSelect = document.querySelector('select[name="Suffix"]');
          if (
            suffixSelect &&
            suffixSelect.value !== profile.name.suffix.toLowerCase()
          ) {
            setSelectValue(suffixSelect, profile.name.suffix.toLowerCase());
          }
        }

        if (dobInput && dobInput.value !== targetDob) {
          fillAndTypeInput(dobInput, targetDob);
        }
        if (emailInput && emailInput.value !== targetEmail) {
          fillAndTypeInput(emailInput, targetEmail);
        }
        if (phoneInput && phoneInput.value !== targetPhone) {
          fillAndTypeInput(phoneInput, targetPhone);
        }

        var tcpaCheckbox =
          document.getElementById("quoting-tcpa-opt-in") ||
          document.querySelector('input[name="quoting-tcpa-opt-in"]');
        if (tcpaCheckbox && !tcpaCheckbox.checked) {
          clickRadioOrCheckbox(tcpaCheckbox);
        }

        if (continueBtnStep4 && stepGate(state, "contact", now)) {
          clickElement(continueBtnStep4);
        }
        return;
      }

      // ==========================================
      // STEP 3: "Are you currently an Amica customer?"
      // ==========================================
      var nextBtnStep3 = document.querySelector(
        'button#INTRO_1-continue, button[name="INTRO_1-continue"], button[data-id*="INTRO_1-continue"], button[data-analytics-id*="INTRO_1-continue"]',
      );
      var currentCustomerNo = document.querySelector(
        'input[data-id*="CURRENT_CUSTOMER.no"], input[name="CURRENT_CUSTOMER"][value="no"]',
      );

      if (nextBtnStep3 || currentCustomerNo) {
        sendProgress(3, 6, "Confirming customer status...");
        if (currentCustomerNo && !currentCustomerNo.checked) {
          clickRadioOrCheckbox(currentCustomerNo);
        }

        if (nextBtnStep3 && stepGate(state, "customer", now)) {
          clickElement(nextBtnStep3);
        }
        return;
      }

      // ==========================================
      // STEP 2: Address Entry Form (#autofilladdress / #addressForm)
      // ==========================================
      var streetInput =
        document.getElementById("addressLineOneInputQuoting") ||
        document.querySelector('input[name="addressLineOne"]');
      var addressForm =
        document.getElementById("addressForm") ||
        (streetInput && streetInput.closest("form"));
      var streetAutocomplete =
        addressForm &&
        addressForm.querySelector(
          "[data-quote-address-autocomplete] gmp-place-autocomplete",
        );
      var startQuoteBtn =
        (addressForm &&
          (addressForm.querySelector(
            'button.quote-flyout-panel__button[data-id="GetaQuote.aStartQuote"]',
          ) || addressForm.querySelector("#quoteActionButton"))) ||
        document.querySelector(
          'button.quote-flyout-panel__button[data-id="GetaQuote.aStartQuote"]',
        ) ||
        document.querySelector('button[data-id="GetaQuote.aStartQuote"]') ||
        document.getElementById("quoteActionButton");
      var streetTwoInput =
        document.getElementById("addressLineTwoInputQuoting") ||
        document.querySelector(
          'input[name="addressLineTwo"], input[name="aptSuite"]',
        );
      var cityInput =
        document.getElementById("cityInputQuoting") ||
        document.querySelector('input[name="city"]');
      var stateInput =
        document.getElementById("stateInputQuoting") ||
        document.querySelector('input[name="state"]');
      var zipAddrInput =
        document.getElementById("zipcodeAddrInputQuoting") ||
        document.querySelector('input[name="zip"]');

      if (
        streetInput &&
        cityInput &&
        addressForm &&
        (addressForm.offsetParent !== null ||
          addressForm.getClientRects().length > 0)
      ) {
        handleAddressStep(
          state,
          profile,
          {
            streetInput: streetInput,
            streetAutocomplete: streetAutocomplete,
            streetTwoInput: streetTwoInput,
            cityInput: cityInput,
            stateInput: stateInput,
            zipAddrInput: zipAddrInput,
            startQuoteBtn: startQuoteBtn,
          },
          now,
        );
        return;
      }

      // The address step is no longer on screen, so it was accepted: forget the retry
      // bookkeeping in case this form ever comes back later in the funnel.
      if (state.addressCandidates) {
        state.addressCandidates = null;
        state.addressAttempt = 0;
        state.addressFilledAt = 0;
        state.addressClickedAt = 0;
      }

      // ==========================================
      // STEP 1B: Auto + Home Product Selection Panel
      // ==========================================
      var autoHomeBtn = document.querySelector(
        'button[data-id="GetaQuote:OnlineProducts.aAutoHome"], button[data-combotype="HO3"], #bundleList button:first-child',
      );

      if (!autoHomeBtn) {
        var allBtns = document.querySelectorAll("button");

        for (var b = 0; b < allBtns.length; b++) {
          if (
            allBtns[b].textContent.trim().toLowerCase().includes("auto + home")
          ) {
            autoHomeBtn = allBtns[b];
            break;
          }
        }
      }

      // Final fallback: Auto button
      if (!autoHomeBtn) {
        autoHomeBtn = document.querySelector(
          'button[data-id="GetaQuote:OnlineProducts.aAuto"]',
        );
      }
      
      if (autoHomeBtn && autoHomeBtn.offsetParent !== null) {
        sendProgress(1, 6, "Selecting auto product bundle...");
        if (stepGate(state, "bundle", now)) {
          clickElement(autoHomeBtn);
        }
        return;
      }

      // ==========================================
      // STEP 1A: Initial Quoting ZIP
      // ==========================================
      var landingZip =
        document.getElementById("zip-input-quote_hero") ||
        document.querySelector(".quote-hero__pulldown .zip-input__field");
      var landingForm =
        (landingZip &&
          (landingZip.closest(".quote-hero__pulldown") ||
            landingZip.closest("form"))) ||
        document.querySelector(".quote-hero__pulldown");
      var landingProductSelect =
        landingForm &&
        landingForm.querySelector(
          '.quote-hero__select-field, select[id*="quote-hero-select-field"]',
        );
      var landingSubmit =
        landingForm &&
        landingForm.querySelector(
          ".quote-hero__pulldown-submit, button[type='submit']",
        );

      if (
        landingZip &&
        landingForm &&
        (landingZip.offsetParent !== null ||
          landingZip.getClientRects().length > 0)
      ) {
        var bundledValue = "PrivatePassenger|HO3";
        var autoOnlyValue = "PrivatePassenger";
        if (landingProductSelect) {
          var availableValues = [];
          for (var i = 0; i < landingProductSelect.options.length; i++) {
            availableValues.push(String(landingProductSelect.options[i].value));
          }
          if (
            availableValues.indexOf(bundledValue) === -1 &&
            availableValues.indexOf(autoOnlyValue) !== -1
          ) {
            bundledValue = autoOnlyValue;
          }
          if (landingProductSelect.value !== bundledValue) {
            setSelectValue(landingProductSelect, bundledValue);
          }
        }

        var initialZip =
          profile.address && profile.address.zip
            ? String(profile.address.zip).trim()
            : "76133";
        sendProgress(1, 6, "Entering ZIP code " + initialZip + "...");
        if (landingZip.value !== initialZip) {
          fillAndTypeInput(landingZip, initialZip);
        }
        if (stepGate(state, "zip", now)) {
          if (landingSubmit) {
            clickElement(landingSubmit);
          } else if (typeof landingForm.requestSubmit === "function") {
            landingForm.requestSubmit();
          } else {
            return;
          }
        }
        return;
      }

      var initZip = document.getElementById("zipcodeInitInputQuoting");
      if (initZip && initZip.offsetParent !== null) {
        var initialZip =
          profile.address && profile.address.zip
            ? String(profile.address.zip).trim()
            : "76133";
        sendProgress(1, 6, "Entering ZIP code " + initialZip + "...");
        if (initZip.value !== initialZip) {
          fillAndTypeInput(initZip, initialZip);
        }
        var getQuoteBtn = document.querySelector(
          'button[data-id="GetaQuote.CheckAvailablity"], button.init-get-products-button, .get-products-button',
        );
        if (getQuoteBtn && stepGate(state, "zip", now)) {
          clickElement(getQuoteBtn);
        }
        return;
      }
    });

    ticker.start();

    // Belt and braces: a stuck page must never leave the observer or the safety timer behind.
    setTimeout(function () {
      ticker.stop();
    }, MAX_RUNTIME_MS + 15000);
  }

  // Whether this frame is one the extension itself put on the page.
  //
  // A top-level tab is always fine (that is the long-standing path). A subframe has to be
  // confirmed by the background, because there is no reliable way to tell from inside the
  // frame who the parent is:
  //
  //   - `parent.location` throws across origins from the isolated world, so it cannot be read.
  //   - `document.referrer` is empty here: Chrome sends no Referer header from an extension
  //     page, so the offscreen runner looks exactly like a frame with no parent at all. It is
  //     also wrong in the other direction - once the quote flow navigates (ZIP step -> quote
  //     app) the referrer becomes an amica.com URL, so a referrer check would kill the run on
  //     its second page even after it had started.
  //
  // The background can answer authoritatively: a content script running in a normal tab always
  // has `sender.tab`, and the offscreen document is not a tab, so it is the only context where
  // a frame can legitimately say yes. A page that embeds www.amica.com in one of its own
  // frames is in a tab, and is refused.
  function confirmRunnerIsOurs(callback) {
    if (window.parent === window) {
      callback(true);
      return;
    }
    try {
      chrome.runtime.sendMessage({ action: "RUNNER_HELLO" }, function (res) {
        if (chrome.runtime.lastError) {
          callback(false);
          return;
        }
        callback(!!(res && res.ok));
      });
    } catch (e) {
      callback(false);
    }
  }

  // ------------------------------------------------------------------ staying loaded and idle
  //
  // The background keeps this page loaded between searches (see prewarmAmica), so a lookup can begin
  // straight at the quoting ZIP instead of waiting for Amica to boot again. Two things are needed for
  // that: the background has to know when this page is genuinely usable, and this page has to notice a
  // quote that arrives while it is already sitting here.

  // How long the page may take to become usable before it is reported as not usable.
  var READY_MAX_MS = 20000;

  // One page serves exactly one run: the funnel navigates deep into the quote flow, so the next
  // search gets a freshly loaded frame rather than this one.
  var started = false;

  function reportRunnerReady(ready) {
    try {
      chrome.runtime.sendMessage({ action: "AMICA_RUNNER_READY", ready: !!ready });
    } catch (e) {}
  }

  function startWithQuote(quote) {
    if (started) return;
    if (!quote || !quote.address) return;
    started = true;
    // From here on this page is no longer a parked, idle runner.
    reportRunnerReady(false);
    runAutomation(quote);
  }

  // The page is usable once its quoting ZIP field is on screen. A quote written before that would not
  // be noticed, and the background would have to load Amica the slow way after all - so this is
  // reported honestly rather than as soon as the document says it is complete.
  function waitUntilUsable(callback) {
    var began = Date.now();
    (function poll() {
      var readyField =
        document.getElementById("zipcodeInitInputQuoting") ||
        document.querySelector(
          ".quote-hero__pulldown #zip-input-quote_hero, .quote-hero__pulldown .zip-input__field",
        );
      if (document.readyState === "complete" && readyField) {
        callback(true);
        return;
      }
      if (Date.now() - began > READY_MAX_MS) {
        callback(false);
        return;
      }
      setTimeout(poll, 300);
    })();
  }

  // Start when page is loaded. The runner check is a message round-trip, so the whole start is
  // deferred until the background has answered - starting before then would drive the quote flow in a
  // frame that may not be ours.
  confirmRunnerIsOurs(function (isOurs) {
    if (!isOurs) return;

    // A quote that was already pending when this page loaded: a cold start, or a reload.
    getPendingQuote(function (quote) {
      startWithQuote(quote);
    });

    // A quote that arrives while this page is parked and warm. This is the fast path: no reload, so
    // the run begins at the quoting ZIP immediately.
    try {
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== "local" || !changes.amica_pending_quote) return;
        startWithQuote(changes.amica_pending_quote.newValue);
      });
    } catch (e) {}

    waitUntilUsable(function (usable) {
      reportRunnerReady(usable);
    });
  });
})();
