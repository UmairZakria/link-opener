# Address & Name Link Opener with Amica Auto-Discovery

Chrome/Edge extension that finds address and name links on people search sites, rewrites them according to customizable toggle preferences, and automates vehicle discovery on Amica.

## Supported Data Sources & Triggers

- 📍 **Address Search**:
  - **Unmask**: `https://unmask.com/address/237-Reeves-Ranch-Rd--Victoria-TX-77905/`
  - **That's Them**: `https://thatsthem.com/address/237-Reeves-Ranch-Rd-Victoria-TX-77905`
  - **Advanced Background Checks**: `https://www.advancedbackgroundchecks.com/find/address/237-reeves-ranch-rd/victoria-TX-77905`

- 👤 **Name Search**:
  - **That's Them**: `https://thatsthem.com/name/Jack-L-Douglas/Fort-Worth-TX-76109`
  - **Advanced Background Checks**: `https://www.advancedbackgroundchecks.com/find/name/jack-douglas/in/TX/fort-worth`

- 🚗 **Amica Auto Vehicle Discovery Triggers**:
  1. **Search Results Cards**: Clicking **"VIEW DETAILS"**
  2. **Person Details Profiles**: Clicking **"Get Unlimited Background Details"** or **"View Full Background Report"**
  - Automatically extracts:
    - **Name**: e.g., `Esteban Pecina`
    - **DOB & Age**: Parses exact birth date (e.g., `Born July 1972` $\rightarrow$ `07/15/1972`) or computes from age
    - **Address**: Extracted from Most Recent Address (e.g., `305 Elda Dr, Brownsville, TX 78521`)
    - **Phone**: Extracted from Primary Phone (e.g., `(956) 504-2505` $\rightarrow$ `956-504-2505`)
  - Automatically navigates Amica, discovers all vehicles, and copies them to your clipboard.

- ⌨️ **Ctrl + Left Click (Original Link Bypass)**:
  - Holding **Ctrl** (or **Cmd** on Mac) while clicking any button or link opens the original URL.

- ⚙️ **Popup Settings UI**:
  - Light font (`font-weight: 300`) minimalist dark UI with real-time toggle syncing.

## Install / Reload

1. Open `chrome://extensions` (or `edge://extensions` in Edge).
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** (or click the reload icon ⟳ if already loaded).
4. Select this folder.
