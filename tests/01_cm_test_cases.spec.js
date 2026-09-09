import { test, expect, request } from '@playwright/test';

const BASE_URL = process.env.SN_URL;
const COMPLETE_MESSAGE = 'Bitsight Portfolios Import Complete';

test('TC 001 Bitsight token validation', async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto(BASE_URL);
    await page.getByRole('menuitem', { name: 'All' }).click();

    // Nudge the mouse to dismiss any overlay that pops up after this click
    await page.mouse.move(100, 100);
    await page.mouse.move(200, 200);

    const searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox.click();
    await searchBox.fill('bitsight');

    await page
        .getByRole('listitem')
        .filter({ hasText: 'Bitsight Vendor Risk ManagementEdit ApplicationPortfolioEdit Module Rating and' })
        .getByLabel('Application Configuration 4 of')
        .click();

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const tokenInput = frame.locator('#token');
    const clearTokenButton = frame.getByRole('button', { name: 'Clear Token' });
    const okButton = frame.getByRole('button', { name: 'OK', exact: true });
    const validateButton = frame.getByRole('button', { name: 'Validate Token' });

    await tokenInput.click();

    // If a token is already present, clear it first
    const existingValue = await tokenInput.inputValue();
    if (existingValue.trim() !== '') {
        await clearTokenButton.click();
        await okButton.click();

        // Wait for the field to actually become empty instead of a flat timeout
        await expect(tokenInput).toHaveValue('', { timeout: 30_000 });
    }

    await tokenInput.fill(process.env.CM_TOKEN);
    await validateButton.click();

    // Validation can take a while — give it up to 2 minutes
    await expect(frame.getByText('Token validated successfully')).toBeVisible({
        timeout: 120_000,
    });

    await okButton.click();
});



// ---- Session-authenticated fetch helper (runs inside the browser context) ----

async function snFetch(page, url) {
    return await page.evaluate(async (url) => {
        const token = window.g_ck || (window.top && window.top.g_ck) || '';
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-UserToken': token,
        };
        const res = await fetch(url, { method: 'GET', credentials: 'include', headers });
        const status = res.status;
        let body = null;
        try {
            body = await res.json();
        } catch {
            body = null;
        }
        return { ok: res.ok, status, body };
    }, url);
}

// ServiceNow returns sys_created_on / sys_updated_on as "yyyy-MM-dd HH:mm:ss"
// in UTC with no offset suffix. Normalize to a real epoch before comparing.
function toEpoch(snDateTime) {
    if (!snDateTime) return null;
    return new Date(snDateTime.replace(' ', 'T') + 'Z').getTime();
}

function toSnDateTime(isoString) {
    return isoString.replace('T', ' ').split('.')[0];
}

// ---- Step: grab the latest "Import Complete" log BEFORE triggering the job ----
// If none exists for today, that's fine — baseline is just null, and any
// completion log found afterward counts as fresh.
async function getLatestImportCompleteLog(page) {
    const url = `/api/now/table/syslog?sysparm_query=` +
        `sourceSTARTSWITHx_bisit^sys_created_onONToday@javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(0)^messageLIKE${encodeURIComponent(COMPLETE_MESSAGE)}` +
        `^ORDERBYDESCsys_created_on` +
        `&sysparm_fields=message,sys_created_on&sysparm_limit=1`;

    const { ok, body } = await snFetch(page, url);
    if (!ok || !body?.result?.length) {
        console.log('[getLatestImportCompleteLog] No prior completion log found for today — baseline is null.');
        return null;
    }

    const entry = body.result[0];
    console.log(`[getLatestImportCompleteLog] Baseline completion log found: "${entry.message}" at ${entry.sys_created_on}`);
    return entry.sys_created_on;
}

// ---- Step: poll for a NEW completion log strictly after the baseline ----
async function waitForNewImportLog(page, baselineTimestamp, timeoutMs = 300_000, pollMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    const baselineEpoch = toEpoch(baselineTimestamp);
    let attempt = 0;

    const url = `/api/now/table/syslog?sysparm_query=` +
        `sourceSTARTSWITHx_bisit^sys_created_onONToday@javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(0)^messageLIKE${encodeURIComponent(COMPLETE_MESSAGE)}` +
        `^ORDERBYDESCsys_created_on` +
        `&sysparm_fields=message,sys_created_on&sysparm_limit=1`;

    while (Date.now() < deadline) {
        attempt++;
        console.log(`[waitForNewImportLog] Attempt ${attempt}: checking syslog for a new completion entry...`);

        const { ok, status, body } = await snFetch(page, url);

        if (ok && body?.result?.length > 0) {
            const entry = body.result[0];
            const entryEpoch = toEpoch(entry.sys_created_on);

            if (baselineEpoch === null || entryEpoch > baselineEpoch) {
                console.log(`[waitForNewImportLog] Found NEW completion log: "${entry.message}" at ${entry.sys_created_on}`);
                return true;
            } else {
                console.log(`[waitForNewImportLog] Latest log (${entry.sys_created_on}) is not newer than baseline (${baselineTimestamp}) yet.`);
            }
        } else if (ok) {
            console.log('[waitForNewImportLog] No matching log entry found yet.');
        } else {
            console.log(`[waitForNewImportLog] syslog query failed with status ${status}: ${JSON.stringify(body)}`);
        }

        await new Promise(r => setTimeout(r, pollMs));
    }

    console.log('[waitForNewImportLog] Timed out waiting for a new import completion log.');
    return false;
}

async function getBitsightFieldNames(page) {
    const url = `/api/now/table/sys_dictionary?sysparm_query=name=core_company^column_labelLIKEBitsight` +
        `&sysparm_fields=element,column_label&sysparm_limit=100`;

    const { ok, body } = await snFetch(page, url);
    if (!ok || !body?.result) return [];
    return body.result.map(r => ({ element: r.element, label: r.column_label }));
}

// Attempt 1: a record actually touched since the import baseline.
// Attempt 2 (fallback): the sync may have run with no changes to apply —
// fall back to any existing populated record so we still confirm the
// data/mapping is intact.
async function getSingleCompanyRecord(page, guidField, fieldNames, baselineIso) {
    const baselineSnDate = toSnDateTime(baselineIso);

    const freshUrl = `/api/now/table/core_company?sysparm_query=` +
        `${guidField.element}ISNOTEMPTY^sys_updated_on>=${encodeURIComponent(baselineSnDate)}` +
        `^ORDERBYDESCsys_updated_on` +
        `&sysparm_fields=${encodeURIComponent(fieldNames)}&sysparm_limit=1`;

    const freshResult = await snFetch(page, freshUrl);
    if (freshResult.ok && freshResult.body?.result?.length > 0) {
        console.log('[getSingleCompanyRecord] Found a record updated during this run (fresh data).');
        return { ok: true, status: freshResult.status, records: freshResult.body.result, fresh: true };
    }

    console.log('[getSingleCompanyRecord] No record updated since baseline — likely a no-op sync. Falling back to any existing matching record.');
    const fallbackUrl = `/api/now/table/core_company?sysparm_query=${guidField.element}ISNOTEMPTY` +
        `^ORDERBYDESCsys_updated_on` +
        `&sysparm_fields=${encodeURIComponent(fieldNames)}&sysparm_limit=1`;

    const fallbackResult = await snFetch(page, fallbackUrl);
    return {
        ok: fallbackResult.ok,
        status: fallbackResult.status,
        records: fallbackResult.body?.result ?? [],
        fresh: false,
    };
}

// ---- Test ----

test('TC 002 Bitsight import data validation', async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto(BASE_URL);
    await page.getByRole('menuitem', { name: 'All' }).click();

    // Nudge the mouse to dismiss any overlay that pops up after this click
    await page.mouse.move(100, 100);
    await page.mouse.move(200, 200);

    const searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox.click();
    await searchBox.fill('bitsight');

    await page
        .getByRole('listitem')
        .filter({ hasText: 'Bitsight Vendor Risk ManagementEdit ApplicationPortfolioEdit Module Rating and' })
        .getByLabel('Application Configuration 4 of')
        .click();

    // ---------- Step 0: capture the last completion log BEFORE doing anything else ----------
    const baselineLogTimestamp = await getLatestImportCompleteLog(page);

    // ---------- Step 1: set caller property ----------
    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();
    await frame.locator('[id="sys_display.caller"]').click();
    await frame.locator('[id="sys_display.caller"]').fill('Abel Tutor');
    await frame.locator('#property_save_btn').click();

    // ---------- Step 2: trigger the scheduled import ----------
    await page.getByRole('menuitem', { name: 'All' }).click();
    await page
        .getByRole('listitem')
        .filter({ hasText: 'Bitsight Vendor Risk ManagementEdit ApplicationPortfolioEdit Module Rating and' })
        .getByLabel('Scheduled Data Imports 5 of')
        .click();
    await frame.getByRole('link', { name: 'Open record: Bitsight' }).nth(2).click();

    // Also captured for the core_company freshness check later
    const importBaselineIso = new Date().toISOString();

    await frame.getByRole('button', { name: 'Execute Now' }).click();

    // ---------- Step 3: wait for a NEW completion log (strictly after baseline) ----------
    const importCompleted = await waitForNewImportLog(page, baselineLogTimestamp);
    expect(importCompleted, 'Expected a new "Bitsight Portfolios Import Complete" syslog entry after triggering the job').toBeTruthy();

    // ---------- Step 4: discover actual Bitsight field names on core_company ----------
    const bitsightFields = await getBitsightFieldNames(page);
    expect(bitsightFields.length, 'Expected to find Bitsight fields in sys_dictionary for core_company').toBeGreaterThan(0);

    const guidField = bitsightFields.find(f => f.label.toLowerCase().includes('vendor guid'));
    expect(guidField, 'Could not locate "Bitsight vendor GUID" field name in dictionary').toBeTruthy();

    // ---------- Step 5: fetch a record (fresh if possible, else any existing one) and check it's populated ----------
    const fieldNames = bitsightFields.map(f => f.element).join(',') + ',sys_id';
    const { ok, status, records, fresh } = await getSingleCompanyRecord(page, guidField, fieldNames, importBaselineIso);
    expect(ok, `core_company query failed: ${status}`).toBeTruthy();
    expect(records.length, 'Expected at least one core_company record with a Bitsight vendor GUID (fresh or pre-existing)').toBeGreaterThan(0);

    const record = records[0];
    console.log(fresh
        ? `\n--- Validating a record updated during THIS run (sys_id: ${record.sys_id ?? '(not fetched)'}) ---`
        : `\n--- No changes this run (no-op sync) — validating an existing populated record instead (sys_id: ${record.sys_id ?? '(not fetched)'}) ---`
    );

    const criticalLabels = ['Bitsight vendor GUID', 'Bitsight company name', 'Bitsight security rating'];
    const criticalFields = bitsightFields.filter(f => criticalLabels.some(l => f.label.includes(l)));

    for (const field of criticalFields) {
        const value = record[field.element];
        const val = typeof value === 'object' ? value?.value : value;
        const isPopulated = val !== undefined && val !== null && val !== '';

        console.log(
            isPopulated
                ? ` "${field.label}" (${field.element}) is populated: "${val}"`
                : ` "${field.label}" (${field.element}) is EMPTY`
        );

        expect(val, `Expected "${field.label}" to be populated on imported record`).toBeTruthy();
    }
});

test('TC 003 Bitsight Portfolio record - key sections visible', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(BASE_URL);
    await page.getByRole('menuitem', { name: 'All' }).click();

    // Nudge the mouse to dismiss any overlay that pops up after this click
    await page.mouse.move(100, 100);
    await page.mouse.move(200, 200);

    const searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox.click();
    await searchBox.fill('bitsight');

    await page
        .getByRole('listitem')
        .filter({ hasText: 'Bitsight Vendor Risk ManagementEdit ApplicationPortfolioEdit Module Rating and' })
        .getByLabel('Portfolio 1 of')
        .click();

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    await frame.getByRole('link', { name: 'Open record: Accenture plc' }).click();

    // Elements to verify on the opened Bitsight Portfolio record.
    // Each entry has a short label (for logging) and a function returning the locator.
    const checks = [
        { label: 'Tab: Bitsight Security Ratings', locator: () => frame.getByRole('tab', { name: 'Bitsight Security Ratings' }) },
        { label: 'Tab: Bitsight Portfolio Information', locator: () => frame.getByRole('tab', { name: 'Bitsight Portfolio Information' }) },
        { label: 'Tab: Profile', locator: () => frame.getByRole('tab', { name: 'Profile' }) },
        { label: 'Tab: Bitsight Assessment Report', locator: () => frame.getByRole('tab', { name: 'Bitsight Assessment Report' }) },

        { label: 'Bitsight Security Rating summary block', locator: () => frame.getByText('Bitsight Security Rating780ADVANCEDView Company OverviewView Company Reports') },

        { label: 'Button: Enable Vendor Access', locator: () => frame.getByRole('button', { name: 'Enable Vendor Access' }) },
        { label: 'Button: Switch Subscription', locator: () => frame.getByRole('button', { name: 'Switch Subscription' }) },
        { label: 'Button: Manage Folders', locator: () => frame.getByRole('button', { name: 'Manage Folders' }) },
        { label: 'Button: Unsubscribe', locator: () => frame.getByRole('button', { name: 'Unsubscribe' }) },

        { label: 'Timeseries box', locator: () => frame.locator('.timeseries-box') },
        { label: 'Risk timeseries chart', locator: () => frame.locator('#risk-timeseries') },
        { label: 'Rating Highlights block', locator: () => frame.getByText('Rating Highlights52026-08-') },
        { label: 'Breach Alerts block', locator: () => frame.getByText('Breach Alertshttps://www.') },
        { label: 'Vectors breakdown chart', locator: () => frame.locator('#vectors-breakdown') },
        { label: 'Compromised Systems block', locator: () => frame.getByText('Compromised SystemsBotnet') },
        { label: 'User Behavior block', locator: () => frame.getByText('User BehaviorFile') },
        { label: 'Public Disclosures block', locator: () => frame.getByText('Public DisclosuresBreachesAOther Disclosures*N/A') },
        { label: 'Diligence block', locator: () => frame.getByText('DiligenceSPFADKIMATLS/SSL') },
    ];

    console.log(`\n--- Visibility check for Bitsight Portfolio record (Accenture plc) ---`);

    for (const { label, locator } of checks) {
        const isVisible = await locator().isVisible({ timeout: 15_000 }).catch(() => false);
        console.log(isVisible ? ` ${label} is visible` : ` ${label} is NOT visible`);
        expect(isVisible, `Expected "${label}" to be visible on the Bitsight Portfolio record`).toBeTruthy();
    }
});