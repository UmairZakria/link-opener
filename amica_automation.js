(function () {
  "use strict";

  // Check for pending Amica quote profile
  function getPendingQuote(callback) {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
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

  function clearPendingQuote() {
    if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
      chrome.storage.local.remove(["amica_pending_quote"]);
    }
  }

  // React/Angular/Vanilla safe input setter with valueTracker
  function fillAndTypeInput(input, value) {
    if (!input || value === undefined || value === null) return;
    input.focus();

    var nativeSetter =
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set ||
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;

    var lastValue = input.value;
    if (nativeSetter) {
      nativeSetter.call(input, value);
    } else {
      input.value = value;
    }

    // React 16+ input tracker
    var tracker = input._valueTracker;
    if (tracker) {
      tracker.setValue(lastValue);
    }

    try {
      input.dispatchEvent(new Event("focus", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("blur", { bubbles: true }));
    } catch (e) {}

    input.classList.remove("invalid");
    input.classList.add("filled");
    input.setAttribute("data-valid", "true");

    var parentWrapper = input.closest(".input-wrapper, .form-group");
    if (parentWrapper) {
      var reqMsgs = parentWrapper.querySelectorAll(
        ".data-cmp-required-message, .data-cmp-constraint-message, [id*='Address_req']"
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
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set ||
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), "value")?.set;

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
    targetBtn.scrollIntoView({ behavior: "smooth", block: "center" });
    targetBtn.focus();
    try {
      targetBtn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
      targetBtn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      targetBtn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
      targetBtn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      targetBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    } catch (e) {}
    if (typeof targetBtn.click === "function") targetBtn.click();
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

  // Floating UI Banner to show vehicles
  function showDiscoveredBanner(vehicles, profile) {
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
      "font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      "font-weight: 300",
      "min-width: 320px",
      "max-width: 420px",
    ].join(";");

    var listHtml = vehicles
      .map(function (v) {
        return (
          '<li style="padding: 6px 10px; margin-bottom: 4px; background: rgba(255,255,255,0.06); border-radius: 8px; font-size: 13.5px; font-weight: 400; color: #38bdf8; display: flex; align-items: center; gap: 8px;">' +
          '🚗 <span>' +
          v +
          "</span></li>"
        );
      })
      .join("");

    banner.innerHTML = [
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">',
      '  <div style="font-size:14px; font-weight:500; color:#22c55e; display:flex; align-items:center; gap:6px;">',
      '    <span style="font-size:16px;">✓</span> Vehicles Discovered (' +
        vehicles.length +
        ")",
      "  </div>",
      '  <button id="amica-banner-close" style="background:none; border:none; color:#94a3b8; font-size:16px; cursor:pointer;">✕</button>',
      "</div>",
      '<p style="font-size:11px; color:#94a3b8; margin-bottom:10px;">For: <strong>' +
        (profile.fullName || (profile.name ? profile.name.first + " " + profile.name.last : "Customer")) +
        "</strong> • " +
        (profile.address ? profile.address.city + ", " + profile.address.state : "") +
        "</p>",
      '<ul style="list-style:none; padding:0; margin:0 0 12px 0;">' + listHtml + "</ul>",
      '<div style="font-size:11.5px; color:#22c55e; background:rgba(34, 197, 94, 0.1); border:1px solid rgba(34, 197, 94, 0.2); padding:6px 10px; border-radius:8px; text-align:center;">',
      "  📋 Copied to Clipboard Automatically!",
      "</div>",
    ].join("");

    document.body.appendChild(banner);

    document.getElementById("amica-banner-close").addEventListener("click", function () {
      banner.remove();
    });
  }

  // Automation Engine with continuous state checking & auto-retry
  function runAutomation(profile) {
    var state = {
      vehiclesFound: false,
      lastActionTime: 0,
    };

    var interval = setInterval(function () {
      if (state.vehiclesFound) {
        clearInterval(interval);
        return;
      }

      var now = Date.now();

      // ==========================================
      // STEP 6: Vehicles Discovered (Highest Priority)
      // ==========================================
      var vehicleFieldset = document.getElementById("prefill-item-select-fieldset");
      if (vehicleFieldset) {
        var vehicleLabels = vehicleFieldset.querySelectorAll(
          "span[type='body-span'], label, span"
        );
        var vehicles = [];
        vehicleLabels.forEach(function (el) {
          var t = (el.textContent || "").trim();
          if (/^\d{4}\s+[A-Z0-9\s-]+$/i.test(t) && !vehicles.includes(t)) {
            vehicles.push(t);
          }
        });

        if (vehicles.length > 0) {
          state.vehiclesFound = true;
          clearInterval(interval);
          var textToCopy = vehicles.join("\n");
          copyToClipboard(textToCopy);
          showDiscoveredBanner(vehicles, profile);
          clearPendingQuote();
          return;
        }
      }

      // Throttle form submissions to avoid double-posting
      if (now - state.lastActionTime < 1000) {
        return;
      }

      // ==========================================
      // STEP 5: Driver Information Form
      // ==========================================
      var doneBtnStep5 = document.querySelector(
        'button#DRIVER-0-done-adding, button[name="DRIVER-0-done-adding"], button[data-id*="DRIVER-0-done-adding"], button[data-id*="DRIVER-done-adding"]'
      );
      var genderRadio = document.querySelector(
        'input[data-id*="GENDER_IDENTITY"], input[name="GENDER_IDENTITY"]'
      );
      var relationRadio = document.querySelector(
        'input[data-id*="RELATIONSHIP_STATUS"], input[name="RELATIONSHIP_STATUS"]'
      );
      var ageLicensed = document.getElementById("AGE_LICENSED") || document.querySelector('input[name="AGE_LICENSED"]');

      if (doneBtnStep5 || (genderRadio && relationRadio)) {
        var targetGender = profile.gender === "F" ? "F" : "M";
        var genEl = document.querySelector('input[name="GENDER_IDENTITY"][value="' + targetGender + '"]') || genderRadio;
        if (genEl && !genEl.checked) clickRadioOrCheckbox(genEl);

        var relEl = document.querySelector('input[name="RELATIONSHIP_STATUS"][value="M"]') || relationRadio;
        if (relEl && !relEl.checked) clickRadioOrCheckbox(relEl);

        if (ageLicensed && (!ageLicensed.value || ageLicensed.value !== "16")) {
          fillAndTypeInput(ageLicensed, "16");
        }

        var milNo = document.querySelector('input[name="MILITARY_DISCOUNT"][value="no"]');
        if (milNo && !milNo.checked) clickRadioOrCheckbox(milNo);

        var defNo = document.querySelector('input[name="DEFENSIVE_DRIVING"][value="no"]');
        if (defNo && !defNo.checked) clickRadioOrCheckbox(defNo);

        if (doneBtnStep5) {
          clickElement(doneBtnStep5);
          state.lastActionTime = now;
        }
        return;
      }

      // ==========================================
      // STEP 4: Personal / Contact Information Form
      // ==========================================
      var continueBtnStep4 = document.querySelector(
        'button#INTRO_2-continue, button[name="INTRO_2-continue"], button[data-id*="INTRO_2-continue"], button[id="INTRO_2-continue"]'
      );
      var firstNameInput = document.querySelector('input[name="FirstName"]');
      var lastNameInput = document.querySelector('input[name="LastName"]');
      var middleInput = document.querySelector('input[name="MiddleInitial"]');
      var dobInput = document.getElementById("DOB") || document.querySelector('input[name="DOB"]');
      var emailInput = document.getElementById("Email") || document.querySelector('input[name="Email"]');
      var phoneInput = document.querySelector('input[name="Cell Phone Number"]');

      if (continueBtnStep4 || (firstNameInput && lastNameInput && dobInput)) {
        var howHearSelect = document.querySelector('select[name="HOW_DID_YOU_HEAR"]');
        if (howHearSelect && (!howHearSelect.value || howHearSelect.value === "")) {
          setSelectValue(howHearSelect, "OnlineMarketingSearchLeads");
        }

        var fName = (profile.name && profile.name.first) ? profile.name.first : "Lloyd";
        var lName = (profile.name && profile.name.last) ? profile.name.last : "White";
        var mInitial = (profile.name && profile.name.middle) ? profile.name.middle.charAt(0) : "";

        if (firstNameInput && !firstNameInput.value) {
          fillAndTypeInput(firstNameInput, fName);
        }

        if (middleInput && mInitial && !middleInput.value) {
          fillAndTypeInput(middleInput, mInitial);
        }

        if (lastNameInput && !lastNameInput.value) {
          fillAndTypeInput(lastNameInput, lName);
        }

        if (profile.name && profile.name.suffix) {
          var suffixSelect = document.querySelector('select[name="Suffix"]');
          if (suffixSelect && !suffixSelect.value) setSelectValue(suffixSelect, profile.name.suffix.toLowerCase());
        }

        if (dobInput && !dobInput.value) fillAndTypeInput(dobInput, profile.dob || "08/15/1941");
        if (emailInput && !emailInput.value) fillAndTypeInput(emailInput, profile.email || "customer782@gmail.com");
        if (phoneInput && !phoneInput.value) fillAndTypeInput(phoneInput, profile.phone || "817-294-4402");

        var tcpaCheckbox = document.getElementById("quoting-tcpa-opt-in") ||
          document.querySelector('input[name="quoting-tcpa-opt-in"]');
        if (tcpaCheckbox && !tcpaCheckbox.checked) {
          clickRadioOrCheckbox(tcpaCheckbox);
        }

        if (continueBtnStep4) {
          clickElement(continueBtnStep4);
          state.lastActionTime = now;
        }
        return;
      }

      // ==========================================
      // STEP 3: "Are you currently an Amica customer?"
      // ==========================================
      var nextBtnStep3 = document.querySelector(
        'button#INTRO_1-continue, button[name="INTRO_1-continue"], button[data-id*="INTRO_1-continue"], button[data-analytics-id*="INTRO_1-continue"]'
      );
      var currentCustomerNo = document.querySelector(
        'input[data-id*="CURRENT_CUSTOMER.no"], input[name="CURRENT_CUSTOMER"][value="no"]'
      );

      if (nextBtnStep3 || currentCustomerNo) {
        if (currentCustomerNo && !currentCustomerNo.checked) {
          clickRadioOrCheckbox(currentCustomerNo);
        }

        if (nextBtnStep3) {
          clickElement(nextBtnStep3);
          state.lastActionTime = now;
        }
        return;
      }

      // ==========================================
      // STEP 2: Address Entry Form (#autofilladdress / #addressForm)
      // ==========================================
      var startQuoteBtn = document.getElementById("quoteActionButton") ||
        document.querySelector('button[data-id="GetaQuote.aStartQuote"], button[type="submit"]');
      var streetInput = document.getElementById("addressLineOneInputQuoting") ||
        document.querySelector('input[name="addressLineOne"]');
      var streetTwoInput = document.getElementById("addressLineTwoInputQuoting") ||
        document.querySelector('input[name="addressLineTwo"], input[name="aptSuite"]');
      var cityInput = document.getElementById("cityInputQuoting") ||
        document.querySelector('input[name="city"]');
      var stateInput = document.getElementById("stateInputQuoting") ||
        document.querySelector('input[name="state"]');
      var zipAddrInput = document.getElementById("zipcodeAddrInputQuoting") ||
        document.querySelector('input[name="zip"]');

      if (streetInput && cityInput && streetInput.offsetParent !== null) {
        var cleanStreet = (profile.address && profile.address.street)
          ? profile.address.street.replace(/[,]/g, "").trim()
          : "3101 Highlawn Ter";
        var cleanUnit = (profile.address && profile.address.unit)
          ? profile.address.unit.replace(/[,]/g, "").trim()
          : "";
        var cleanCity = (profile.address && profile.address.city) ? profile.address.city.trim() : "Fort Worth";
        var cleanState = (profile.address && profile.address.state) ? profile.address.state.trim() : "TX";
        var cleanZip = (profile.address && profile.address.zip) ? profile.address.zip.trim() : "76133";

        if (!streetInput.value || streetInput.classList.contains("invalid")) {
          fillAndTypeInput(streetInput, cleanStreet);
          if (streetTwoInput && cleanUnit) {
            fillAndTypeInput(streetTwoInput, cleanUnit);
          }
          fillAndTypeInput(cityInput, cleanCity);
          fillAndTypeInput(stateInput, cleanState);
          fillAndTypeInput(zipAddrInput, cleanZip);
        }

        if (startQuoteBtn) {
          clickElement(startQuoteBtn);
          state.lastActionTime = now;
        }
        return;
      }

      // ==========================================
      // STEP 1B: Auto + Home Product Selection Panel
      // ==========================================
      var autoHomeBtn = document.querySelector(
        'button[data-id="GetaQuote:OnlineProducts.aAutoHome"], button[data-combotype="HO3"], #bundleList button:first-child'
      );
      if (!autoHomeBtn) {
        var allBtns = document.querySelectorAll("button");
        for (var b = 0; b < allBtns.length; b++) {
          if (allBtns[b].textContent.trim().toLowerCase().includes("auto + home")) {
            autoHomeBtn = allBtns[b];
            break;
          }
        }
      }

      if (autoHomeBtn && autoHomeBtn.offsetParent !== null) {
        clickElement(autoHomeBtn);
        state.lastActionTime = now;
        return;
      }

      // ==========================================
      // STEP 1A: Initial Quoting ZIP
      // ==========================================
      var initZip = document.getElementById("zipcodeInitInputQuoting");
      if (initZip && initZip.offsetParent !== null) {
        var initialZip = (profile.address && profile.address.zip) ? profile.address.zip : "76133";
        if (!initZip.value) {
          fillAndTypeInput(initZip, initialZip);
        }
        var getQuoteBtn = document.querySelector(
          'button[data-id="GetaQuote.CheckAvailablity"], button.init-get-products-button, .get-products-button'
        );
        if (getQuoteBtn) {
          clickElement(getQuoteBtn);
          state.lastActionTime = now;
        }
        return;
      }
    }, 400);

    // Keep active for up to 3 minutes
    setTimeout(function () {
      clearInterval(interval);
    }, 180000);
  }

  // Start when page is loaded
  getPendingQuote(function (quote) {
    if (quote) {
      runAutomation(quote);
    }
  });
})();
