# Bitsight VRM — ServiceNow Playwright Test Suite

Core functionality and API-level test automation for the **Bitsight Vendor Risk Management (VRM)** integration inside **ServiceNow**, built with [Playwright](https://playwright.dev/).

The suite logs into a ServiceNow instance, then drives the Bitsight application UI (Application Configuration, Portfolio, Alerts, Incidents, Dashboard, etc.) while cross-checking results against the ServiceNow and Bitsight REST APIs.

---

## 1. Prerequisites

Before you start, make sure you have:

- **Node.js** v18 or later ([download](https://nodejs.org/))
- **npm** (comes bundled with Node.js)
- Access to a **ServiceNow instance** with the Bitsight VRM application installed
- Valid **Bitsight API tokens** for each mode you plan to test (CM, VRM, CM+VRM)
- Git, if you're cloning this repository

Check your versions:

```bash
node -v
npm -v
```

---

## 2. Installation

Clone the repository and install dependencies:

```bash
git clone <your-repo-url>
cd bs_vrm_playwright
npm install
```

Install the browser binaries Playwright needs (only required once, or after a Playwright version bump):

```bash
npx playwright install
```

---

## 3. Configure your environment

The tests read all credentials and instance details from a `.env` file — **nothing is hardcoded**. Create a file named `.env` in the project root and fill it in with your own values:

```dotenv
SN_USER=admin
SN_PASS=
SN_URL=https://dev421143.service-now.com/

CM_TOKEN=
VRM_TOKEN=
CMVRM_TOKEN=
```

| Variable      | Description                                                                 |
|---------------|-------------------------------------------------------------------------------|
| `SN_USER`     | ServiceNow login username (e.g. `admin`)                                     |
| `SN_PASS`     | ServiceNow login password                                                     |
| `SN_URL`      | Base URL of the ServiceNow instance under test                                |
| `CM_TOKEN`    | Bitsight API token for **Continuous Monitoring (CM)**-only mode               |
| `VRM_TOKEN`   | Bitsight API token for **VRM**-only mode                                      |
| `CMVRM_TOKEN` | Bitsight API token for the combined **CM + VRM** mode                         |

>  **Never commit your `.env` file.** It contains live credentials and tokens. Make sure `.env` is listed in `.gitignore`.

You only need to fill in the token(s) relevant to the test file(s) you intend to run — for example, `04_alerts_import_spec.js` needs both `CM_TOKEN` and `CMVRM_TOKEN`.

---

## 4. Project / test structure

```
bs_vrm_playwright/
├── package.json                   # Project metadata & dependencies (@playwright/test, dotenv)
├── playwright.config.js           # Playwright configuration (projects, baseURL, reporter, tracing)
├── .env                           # Your local credentials/tokens (create this — see step 3)
├── playwright/.auth/user.json     # Saved login session (generated automatically, git-ignored)
├── playwright-report/             # HTML report output (generated after a run)
└── tests/
    ├── 00_login_setup.spec.js     # Logs into ServiceNow once and saves the session
    ├── 01_cm_test_cases_spec.js   # CM-mode: portfolio, imports, permissions, reports
    ├── 03_cm_vrm_token_spec.js    # CM+VRM-mode: module access, imports, record views
    ├── 04_alerts_import_spec.js   # Alerts import & incident-creation rules (Type 1 & Type 3)
    └── utils/                     # Shared helpers (API clients, ServiceNow session helpers, cleanup)
```

`playwright.config.js` points `testDir` at `./tests`, so all spec files must live there (alongside the shared `utils/` folder they import from).

### How the login step is wired up

Instead of logging in through the UI on every single test (slow and flaky), this project uses Playwright's **authentication state reuse** pattern, configured via **projects** in `playwright.config.js`:

- A `setup` project matches only `login_setup.spec.js`. It logs into ServiceNow once with the credentials from `.env` and saves the resulting session to `playwright/.auth/user.json`.
- The `chromium` project declares `dependencies: ['setup']`, so Playwright always runs the setup project first, then reuses the saved `storageState` for every real test. It also uses `testIgnore` so the login spec itself is never re-run as a normal test.

In short: just run `npx playwright test` (see below) and the login happens automatically before anything else — you never need to run it manually. Firefox and WebKit projects are pre-wired in the config but currently commented out; uncomment them if you want cross-browser coverage.


---

## 5. Running the tests

> `package.json` doesn't define an `npm test` script yet, so use the `npx playwright test` commands below directly. (Optional: add `"test": "playwright test"` to the `scripts` block in `package.json` if you'd like to just run `npm test`.)

Run the entire suite (headless, default browser):

```bash
npx playwright test
```

Run a single spec file:

```bash
npx playwright test 01_cm_test_cases_spec.js
```

Run a single test by name (partial match on the test title):

```bash
npx playwright test -g "TC 002 Bitsight token validation"
```

Run in **headed** mode so you can watch the browser drive the UI live:

```bash
npx playwright test --headed
```

Run with the interactive **UI mode** (great for debugging — timeline, DOM snapshots, watch mode):

```bash
npx playwright test --ui
```

Step through a specific test with the **Playwright Inspector**:

```bash
npx playwright test 04_alerts_import_spec.js --debug
```


Re-run only the tests that failed last time:

```bash
npx playwright test --last-failed
```

---

## 6. Viewing results

After a run, generate and open the built-in HTML report (screenshots, traces, timings, retries):

```bash
npx playwright show-report
```

If a test fails, Playwright automatically captures a **trace** you can replay step-by-step, including every network request and DOM state:

```bash
npx playwright show-trace trace.zip
```

---

## 7. What's actually being tested

| File | Focus |
|---|---|
| `00_login_setup.spec.js` | ServiceNow login and session bootstrap |
| `01_cm_test_cases_spec.js` | CM-only token validation, portfolio import reconciliation against the live Bitsight API, subscription/folder management, assessment reports, and role-based (restricted user) access control |
| `03_cm_vrm_token_spec.js` | Combined CM+VRM token validation, module reachability, company-matching/insert/mark-as-vendor import flags, and record layout differences between CM-only, VRM-only, and CM+VRM companies |
| `04_alerts_import_spec.js` | Alerts import reconciliation and the incident-creation business rules (Critical/Warn severity, Public Disclosure, Security Rating score drops) for both **Type 1 (CM)** and **Type 3 (CM+VRM)** tokens |

Tests validate not just the UI, but cross-check the data ServiceNow displays against ground truth pulled directly from the **Bitsight** and **ServiceNow REST APIs**, using the shared helpers in `utils/`.

---

## 8. Troubleshooting

- **Login step times out** — double-check `SN_URL`, `SN_USER`, and `SN_PASS` in `.env`; the instance may also just be slow to wake up (the login spec already allows up to 60s).
- **Token validation fails** — confirm the relevant token (`CM_TOKEN` / `VRM_TOKEN` / `CMVRM_TOKEN`) is valid and hasn't expired in Bitsight.
- **`CM_TOKEN must be set...` assertion error** — the test explicitly requires that token and won't fall back to another one; add it to `.env`.
- **Browsers not found** — run `npx playwright install` again.

---

## 9. Useful links

- [Playwright documentation](https://playwright.dev/docs/intro)
- [Playwright test assertions](https://playwright.dev/docs/test-assertions)
- [Playwright UI mode](https://playwright.dev/docs/test-ui-mode)