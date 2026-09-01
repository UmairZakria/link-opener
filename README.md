# Address & Name Link Opener with Amica Auto-Discovery

Chrome/Edge extension that finds address and name links on people search sites, rewrites them according to customizable toggle preferences, and automates vehicle discovery on Amica.

## Features

- 📍 **Address Search**:
  - **Unmask**: `https://unmask.com/address/237-Reeves-Ranch-Rd--Victoria-TX-77905/`
  - **That's Them**: `https://thatsthem.com/address/237-Reeves-Ranch-Rd-Victoria-TX-77905`
  - **Advanced Background Checks**: `https://www.advancedbackgroundchecks.com/find/address/237-reeves-ranch-rd/victoria-TX-77905`

- 👤 **Name Search**:
  - **That's Them**: `https://thatsthem.com/name/Jack-L-Douglas/Fort-Worth-TX-76109`
  - **Advanced Background Checks**: `https://www.advancedbackgroundchecks.com/find/name/jack-douglas/in/TX/fort-worth`

- 🚗 **Automated Amica Vehicle Discovery**:
  - Clicking **VIEW DETAILS** extracts the person's name, address, age/DOB, and phone number.
  - Automatically opens Amica in a new tab, enters the data through all quote steps, extracts all registered vehicles, and copies them to your clipboard automatically.

- ⌨️ **Ctrl + Left Click (Original Link Bypass)**:
  - Holding **Ctrl** (or **Cmd** on Mac) while clicking any link opens the original URL.

- ⚙️ **Popup Settings UI**:
  - Light font (`font-weight: 300`) minimalist dark UI with real-time toggle syncing.

## Install / Reload

1. Open `chrome://extensions` (or `edge://extensions` in Edge).
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** (or click the reload icon ⟳ if already loaded).
4. Select this folder.
