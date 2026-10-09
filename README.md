# Address & Name Link Opener with Amica & Mercury Auto-Discovery

Chrome/Edge extension that finds address and name links on people search sites, rewrites them according to customizable toggle preferences, and automates vehicle discovery on **Amica** and **Mercury Insurance** (with auto-fallback).

## Supported Data Sources & Features

- 📍 **Address Search**:
  - **Unmask**: `https://unmask.com/address/3101-Highlawn-Ter--Fort_Worth-TX-76133/`
  - **That's Them**: `https://thatsthem.com/address/3101-Highlawn-Ter-Fort-Worth-TX-76133`
  - **Advanced Background Checks**: `https://www.advancedbackgroundchecks.com/find/address/3101-highlawn-ter/fort-worth-TX-76133`

- 👤 **Name Search**:
  - **That's Them**: `https://thatsthem.com/name/Lloyd-D-White/Fort-Worth-TX-76133`
  - **Advanced Background Checks**: `https://www.advancedbackgroundchecks.com/find/name/lloyd-white/in/TX/fort-worth`

- 🚗 **Dual Vehicle Discovery Providers**:
  - Clicking **"VIEW DETAILS"** or **"Get Unlimited Background Details"** displays an interactive choice modal:
    1. **Amica Auto (🚗)**: Runs the Amica vehicle discovery automation.
    2. **Mercury Insurance (⚡)**: Runs the Mercury quote flow. If Mercury fails to find vehicles or times out, it **automatically falls back to Amica** and searches there!
  - Discovered vehicles are automatically copied to your clipboard and shown in a notification banner.

- ⌨️ **Ctrl + Left Click (Original Link Bypass)**:
  - Holding **Ctrl** (or **Cmd** on Mac) while clicking any button or link opens the original URL.

- 🎂 **Exact DOB Search on AdvancedBackgroundChecks**:
  - Person profiles show a **Search** button beside the Birth Date.
  - Search checks all current and previous addresses first, then each available phone number, and searches by the profile name and known-as names last.
  - Unmask result cards with open-ended ages such as **80+** are not rejected on age alone; the opened profile still has to pass the existing identity checks and exact DOB match.
  - In parallel, it opens the plain Men Stopping Violence name-search URL on either `www` or apex domain. That tab requests its target identity from the extension by tab ID, scans the visible result cards, and immediately reports a matching name and exact DOB to the source profile. The first exact DOB match stops the other search tab.
  - A compact live progress indicator shows the current search stage. A result is reported only when both birth month and year match exactly; the lookup runs in an inactive Unmask tab without switching away from your current tab. Complete any security check manually if one appears.

- ⚙️ **Popup Settings UI**:
  - Minimal light UI with real-time toggle syncing.
  - **Refresh** saves pending settings and reloads the extension; **Save & Close** persists the settings before closing the popup.

## Install / Reload

1. Open `chrome://extensions` (or `edge://extensions` in Edge).
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** (or click the reload icon ⟳ if already loaded).
4. Select this folder.
