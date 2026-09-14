import { test, expect, request } from '@playwright/test';

const BASE_URL = process.env.SN_URL;
const COMPLETE_MESSAGE = 'Bitsight Portfolios Import Complete';
const { BitsightApiClient } = require('./utils/bitsight-api-client'); // adjust path as needed
const {ServiceNowApiClient} = require('./utils/servicenow-api-client'); // adjust path as needed

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
function unwrapField(val) {
    return (val && typeof val === 'object' && val.value !== undefined) ? val.value : val;
}

// Tier 1 Completeness Query: full-population GUIDs from core_company.
// Does NOT filter by sys_updated_on.
async function getBitsightVendorGuids(page) {
    const allGuids = [];
    const limit = 200;
    let offset = 0;
    let hasMore = true;

    console.log('[getBitsightVendorGuids] Fetching full-population Bitsight GUIDs from core_company (session token)...');

    while (hasMore) {
        const url = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY` +
            `^ORDERBYDESCsys_updated_on` +
            `&sysparm_fields=sys_id,x_bisit_vrm_bitsight_vendor_guid` +
            `&sysparm_limit=${limit}&sysparm_offset=${offset}`;

        const { ok, status, body } = await snFetch(page, url);
        if (!ok) {
            throw new Error(`Failed to query core_company GUIDs (HTTP ${status}): ${JSON.stringify(body)}`);
        }

        const results = body?.result || [];
        if (!results.length) {
            hasMore = false;
            break;
        }

        for (const row of results) {
            const guid = unwrapField(row.x_bisit_vrm_bitsight_vendor_guid) || '';
            const sysId = unwrapField(row.sys_id) || '';
            if (guid) {
                allGuids.push({ sys_id: sysId, guid: String(guid).trim() });
            }
        }

        if (results.length < limit) {
            hasMore = false;
        } else {
            offset += limit;
        }
    }

    console.log(`[getBitsightVendorGuids] Retrieved ${allGuids.length} total Bitsight GUIDs from core_company.`);
    return allGuids;
}

// Tier 2 Sample Query: random N records from recently updated core_company records.
async function getRandomRecentlyUpdatedCoreCompanies(page, sampleSize = 15, poolLimit = 50) {
    console.log(`[getRandomRecentlyUpdatedCoreCompanies] Fetching pool of up to ${poolLimit} recently updated core_company records...`);

    const fields = [
        'x_bisit_vrm_risk_score',
        'x_bisit_vrm_due_date',
        'x_bisit_vrm_is_managed',
        'x_bisit_vrm_company_name',
        'x_bisit_vrm_is_vrm',
        'x_bisit_vrm_primary_domain',
        'x_bisit_vrm_bitsight_rating_category',
        'x_bisit_vrm_bitsight_vendor_guid',
        'x_bisit_vrm_life_cycle_stage_name',
        'x_bisit_vrm_security_rating',
        'x_bisit_vrm_impact_score',
        'x_bisit_vrm_trust_score',
        'x_bisit_vrm_vendor_guid',
        'x_bisit_vrm_rating_date',
        'sys_id',
    ].join(',');

    const url = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY` +
        `^ORDERBYDESCsys_updated_on` +
        `&sysparm_fields=${fields}` +
        `&sysparm_limit=${poolLimit}`;

    const { ok, status, body } = await snFetch(page, url);
    if (!ok) {
        throw new Error(`Failed to query recently updated core_company records (HTTP ${status}): ${JSON.stringify(body)}`);
    }

    const results = body?.result || [];
    console.log(`[getRandomRecentlyUpdatedCoreCompanies] Retrieved pool of ${results.length} recently updated core_company records.`);

    if (!results.length) return [];

    const shuffled = [...results].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, Math.min(sampleSize, shuffled.length));

    console.log(`[getRandomRecentlyUpdatedCoreCompanies] Randomly selected ${selected.length} records for Tier 2 field validation.`);

    return selected.map(row => {
        const normalized = {};
        for (const key of Object.keys(row)) {
            normalized[key] = unwrapField(row[key]);
        }
        return normalized;
    });
}

// Extracts the failed portfolios count from syslog message matching
// 'There were {N} failed portfolios.' between baseline and completion.
async function getFailedPortfoliosCount(page, options = {}) {
    const { baselineTimestamp, completionTimestamp } = options;
    const baselineSnDate = baselineTimestamp ? toSnDateTime(baselineTimestamp) : '';
    const completionSnDate = completionTimestamp ? toSnDateTime(completionTimestamp) : '';

    let query = `sourceSTARTSWITHx_bisit^messageLIKEfailed portfolios`;
    if (baselineSnDate) {
        query += `^sys_created_on>=${baselineSnDate}`;
    }
    if (completionSnDate) {
        query += `^sys_created_on<=${completionSnDate}`;
    }
    query += `^ORDERBYDESCsys_created_on`;

    const url = `/api/now/table/syslog?sysparm_query=${query}&sysparm_fields=message,sys_created_on&sysparm_limit=50`;
    const { ok, body } = await snFetch(page, url);

    if (ok && body?.result?.length) {
        for (const entry of body.result) {
            const match = String(entry.message || '').match(/There were\s+(\d+)\s+failed portfolios/i);
            if (match) {
                const count = parseInt(match[1], 10);
                console.log(`[getFailedPortfoliosCount] Found syslog failure summary: "${entry.message}" -> failedCount = ${count}`);
                return count;
            }
        }
    }

    console.log('[getFailedPortfoliosCount] No failure summary found in syslog - assuming 0 failed portfolios.');
    return 0;
}
// Generic loose-equality comparator for ground-truth vs ServiceNow field values.
// Treats null/undefined/'' as equivalent, compares numbers numerically,
// booleans leniently (true/'true'/1/'1'), dates by their date-only portion,
// and everything else as trimmed, case-insensitive strings.
function areValuesEqual(expected, actual) {
    const isEmpty = (v) => v === undefined || v === null || v === '';

    if (isEmpty(expected) && isEmpty(actual)) {
        return true;
    }
    if (isEmpty(expected) || isEmpty(actual)) {
        return false;
    }

    // Boolean-ish values
    const boolLike = (v) => typeof v === 'boolean' || v === 'true' || v === 'false' || v === 1 || v === 0 || v === '1' || v === '0';
    if (boolLike(expected) && boolLike(actual)) {
        const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
        return toBool(expected) === toBool(actual);
    }

    // Numeric values
    const expNum = Number(expected);
    const actNum = Number(actual);
    if (!Number.isNaN(expNum) && !Number.isNaN(actNum) && expected !== '' && actual !== '') {
        return expNum === actNum;
    }

    // Date-like strings ("yyyy-MM-dd HH:mm:ss" or ISO) - compare date-only portion
    const dateLike = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
    if (dateLike(expected) && dateLike(actual)) {
        const dateOnly = (v) => v.split('T')[0].split(' ')[0];
        return dateOnly(expected) === dateOnly(actual);
    }

    // Fallback: trimmed, case-insensitive string comparison
    return String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
}

test('TC 002 Bitsight token validation', async ({ page }) => {
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

test('TC 003 Bitsight import data validation', async ({ page }) => {
    test.setTimeout(1_800_000); // extended for full import + CM ground truth reconciliation

    // CM-only: force CM_TOKEN explicitly so this never falls back to
    // CMVRM_TOKEN / BITSIGHT_API_TOKEN, and never touches VRM endpoints.
    const cmToken = process.env.CM_TOKEN;
    expect(cmToken, 'CM_TOKEN must be set in the environment to run CM ground truth reconciliation').toBeTruthy();

    const bitsightClient = new BitsightApiClient({ token: cmToken });

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

    await page.waitForTimeout(3000);

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

    // Capture the actual completion timestamp (needed for the failed-portfolios
    // syslog lookup below) - re-reads the same newest entry just confirmed.
    const completionTimestamp = await getLatestImportCompleteLog(page);

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
        : `\n--- No changes this run (no-op sync) - validating an existing populated record instead (sys_id: ${record.sys_id ?? '(not fetched)'}) ---`
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

    // ---------- Step 6: fetch Bitsight ground truth (CM companies only, no VRM calls) ----------
    console.log('\n=== Step 6: Fetching Bitsight Ground Truth (CM Companies Only) ===');
    const rawCompanies = await bitsightClient.getCompanies();
    const groundTruthCompanies = bitsightClient.normalizeMergedPortfolio(rawCompanies);

    const portfolioMap = new Map();
    for (const item of groundTruthCompanies) {
        if (item.bitsight_vendor_guid) {
            portfolioMap.set(item.bitsight_vendor_guid, item);
        }
    }

    const totalCmCount = groundTruthCompanies.length;
    console.log(`Bitsight Ground Truth CM Company Count: ${totalCmCount}`);

    // ---------- Step 7: fetch full ServiceNow core_company GUIDs count (session token) ----------
    console.log('\n=== Step 7: Fetching ServiceNow core_company GUIDs Count ===');
    const snGuidsList = await getBitsightVendorGuids(page);
    const snTotalCount = snGuidsList.length;
    console.log(`ServiceNow core_company Bitsight record count: ${snTotalCount}`);

    // ---------- Step 8: extract failed portfolios count from syslog (session token) ----------
    console.log('\n=== Step 8: Extracting Failed Portfolios Count from syslog ===');
    const failedPortfoliosCount = await getFailedPortfoliosCount(page, {
        baselineTimestamp: baselineLogTimestamp,
        completionTimestamp,
    });
    console.log(`Failed Portfolios Count from syslog: ${failedPortfoliosCount}`);

    const expectedSnCount = totalCmCount - failedPortfoliosCount;
    console.log(`Calculation: CM Ground Truth (${totalCmCount}) - Failed (${failedPortfoliosCount}) = Expected (${expectedSnCount})`);

    console.log('\n================================================================');
    console.log('       TIER 1: CM-ONLY COMPLETENESS RECONCILIATION SUMMARY      ');
    console.log('================================================================');
    console.table({
        'Bitsight CM Total (companies)': totalCmCount,
        'Failed Portfolios (from syslog)': failedPortfoliosCount,
        'Expected ServiceNow Count (CM - Failed)': expectedSnCount,
        'Actual ServiceNow Count (core_company)': snTotalCount,
        'Difference': Math.abs(snTotalCount - expectedSnCount),
    });

    expect.soft(
        snTotalCount,
        `Expected ServiceNow core_company count (${snTotalCount}) to match CM Ground Truth minus failed portfolios (${totalCmCount} - ${failedPortfoliosCount} = ${expectedSnCount})`
    ).toBe(expectedSnCount);

    // ---------- Step 9: sample 15 random recently updated records (session token) ----------
    console.log('\n=== Step 9: Fetching 15 Random Recently Updated Records from ServiceNow ===');
    const sampleRecords = await getRandomRecentlyUpdatedCoreCompanies(page, 15, 50);
    expect(sampleRecords.length, 'Expected to retrieve sampled records from ServiceNow').toBeGreaterThan(0);

    // ---------- Step 10: field-by-field validation against CM ground truth ----------
    console.log('\n=== Step 10: Validating Sampled Records Field-by-Field against CM Ground Truth ===');
    const sampleFieldMismatches = [];
    const sampleValidationSummary = [];

    // CM-only fields. VRM-specific fields (impact_score, risk_score,
    // trust_score, due_date, vendor_guid, is_managed, life_cycle_stage_name)
    // are intentionally NOT checked in this test.
    const fieldsToCheck = [
        { key: 'name', snKey: 'x_bisit_vrm_company_name' },
        { key: 'primary_domain', snKey: 'x_bisit_vrm_primary_domain' },
        { key: 'rating', snKey: 'x_bisit_vrm_security_rating' },
        { key: 'rating_date', snKey: 'x_bisit_vrm_rating_date' },
        { key: 'u_is_vrm', snKey: 'x_bisit_vrm_is_vrm' },
    ];

    for (const actual of sampleRecords) {
        const guid = actual.x_bisit_vrm_bitsight_vendor_guid;
        const expected = portfolioMap.get(guid);

        if (!expected) {
            sampleFieldMismatches.push({
                vendorGuid: guid,
                companyName: actual.x_bisit_vrm_company_name,
                field: 'Record Existence in Ground Truth',
                expected: 'Present in Bitsight CM Companies',
                actual: 'Not Found in Bitsight CM Companies',
            });
            continue;
        }

        let recordMismatches = 0;

        for (const f of fieldsToCheck) {
            const expVal = expected[f.key] !== undefined ? expected[f.key] : expected[f.snKey];
            const actVal = actual[f.snKey];

            const matches = areValuesEqual(expVal, actVal);

            if (!matches) {
                recordMismatches++;
                sampleFieldMismatches.push({
                    vendorGuid: guid,
                    companyName: actual.x_bisit_vrm_company_name || expected.name,
                    field: f.snKey,
                    expected: expVal,
                    actual: actVal,
                });
            }
        }

        sampleValidationSummary.push({
            guid,
            name: actual.x_bisit_vrm_company_name || expected.name,
            is_vrm: false,
            fieldsChecked: fieldsToCheck.length,
            mismatches: recordMismatches,
            status: recordMismatches === 0 ? 'MATCH' : 'MISMATCH',
        });
    }

    console.log('\n================================================================');
    console.log('       TIER 2: 15-RECORD CM SAMPLE DEEP VALIDATION REPORT       ');
    console.log('================================================================');
    console.table(sampleValidationSummary);

    if (sampleFieldMismatches.length > 0) {
        console.log('\n--- SAMPLE FIELD MISMATCHES ---');
        console.table(sampleFieldMismatches);
    } else {
        console.log('\nAll 15 sampled records matched perfectly with CM Ground Truth.');
    }
    console.log('================================================================\n');

    expect.soft(
        sampleFieldMismatches.length,
        `Expected 0 field mismatches in 15-record CM sample, but found ${sampleFieldMismatches.length}. Mismatches: ${JSON.stringify(sampleFieldMismatches, null, 2)}`
    ).toBe(0);
});


test('TC 004 Bitsight Portfolio record - key sections visible', async ({ page }) => {
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

    // Wait for the portfolio list to actually render before trying to click into a record
    await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

    // Select whichever company is first in the list, rather than hardcoding a name —
    // the portfolio table content can vary between environments/runs.
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 003] Opening first Portfolio record: "${companyName}"`);

    await firstRecordLink.click();

    // Give the record page time to fully load before checking its contents.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Elements to verify on the opened Bitsight Portfolio record.
    // Each entry has a short label (for logging) and a function returning the locator.
    const checks = [
        { label: 'Tab: Bitsight Security Ratings', locator: () => frame.getByRole('tab', { name: 'Bitsight Security Ratings' }) },
        { label: 'Tab: Bitsight Portfolio Information', locator: () => frame.getByRole('tab', { name: 'Bitsight Portfolio Information' }) },
        { label: 'Tab: Profile', locator: () => frame.getByRole('tab', { name: 'Profile' }) },
        { label: 'Tab: Bitsight Assessment Report', locator: () => frame.getByRole('tab', { name: 'Bitsight Assessment Report' }) },

        { label: 'Current rating value', locator: () => frame.locator('#current-rating') },

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

    console.log(`\n--- Visibility check for Bitsight Portfolio record (${companyName}) ---`);

    for (const { label, locator } of checks) {
        const isVisible = await locator().isVisible({ timeout: 15_000 }).catch(() => false);
        console.log(isVisible ? ` ${label} is visible` : ` ${label} is NOT visible`);
        expect(isVisible, `Expected "${label}" to be visible on the Bitsight Portfolio record`).toBeTruthy();
    }

    // Additionally verify the current rating actually has a value, not just that
    // the element is present/visible, since visibility alone wouldn't catch an
    // empty/blank rating.
    const currentRatingValue = (await frame.locator('#current-rating').innerText()).trim();
    console.log(`[TC 004] Current rating value: "${currentRatingValue}"`);
    expect(currentRatingValue.length, 'Expected current rating to be populated with a value').toBeGreaterThan(0);
});

test('TC 005 Bitsight Portfolio record - Enable Vendor Access flow', async ({ page }) => {
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

    // Wait for the portfolio list to actually render before trying to click into a record
    await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

    // Select whichever company is first in the list, rather than hardcoding a name -
    // the portfolio table content can vary between environments/runs.
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 005] Opening first Portfolio record: "${companyName}"`);

    await firstRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Kick off the Enable Vendor Access flow
    const enableVendorAccessButton = frame.getByRole('button', { name: 'Enable Vendor Access' });
    await enableVendorAccessButton.waitFor({ state: 'visible', timeout: 30_000 });
    await enableVendorAccessButton.click();

    // //code for filling out the form 
    // await frame.getByRole('textbox', { name: 'Contact Email' }).click();
    // await frame.getByRole('textbox', { name: 'Contact Email' }).fill('abc@example.com');
    // await frame.getByRole('textbox', { name: 'Contact Name / Alias' }).click();
    // await frame.getByRole('textbox', { name: 'Contact Name / Alias' }).fill('abc');
    // await frame.getByRole('textbox', { name: 'Message for Accenture plc (' }).click();
    // await frame.getByRole('textbox', { name: 'Message for Accenture plc (' }).fill(' some message with text.');


    // Confirm the request in the resulting dialog
    const sendRequestButton = frame.getByRole('button', { name: 'Send Request' });
    await sendRequestButton.waitFor({ state: 'visible', timeout: 30_000 });
    await sendRequestButton.click();

    // Dismiss the confirmation dialog
    const closeButton = frame.getByRole('button', { name: 'Close', exact: true });
    await closeButton.waitFor({ state: 'visible', timeout: 30_000 });
    await closeButton.click();

    // Verify the dialog actually closed after clicking Close
    await expect(closeButton, 'Expected confirmation dialog to close after clicking Close').not.toBeVisible({ timeout: 15_000 });

    console.log(`[TC 005] Vendor Access request sent and dialog closed for "${companyName}"`);
});


test('TC 006 Bitsight Portfolio record - Switch Subscription updates subscription type', async ({ page }) => {
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

    // Wait for the portfolio list to actually render before trying to click into a record
    await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

    // Select whichever company is first in the list, rather than hardcoding a name -
    // the portfolio table content can vary between environments/runs.
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 006] Opening first Portfolio record: "${companyName}"`);

    await firstRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Capture the current subscription type value before switching, so we can
    // confirm it actually changed after the switch completes.
    const subscriptionTypeField = frame.getByRole('textbox', { name: 'Read only - cannot be' });
    await subscriptionTypeField.waitFor({ state: 'visible', timeout: 30_000 });
    const subscriptionTypeBefore = (await subscriptionTypeField.inputValue()).trim();
    console.log(`[TC 006] Subscription type before switch: "${subscriptionTypeBefore}"`);

    // Kick off the Switch Subscription flow
    const switchSubscriptionButton = frame.getByRole('button', { name: 'Switch Subscription' });
    await switchSubscriptionButton.waitFor({ state: 'visible', timeout: 30_000 });
    await switchSubscriptionButton.click();

    // Verify the confirmation prompt appears before confirming the switch
    const confirmationText = frame.getByText('You are about to move');
    await confirmationText.waitFor({ state: 'visible', timeout: 30_000 });
    expect(await confirmationText.isVisible(), 'Expected switch subscription confirmation prompt to be visible').toBeTruthy();

    // Confirm the switch. This triggers a page reload, so avoid reading the
    // field immediately - poll for it instead of trusting a single read.
    const confirmButton = frame.getByRole('button', { name: 'Confirm' });
    await confirmButton.waitFor({ state: 'visible', timeout: 30_000 });
    await confirmButton.click();

    // Wait out the reload itself before we start polling the field, so we are
    // not just reading the pre-reload DOM.
    await page.waitForLoadState('networkidle').catch(() => { });

    // Poll the subscription type field until its value differs from the
    // pre-switch value, rather than reading it once right after the reload.
    // This absorbs the delay between the reload completing and the field
    // actually reflecting the new subscription type.
    await expect(async () => {
        await subscriptionTypeField.waitFor({ state: 'visible', timeout: 5_000 });
        const currentValue = (await subscriptionTypeField.inputValue()).trim();
        expect(currentValue, `Expected subscription type to change after Switch Subscription, but it remained "${subscriptionTypeBefore}"`)
            .not.toBe(subscriptionTypeBefore);
    }).toPass({ timeout: 45_000, intervals: [1_000, 2_000, 3_000, 5_000] });

    const subscriptionTypeAfter = (await subscriptionTypeField.inputValue()).trim();
    console.log(`[TC 006] Subscription type changed: "${subscriptionTypeBefore}" -> "${subscriptionTypeAfter}"`);
});

test('TC 007 Bitsight Portfolio record - Manage Folders moves an available folder', async ({ page }) => {
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

    // Wait for the portfolio list to actually render before trying to click into a record
    await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

    // Select whichever company is first in the list, rather than hardcoding a name -
    // the portfolio table content can vary between environments/runs.
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 007] Opening first Portfolio record: "${companyName}"`);

    await firstRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Open the Manage Folders dialog
    const manageFoldersButton = frame.getByRole('button', { name: 'Manage Folders' });
    await manageFoldersButton.waitFor({ state: 'visible', timeout: 30_000 });
    await manageFoldersButton.click();

    const availableList = frame.getByLabel('Available');
    await availableList.waitFor({ state: 'visible', timeout: 30_000 });

    // Precondition check: only attempt a move if the Available list actually has entries
    const availableOptions = availableList.locator('option');
    const availableCount = await availableOptions.count();
    console.log(`[TC 007] Available folders count: ${availableCount}`);

    if (availableCount === 0) {
        // Nothing to move. Log whatever folders are already assigned,
        // close the dialog, and treat this as a pass rather than a failure.
        const currentFoldersList = frame.getByLabel('Current Folders');
        const currentFolders = await currentFoldersList.locator('option').allInnerTexts();
        console.log(`[TC 007] Available list is empty. Folders already in Current Folders: ${JSON.stringify(currentFolders)}`);

        const closeButton = frame.getByRole('button', { name: 'Close', exact: true });
        await closeButton.waitFor({ state: 'visible', timeout: 30_000 });
        await closeButton.click();

        console.log('[TC 007] No available folders to move. Dialog closed. Marking test as passed.');
        return;
    }

    // Pick whichever folder is first in the Available list, rather than hardcoding a value -
    // available folders can differ between environments/runs.
    const firstAvailableOption = availableOptions.first();
    const folderValue = await firstAvailableOption.getAttribute('value');
    const folderLabel = (await firstAvailableOption.innerText()).trim();
    console.log(`[TC 007] Moving folder: "${folderLabel}" (value: ${folderValue})`);

    await availableList.selectOption(folderValue);

    // Click the move-to-selected arrow control
    await frame.getByRole('link').filter({ hasText: /^$/ }).nth(1).click();

    // Confirm the move
    const confirmButton = frame.getByRole('button', { name: 'Confirm' });
    await confirmButton.waitFor({ state: 'visible', timeout: 30_000 });
    await confirmButton.click();

    // Give the dialog/page time to process the move before re-checking state
    await page.waitForLoadState('networkidle').catch(() => { });

    // Verify the moved folder no longer appears in the Available list
    await expect(async () => {
        const remainingValues = await availableList.locator('option').evaluateAll(
            (options) => options.map((option) => option.getAttribute('value'))
        );
        expect(
            remainingValues,
            `Expected folder "${folderLabel}" (value: ${folderValue}) to no longer be in the Available list after moving it`
        ).not.toContain(folderValue);
    }).toPass({ timeout: 30_000, intervals: [1_000, 2_000, 3_000] });

    console.log(`[TC 007] Folder "${folderLabel}" successfully moved out of Available`);
});

test('TC 008 Bitsight Portfolio record - Unsubscribe, re-lock website, and re-subscribe', async ({ page }) => {
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
        .getByLabel('Portfolio 1 of')
        .click();

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    // Wait for the portfolio list to actually render before trying to click into a record
    await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

    // Select whichever company is first in the list, rather than hardcoding a name -
    // the portfolio table content can vary between environments/runs.
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 008] Opening first Portfolio record: "${companyName}"`);

    await firstRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Sanity check: record starts out subscribed and showing a rating.
    // Reading the rating value dynamically instead of matching a hardcoded score,
    // since the actual rating can differ between companies/environments/runs.
    const currentRating = frame.locator('#current-rating');
    await currentRating.waitFor({ state: 'visible', timeout: 30_000 });
    const ratingBefore = (await currentRating.innerText()).trim();
    console.log(`[TC 008] Current rating for "${companyName}" before unsubscribing: "${ratingBefore}"`);
    expect(ratingBefore.length, 'Expected current rating to be populated while subscribed').toBeGreaterThan(0);

    // Unsubscribe
    const unsubscribeButton = frame.getByRole('button', { name: 'Unsubscribe' });
    await unsubscribeButton.waitFor({ state: 'visible', timeout: 30_000 });
    await unsubscribeButton.click();

    const unsubscribeConfirmationText = frame.getByText('Are you sure you want to');
    await unsubscribeConfirmationText.waitFor({ state: 'visible', timeout: 30_000 });
    expect(await unsubscribeConfirmationText.isVisible(), 'Expected unsubscribe confirmation prompt to be visible').toBeTruthy();

    const confirmButton = frame.getByRole('button', { name: 'Confirm' });
    await confirmButton.waitFor({ state: 'visible', timeout: 30_000 });
    await confirmButton.click();

    await page.waitForLoadState('networkidle').catch(() => { });

    // Verify the record now shows the unsubscribed state by confirming the
    // rating value has cleared out, rather than matching a hardcoded string.
    await expect(async () => {
        const ratingAfterUnsubscribe = (await currentRating.innerText()).trim();
        expect(
            ratingAfterUnsubscribe,
            `Expected current rating to be cleared after unsubscribing, but it still showed "${ratingAfterUnsubscribe}"`
        ).not.toBe(ratingBefore);
    }).toPass({ timeout: 30_000, intervals: [1_000, 2_000, 3_000] });
    console.log(`[TC 008] Confirmed record "${companyName}" is now unsubscribed (rating cleared)`);

    // Edit and re-lock the website
    const editWebsiteButton = frame.getByRole('button', { name: 'Edit Website' });
    await editWebsiteButton.waitFor({ state: 'visible', timeout: 30_000 });
    await editWebsiteButton.click();

    // NOTE: hardcoding a real domain here since Bitsight needs a resolvable
    // website to match a vendor against. Replace this if the fixed first
    // record in this environment is not Accenture.
    const websiteField = frame.getByRole('textbox', { name: 'Website' });
    await websiteField.waitFor({ state: 'visible', timeout: 30_000 });
    await websiteField.fill(process.env.WEBSITE);
    await websiteField.press('ControlOrMeta+a');
    await websiteField.fill(process.env.WEBSITE);

    const lockWebsiteButton = frame.getByRole('button', { name: 'Lock Website' });
    await lockWebsiteButton.waitFor({ state: 'visible', timeout: 30_000 });
    await lockWebsiteButton.click();

    // Save the form via right-click context menu, then wait for the page to
    // reload before proceeding to Subscribe.
    await frame.locator('div').nth(3).click({ button: 'right' });

    const saveMenuItem = frame.getByRole('menuitem', { name: 'Save' });
    await saveMenuItem.waitFor({ state: 'visible', timeout: 30_000 });
    await saveMenuItem.click();

    // The Save triggers a full page reload. Wait it out and re-establish a
    // stable anchor (the ratings tab) before touching Subscribe, same pattern
    // used earlier in this test after other reload-triggering actions.
    await page.waitForLoadState('networkidle').catch(() => { });
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });

    // Re-subscribe
    const subscribeButton = frame.getByRole('button', { name: 'Subscribe' });
    await subscribeButton.waitFor({ state: 'visible', timeout: 30_000 });
    await subscribeButton.click();

    const subscriptionDialog = frame.getByRole('dialog', { name: 'Bitsight Subscription Request' });
    await subscriptionDialog.waitFor({ state: 'visible', timeout: 30_000 });

    // Open the company selector dropdown, search for the company by name, and select it.
    // Using the dynamically captured companyName rather than a hardcoded string so
    // this stays correct regardless of which record ended up being first in the portfolio.
    const companySelectedDropdown = frame.locator('#company-selected');
    await companySelectedDropdown.waitFor({ state: 'visible', timeout: 30_000 });
    await companySelectedDropdown.click();

    const companySearchBox = frame.getByRole('textbox', { name: 'Search...' });
    await companySearchBox.waitFor({ state: 'visible', timeout: 30_000 });
    await companySearchBox.fill(companyName);

    const companySearchResult = frame.getByText(companyName, { exact: true });
    await companySearchResult.waitFor({ state: 'visible', timeout: 30_000 });
    await companySearchResult.click();

    const subscriptionTypeDropdown = frame.getByLabel('Subscription Type', { exact: true });
    await subscriptionTypeDropdown.waitFor({ state: 'visible', timeout: 30_000 });
    await subscriptionTypeDropdown.selectOption('continuous_monitoring');

    const submitSubscriptionButton = frame.getByRole('button', { name: 'Submit Subscription Request' });
    await submitSubscriptionButton.waitFor({ state: 'visible', timeout: 30_000 });
    await submitSubscriptionButton.click();

    const submittedConfirmationText = frame.getByText('Subscription request has been');
    await submittedConfirmationText.waitFor({ state: 'visible', timeout: 30_000 });
    expect(await submittedConfirmationText.isVisible(), 'Expected subscription request confirmation to be visible').toBeTruthy();

    const closeButton = frame.getByRole('button', { name: 'Close', exact: true });
    await closeButton.waitFor({ state: 'visible', timeout: 30_000 });
    await closeButton.click();

    await page.waitForLoadState('networkidle').catch(() => { });


    const subscriptionTypeField = frame.getByRole('textbox', { name: 'Read only - cannot be' });
    await subscriptionTypeField.waitFor({ state: 'visible', timeout: 30_000 });

    await expect(async () => {
        const currentSubscriptionType = (await subscriptionTypeField.inputValue()).trim();
        expect(currentSubscriptionType.length, 'Expected subscription type field to be populated after re-subscribing').toBeGreaterThan(0);
    }).toPass({ timeout: 30_000, intervals: [1_000, 2_000, 3_000] });

    const subscriptionTypeValue = (await subscriptionTypeField.inputValue()).trim();
    console.log(`[TC 008] Subscription type after re-subscribing: "${subscriptionTypeValue}"`);

    // Move to Portfolio Information to verify the subscription type and GUID were set
    const portfolioInfoTab = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
    await portfolioInfoTab.waitFor({ state: 'visible', timeout: 30_000 });
    await portfolioInfoTab.click();


    const guidField = frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight vendor GUID' });
    await guidField.waitFor({ state: 'visible', timeout: 30_000 });
    const guidValue = (await guidField.inputValue()).trim();
    console.log(`[TC 008] Bitsight vendor GUID after re-subscribing: "${guidValue}"`);
    expect(guidValue.length, 'Expected Bitsight vendor GUID to be populated after re-subscribing').toBeGreaterThan(0);
});

test('TC 009 Trigger import job and check portfolio information', async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto(BASE_URL);
    await page.getByRole('menuitem', { name: 'All' }).click();

    // Nudge the mouse to dismiss any overlay that pops up after this click
    await page.mouse.move(100, 100);
    await page.mouse.move(200, 200);

    let searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
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

    await frame.getByRole('button', { name: 'Execute Now' }).click();

    // ---------- Step 3: wait for a NEW completion log (strictly after baseline) ----------
    const importCompleted = await waitForNewImportLog(page, baselineLogTimestamp);
    expect(importCompleted, 'Expected a new "Bitsight Portfolios Import Complete" syslog entry after triggering the job').toBeTruthy();

    console.log('[TC 009] Import job completed. Proceeding to verify Portfolio Information fields on a record.');

    // ---------- Step 4: navigate to the Portfolio and open the first available record ----------
    await page.goto(BASE_URL);
    await page.getByRole('menuitem', { name: 'All' }).click();

    // Nudge the mouse to dismiss any overlay that pops up after this click
    await page.mouse.move(100, 100);
    await page.mouse.move(200, 200);

    searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox.click();
    await searchBox.fill('');
    await searchBox.fill('bitsight');

    await page
        .getByRole('listitem')
        .filter({ hasText: 'Bitsight Vendor Risk ManagementEdit ApplicationPortfolioEdit Module Rating and' })
        .getByLabel('Portfolio 1 of')
        .click();

    // Wait for the portfolio list to actually render before trying to click into a record
    await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

    // Select whichever company is first in the list, rather than hardcoding a name -
    // the portfolio table content can vary between environments/runs.
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 009] Opening first Portfolio record: "${companyName}"`);

    await firstRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 5: switch to the Bitsight Portfolio Information tab ----------
    const portfolioInfoTab = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
    await portfolioInfoTab.waitFor({ state: 'visible', timeout: 30_000 });
    await portfolioInfoTab.click();
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 6: verify the fields on this tab are populated ----------
    const fieldChecks = [
        { label: 'Bitsight vendor GUID', locator: () => frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight vendor GUID' }) },
        { label: 'Bitsight rating date', locator: () => frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight rating date' }) },
        { label: 'Bitsight primary domain', locator: () => frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight primary domain' }) },
        { label: 'Bitsight security rating', locator: () => frame.getByRole('textbox', { name: 'Bitsight security rating' }) },
        { label: 'Bitsight company name', locator: () => frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight company name' }) },
    ];

    console.log(`\n--- Portfolio Information field check for "${companyName}" ---`);

    for (const { label, locator } of fieldChecks) {
        const field = locator();
        await field.waitFor({ state: 'visible', timeout: 30_000 });
        const value = (await field.inputValue()).trim();
        console.log(value.length > 0 ? ` "${label}" is populated: "${value}"` : ` "${label}" is EMPTY`);
        expect(value.length, `Expected "${label}" to be populated on the Portfolio Information tab`).toBeGreaterThan(0);
    }

    // The Bitsight portal link is an anchor, not a textbox - check it separately
    const bitsightPortalLink = frame.getByRole('link', { name: 'https://service.bitsighttech.' });
    await bitsightPortalLink.waitFor({ state: 'visible', timeout: 30_000 });
    const isPortalLinkVisible = await bitsightPortalLink.isVisible();
    console.log(isPortalLinkVisible ? ' Bitsight portal link is visible' : ' Bitsight portal link is NOT visible');
    expect(isPortalLinkVisible, 'Expected the Bitsight portal link to be visible on the Portfolio Information tab').toBeTruthy();

    console.log(`[TC 009] All Portfolio Information fields verified for "${companyName}"`);
});


test('TC 010 Bitsight Portfolio record - Country field is present on Contact tab', async ({ page }) => {
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

    // Wait for the portfolio list to actually render before trying to click into a record
    await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

    // Select whichever company is first in the list, rather than hardcoding a name -
    // the portfolio table content can vary between environments/runs.
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 012] Opening first Portfolio record: "${companyName}"`);

    await firstRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Switch to the Contact tab
    const contactTab = frame.getByRole('tab', { name: 'Contact' });
    await contactTab.waitFor({ state: 'visible', timeout: 30_000 });
    await contactTab.click();
    await page.waitForLoadState('networkidle').catch(() => { });

    // Verify the Country field is present
    const countryField = frame.getByRole('textbox', { name: 'Country' });
    const isCountryFieldVisible = await countryField.isVisible({ timeout: 15_000 }).catch(() => false);

    console.log(isCountryFieldVisible
        ? `[TC 012] Country field is visible for "${companyName}"`
        : `[TC 012] Country field is NOT visible for "${companyName}"`);
    expect(isCountryFieldVisible, `Expected the Country field to be present on the Contact tab for "${companyName}"`).toBeTruthy();
});

test('TC 011 Bitsight Assessment Report - template, downloads, and filters', async ({ page }) => {
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
        .getByLabel('Portfolio 1 of')
        .click();

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    // Wait for the portfolio list to actually render before trying to click into a record
    await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

    // Select whichever company is first in the list, rather than hardcoding a name -
    // the portfolio table content can vary between environments/runs.
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 010] Opening first Portfolio record: "${companyName}"`);

    await firstRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Switch to the Bitsight Assessment Report tab
    const assessmentReportTab = frame.getByRole('tab', { name: 'Bitsight Assessment Report' });
    await assessmentReportTab.waitFor({ state: 'visible', timeout: 30_000 });
    await assessmentReportTab.click();
    await page.waitForLoadState('networkidle').catch(() => { });

    // frame (FrameLocator) doesn't expose evaluate() - get the underlying
    // real Frame object separately just for this one script injection.
    const gsftMainFrame = page.frame({ name: 'gsft_main' });
    await gsftMainFrame.evaluate(() => {
        const style = document.createElement('style');
        style.textContent = '* { scroll-behavior: auto !important; }';
        document.head.appendChild(style);
    });

    // ---------- Scroll/interaction helpers ----------
    async function scrollIntoViewNearest(locator) {
        await locator.evaluate((element) => {
            element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
    }

    async function clickWithoutOuterScroll(locator) {
        await scrollIntoViewNearest(locator);
        await locator.click({ force: true });
    }

    // The icon toggles the checkbox independently rather than "confirming"
    // it - clicking it right after check() just flips the checkbox back off
    // (confirmed via logging: afterCheck=true, afterIconClick=false on every
    // single item, no exceptions, across sections/flags/grades/risk vectors).
    // check() alone already achieves the correct state, so the icon click is
    // skipped entirely here.
    async function selectFilterOption(checkboxLocator, label) {
        const stateBefore = await checkboxLocator.isChecked().catch(() => null);

        if (stateBefore === true) {
            console.log(`[selectFilterOption] "${label}" already checked, skipping`);
            return;
        }

        await scrollIntoViewNearest(checkboxLocator);
        await checkboxLocator.check({ force: true });

        const finalState = await checkboxLocator.isChecked();
        console.log(`[selectFilterOption] "${label}": checked=${finalState}`);

        expect(finalState, `Expected "${label}" filter checkbox to be checked after selection`).toBeTruthy();
    }

    // Open one of these expandable multi-select dropdowns (Section, Flag,
    // Grades, Risk Vectors, Mapped all share the same toggle pattern) and
    // wait briefly for the panel to finish expanding/rendering before
    // interacting with anything inside it.
    async function openFilterDropdown(toggleLocator) {
        await clickWithoutOuterScroll(toggleLocator);
        await page.waitForTimeout(500);
    }

    // ---------- Select an assessment template dynamically ----------
    // Instead of hardcoding an option value (which is opaque on screen and
    // hard to grab via the locator picker since it closes the open dropdown),
    // read the <option> elements directly. This works because we're querying
    // the DOM, not interacting with an open/rendered dropdown.
    const templateDropdown = frame.locator('#assessment-templates');
    await templateDropdown.waitFor({ state: 'visible', timeout: 30_000 });

    const templateOptions = await templateDropdown.locator('option').evaluateAll((options) =>
        options.map((option) => ({ value: option.value, text: option.textContent.trim() }))
    );
    console.log(`[TC 010] Available assessment templates: ${JSON.stringify(templateOptions)}`);

    const chosenTemplate = templateOptions.find((option) => option.value !== '');
    expect(chosenTemplate, 'Expected at least one selectable assessment template option').toBeTruthy();
    console.log(`[TC 010] Selecting assessment template: "${chosenTemplate.text}" (value: ${chosenTemplate.value})`);

    await templateDropdown.selectOption(chosenTemplate.value);

    // ---------- View Assessment (loads the report inline) ----------
    const viewAssessmentButton = frame.getByRole('button', { name: 'View Assessment' });
    await viewAssessmentButton.waitFor({ state: 'visible', timeout: 30_000 });
    await viewAssessmentButton.click();

    // Give the report a moment to actually start rendering before polling
    // for its columns, rather than checking immediately on click.
    await page.waitForTimeout(5_000);

    const columnChecks = [
        { label: 'Section / Sub-Section column', locator: () => frame.getByText('SectionSub-Section') },
        { label: 'Question ID column', locator: () => frame.getByText('Question ID') },
        { label: 'Question column', locator: () => frame.getByText('Question', { exact: true }) },
        { label: 'Risk Vectors column', locator: () => frame.getByText('Risk Vectors', { exact: true }) },
        { label: 'Flag column', locator: () => frame.getByText('Flag', { exact: true }) },
    ];

    console.log(`\n--- Assessment Report column check for "${companyName}" ---`);
    for (const { label, locator } of columnChecks) {
        const isVisible = await locator().isVisible({ timeout: 30_000 }).catch(() => false);
        console.log(isVisible ? ` ${label} is visible` : ` ${label} is NOT visible`);
        expect(isVisible, `Expected "${label}" to be visible on the Assessment Report`).toBeTruthy();
    }

    console.log(`[TC 010] Assessment report loaded for "${companyName}". Proceeding to CSV download.`);

    // ---------- Download CSV (triggers an actual file download) ----------
    const csvDownloadPromise = page.waitForEvent('download');
    const downloadCsvButton = frame.locator('#download_csv_btn');
    await downloadCsvButton.waitFor({ state: 'visible', timeout: 30_000 });
    await downloadCsvButton.click();
    const csvDownload = await csvDownloadPromise;
    console.log(`[TC 010] CSV download suggested filename: "${csvDownload.suggestedFilename()}"`);
    expect(csvDownload.suggestedFilename().length, 'Expected Download CSV to trigger a named download').toBeGreaterThan(0);

    // ---------- Section filter: all 17 sections ----------
    await openFilterDropdown(frame.getByText('Section Clear'));
    await clickWithoutOuterScroll(frame.locator('.overSelect'));
    await page.waitForTimeout(500);

    const sectionNames = [
        'Risk Management',
        'Security Policy',
        'Organizational Security',
        'Asset and Information',
        'Human Resource Security',
        'Physical and Environmental',
        'Operations Management',
        'Access Control',
        'Application Security',
        'Incident Event and',
        'Business Resiliency',
        'Compliance',
        'End User Device Security',
        'Network Security',
        'Privacy',
        'Threat Management',
        'Server Security',
    ];

    for (const name of sectionNames) {
        await selectFilterOption(frame.getByRole('checkbox', { name }), name);
    }

    console.log('[TC 010] All 17 sections selected');

    // ---------- Flag filter: Flagged and Unflagged Questions ----------
    await openFilterDropdown(frame.getByText('FlagClear'));

    await selectFilterOption(frame.getByRole('checkbox', { name: 'Flagged Questions', exact: true }), 'Flagged Questions');
    await selectFilterOption(frame.getByRole('checkbox', { name: 'Unflagged Questions' }), 'Unflagged Questions');

    console.log('[TC 010] Flag filters selected');

    // ---------- Grades filter: A, B checked; C/D toggled through; F checked ----------
    await openFilterDropdown(frame.getByText('GradesClear'));

    await selectFilterOption(frame.getByRole('checkbox', { name: 'A', exact: true }), 'Grade A');
    await selectFilterOption(frame.getByRole('checkbox', { name: 'B', exact: true }), 'Grade B');

    // C and D icons toggled without a matching checkbox call ever recorded,
    // then F selected instead - kept as icon-only actions per the recording.
    await clickWithoutOuterScroll(frame.locator('#svg-grades-C').getByRole('img'));
    await clickWithoutOuterScroll(frame.locator('#svg-grades-D > svg > .checkmark-path'));
    await clickWithoutOuterScroll(frame.locator('#svg-grades-F').getByRole('img'));

    expect(await frame.getByRole('checkbox', { name: 'A', exact: true }).isChecked(), 'Expected Grade A to remain checked').toBeTruthy();
    expect(await frame.getByRole('checkbox', { name: 'B', exact: true }).isChecked(), 'Expected Grade B to remain checked').toBeTruthy();
    console.log('[TC 010] Grades filters selected');

    // ---------- Risk Vectors filter: full 19-item list ----------
    await openFilterDropdown(frame.getByText('Risk VectorsClear'));

        const riskVectorNames = [
        'Botnet Infections',
        'Spam Propagation',
        'Malware Servers',
        'Unsolicited Communications',
        'Potentially Exploited',
        'SPF',
        'DKIM',
        'SSL Certificates',
        'SSL Configurations',
        'Open Ports',
        'Web Application Security',
        'Critical Vulnerability',
        'Insecure Systems',
        'Server Software',
        'Desktop Software',
        'Mobile Software',
        'File Sharing',
        'Security Incidents',
    ];

    for (const name of riskVectorNames) {
        // "Critical Vulnerability" is a partial match against the real
        // accessible name "Critical Vulnerability Management" - exact match
        // would never find it and hang until timeout, so only this one entry
        // is looked up without exact: true.
        const useExactMatch = name !== 'Critical Vulnerability';
        await selectFilterOption(frame.getByRole('checkbox', { name, exact: useExactMatch }), name);
    }

    // DMARC and Web Application Headers: icon clicked with no paired
    // checkbox ever recorded for either - kept as icon-only actions.
    await clickWithoutOuterScroll(frame.locator('#svg-risk_vectors-DMARC > svg'));
    await clickWithoutOuterScroll(frame.locator('#svg-risk_vectors-DMARC > svg'));
    await clickWithoutOuterScroll(frame.locator('[id="svg-risk_vectors-Web Application Headers"] > svg > .checkmark-path'));

    console.log('[TC 010] Risk Vectors filters selected');

    // ---------- Mapped filter: Mapped and Unmapped Questions ----------
    await openFilterDropdown(frame.getByText('MappedClear'));

    await selectFilterOption(frame.getByRole('checkbox', { name: 'Mapped Questions', exact: true }), 'Mapped Questions');
    await selectFilterOption(frame.getByRole('checkbox', { name: 'Unmapped Questions' }), 'Unmapped Questions');

    console.log('[TC 010] Mapped filters selected');

    // ---------- Clear all filters and go back ----------
    const clearAllFiltersLink = frame.getByRole('link', { name: 'Clear all filters' });
    await clearAllFiltersLink.waitFor({ state: 'visible', timeout: 15_000 });
    await clickWithoutOuterScroll(clearAllFiltersLink);

    // Verify filters actually cleared before leaving the page
    expect(
        await frame.getByRole('checkbox', { name: 'Security Policy' }).isChecked(),
        'Expected Security Policy filter to be cleared'
    ).toBeFalsy();
    expect(
        await frame.getByRole('checkbox', { name: 'A', exact: true }).isChecked(),
        'Expected Grade A filter to be cleared'
    ).toBeFalsy();
    expect(
        await frame.getByRole('checkbox', { name: 'Mapped Questions', exact: true }).isChecked(),
        'Expected Mapped Questions filter to be cleared'
    ).toBeFalsy();

    console.log(`[TC 010] All filters cleared for "${companyName}"`);

    const backButton = frame.getByRole('button', { name: 'Back' });
    await backButton.waitFor({ state: 'visible', timeout: 30_000 });
    await backButton.click();
});



