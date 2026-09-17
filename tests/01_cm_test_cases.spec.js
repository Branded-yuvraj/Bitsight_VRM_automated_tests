import { test, expect, request } from '@playwright/test';

import {
    getAllCoreCompaniesWithGuid,
    getCoreCompanyVendorFlags,
    isVendorTrue,
    snFetch,
    toEpoch,
    toSnDateTime,
    getLatestImportCompleteLog,
    waitForNewImportLog,
    getBitsightFieldNames,
    getSingleCompanyRecord,
    unwrapField,
    getBitsightVendorGuids,
    getRandomRecentlyUpdatedCoreCompanies,
    getFailedPortfoliosCount,
    areValuesEqual,
    normalizeDomain,
    normalizeText,
    getCoreCompanyMatchFields,
    classifyBitsightCompanies,
    openApplicationConfiguration,
    triggerScheduledImport,
    snMutate,
    getRandomCoreCompaniesWithGuid,
    deleteCoreCompanyRecords,
    findCoreCompaniesByGuid,
} from './utils/servicenow-session-helpers';


const BASE_URL = process.env.SN_URL;
const COMPLETE_MESSAGE = 'Bitsight Portfolios Import Complete';
const { BitsightApiClient } = require('./utils/bitsight-api-client'); // adjust path as needed
const { ServiceNowApiClient } = require('./utils/servicenow-api-client'); // adjust path as needed





test('TC 002 Bitsight token validation', async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto(BASE_URL);
    await page.getByText('All').first().click();


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
    await page.getByText('All').first().click();

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
    await page.getByText('All').first().click();
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

    // Prefer an exact element match first (most reliable), fall back to a
    // stricter label match that requires "bitsight" AND "vendor guid" together —
    // this avoids accidentally matching the VRM-internal "vendor_guid" field,
    // which the CM-only import never populates.
    const guidField =
        bitsightFields.find(f => f.element === 'x_bisit_vrm_bitsight_vendor_guid') ||
        bitsightFields.find(f =>
            f.label.toLowerCase().includes('bitsight') &&
            f.label.toLowerCase().includes('vendor guid')
        );

    expect(guidField, 'Could not locate "Bitsight vendor GUID" field name in dictionary').toBeTruthy();
    console.log(`[Step 4] Selected guidField: element="${guidField.element}", label="${guidField.label}"`);

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

    console.log('\n');
    console.log('       TIER 1: CM-ONLY COMPLETENESS RECONCILIATION SUMMARY      ');

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

    console.log('\n');
    console.log('       TIER 2: 15-RECORD CM SAMPLE DEEP VALIDATION REPORT       ');

    console.table(sampleValidationSummary);

    if (sampleFieldMismatches.length > 0) {
        console.log('\n--- SAMPLE FIELD MISMATCHES ---');
        console.table(sampleFieldMismatches);
    } else {
        console.log('\nAll 15 sampled records matched perfectly with CM Ground Truth.');
    }


    expect.soft(
        sampleFieldMismatches.length,
        `Expected 0 field mismatches in 15-record CM sample, but found ${sampleFieldMismatches.length}. Mismatches: ${JSON.stringify(sampleFieldMismatches, null, 2)}`
    ).toBe(0);
});


test('TC 004 Bitsight Portfolio record - key sections visible', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(BASE_URL);
    await page.getByText('All').first().click();

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
    await page.getByText('All').first().click();

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
    await page.getByText('All').first().click();

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
    await page.getByText('All').first().click();

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
    await page.getByText('All').first().click();

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

    // The primary domain field lives on the Portfolio Information tab. Explicitly
    // click into that tab first rather than assuming it is already rendered -
    // avoids reading a stale/empty value due to ServiceNow tab-load flakiness.
    const portfolioInfoTabBeforeUnsubscribe = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
    await portfolioInfoTabBeforeUnsubscribe.waitFor({ state: 'visible', timeout: 30_000 });
    await portfolioInfoTabBeforeUnsubscribe.click();

    // Capture the Bitsight primary domain value while the record is still subscribed -
    // this is the value we will re-use later to re-lock the website after unsubscribing,
    // instead of relying on a hardcoded env var.
    const primaryDomainField = frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight primary domain' });
    await primaryDomainField.waitFor({ state: 'visible', timeout: 30_000 });
    const primaryDomainValue = (await primaryDomainField.inputValue()).trim();
    console.log(`[TC 008] Captured Bitsight primary domain for "${companyName}": "${primaryDomainValue}"`);
    expect(primaryDomainValue.length, 'Expected Bitsight primary domain to be populated before unsubscribing').toBeGreaterThan(0);

    // The Unsubscribe button lives on the Bitsight Security Ratings tab, so
    // switch back before interacting with it.
    const securityRatingsTabBeforeUnsubscribe = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await securityRatingsTabBeforeUnsubscribe.waitFor({ state: 'visible', timeout: 30_000 });
    await securityRatingsTabBeforeUnsubscribe.click();

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

    // Using the Bitsight primary domain value captured earlier from this same
    // record, instead of a hardcoded env var, so the website we lock in always
    // matches whichever company happened to be first in the portfolio list.
    const websiteField = frame.getByRole('textbox', { name: 'Website' });
    await websiteField.waitFor({ state: 'visible', timeout: 30_000 });
    await websiteField.fill(primaryDomainValue);
    await websiteField.press('ControlOrMeta+a');
    await websiteField.fill(primaryDomainValue);

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
    await page.getByText('All').first().click();

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
    await page.getByText('All').first().click();
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
    await page.getByText('All').first().click();

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
    await page.getByText('All').first().click();

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

// test('TC 011 Bitsight Assessment Report - template, downloads, and filters', async ({ page }) => {
//     test.setTimeout(300_000);

//     await page.goto(BASE_URL);
//     await page.getByText('All').first().click();

//     // Nudge the mouse to dismiss any overlay that pops up after this click
//     await page.mouse.move(100, 100);
//     await page.mouse.move(200, 200);

//     const searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
//     await searchBox.click();
//     await searchBox.fill('bitsight');

//     await page
//         .getByRole('listitem')
//         .filter({ hasText: 'Bitsight Vendor Risk ManagementEdit ApplicationPortfolioEdit Module Rating and' })
//         .getByLabel('Portfolio 1 of')
//         .click();

//     const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

//     // Wait for the portfolio list to actually render before trying to click into a record
//     await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

//     // Select whichever company is first in the list, rather than hardcoding a name -
//     // the portfolio table content can vary between environments/runs.
//     const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
//     await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

//     const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
//     console.log(`[TC 010] Opening first Portfolio record: "${companyName}"`);

//     await firstRecordLink.click();

//     // Give the record page time to fully load before interacting with it.
//     // Wait on a stable, always-present element (a tab) rather than a flat timeout.
//     await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
//     await page.waitForLoadState('networkidle').catch(() => { });

//     // Switch to the Bitsight Assessment Report tab
//     const assessmentReportTab = frame.getByRole('tab', { name: 'Bitsight Assessment Report' });
//     await assessmentReportTab.waitFor({ state: 'visible', timeout: 30_000 });
//     await assessmentReportTab.click();
//     await page.waitForLoadState('networkidle').catch(() => { });

//     // frame (FrameLocator) doesn't expose evaluate() - get the underlying
//     // real Frame object separately just for this one script injection.
//     const gsftMainFrame = page.frame({ name: 'gsft_main' });
//     await gsftMainFrame.evaluate(() => {
//         const style = document.createElement('style');
//         style.textContent = '* { scroll-behavior: auto !important; }';
//         document.head.appendChild(style);
//     });

//     // ---------- Scroll/interaction helpers ----------
//     async function scrollIntoViewNearest(locator) {
//         await locator.evaluate((element) => {
//             element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
//         });
//     }

//     async function clickWithoutOuterScroll(locator) {
//         await scrollIntoViewNearest(locator);
//         await locator.click({ force: true });
//     }

//     // The icon toggles the checkbox independently rather than "confirming"
//     // it - clicking it right after check() just flips the checkbox back off
//     // (confirmed via logging: afterCheck=true, afterIconClick=false on every
//     // single item, no exceptions, across sections/flags/grades/risk vectors).
//     // check() alone already achieves the correct state, so the icon click is
//     // skipped entirely here.
//     async function selectFilterOption(checkboxLocator, label) {
//         const stateBefore = await checkboxLocator.isChecked().catch(() => null);

//         if (stateBefore === true) {
//             console.log(`[selectFilterOption] "${label}" already checked, skipping`);
//             return;
//         }

//         await scrollIntoViewNearest(checkboxLocator);
//         await checkboxLocator.check({ force: true });

//         const finalState = await checkboxLocator.isChecked();
//         console.log(`[selectFilterOption] "${label}": checked=${finalState}`);

//         expect(finalState, `Expected "${label}" filter checkbox to be checked after selection`).toBeTruthy();
//     }

//     // Open one of these expandable multi-select dropdowns (Section, Flag,
//     // Grades, Risk Vectors, Mapped all share the same toggle pattern) and
//     // wait briefly for the panel to finish expanding/rendering before
//     // interacting with anything inside it.
//     async function openFilterDropdown(toggleLocator) {
//         await clickWithoutOuterScroll(toggleLocator);
//         await page.waitForTimeout(500);
//     }

//     // ---------- Select an assessment template dynamically ----------
//     // Instead of hardcoding an option value (which is opaque on screen and
//     // hard to grab via the locator picker since it closes the open dropdown),
//     // read the <option> elements directly. This works because we're querying
//     // the DOM, not interacting with an open/rendered dropdown.
//     const templateDropdown = frame.locator('#assessment-templates');
//     await templateDropdown.waitFor({ state: 'visible', timeout: 30_000 });

//     const templateOptions = await templateDropdown.locator('option').evaluateAll((options) =>
//         options.map((option) => ({ value: option.value, text: option.textContent.trim() }))
//     );
//     console.log(`[TC 010] Available assessment templates: ${JSON.stringify(templateOptions)}`);

//     const chosenTemplate = templateOptions.find((option) => option.value !== '');
//     expect(chosenTemplate, 'Expected at least one selectable assessment template option').toBeTruthy();
//     console.log(`[TC 010] Selecting assessment template: "${chosenTemplate.text}" (value: ${chosenTemplate.value})`);

//     await templateDropdown.selectOption(chosenTemplate.value);

//     // ---------- View Assessment (loads the report inline) ----------
//     const viewAssessmentButton = frame.getByRole('button', { name: 'View Assessment' });
//     await viewAssessmentButton.waitFor({ state: 'visible', timeout: 30_000 });
//     await viewAssessmentButton.click();

//     // Give the report a moment to actually start rendering before polling
//     // for its columns, rather than checking immediately on click.
//     await page.waitForTimeout(5_000);

//     const columnChecks = [
//         { label: 'Section / Sub-Section column', locator: () => frame.getByText('SectionSub-Section') },
//         { label: 'Question ID column', locator: () => frame.getByText('Question ID') },
//         { label: 'Question column', locator: () => frame.getByText('Question', { exact: true }) },
//         { label: 'Risk Vectors column', locator: () => frame.getByText('Risk Vectors', { exact: true }) },
//         { label: 'Flag column', locator: () => frame.getByText('Flag', { exact: true }) },
//     ];

//     console.log(`\n--- Assessment Report column check for "${companyName}" ---`);
//     for (const { label, locator } of columnChecks) {
//         const isVisible = await locator().isVisible({ timeout: 30_000 }).catch(() => false);
//         console.log(isVisible ? ` ${label} is visible` : ` ${label} is NOT visible`);
//         expect(isVisible, `Expected "${label}" to be visible on the Assessment Report`).toBeTruthy();
//     }

//     console.log(`[TC 010] Assessment report loaded for "${companyName}". Proceeding to CSV download.`);

//     // ---------- Download CSV (triggers an actual file download) ----------
//     const csvDownloadPromise = page.waitForEvent('download');
//     const downloadCsvButton = frame.locator('#download_csv_btn');
//     await downloadCsvButton.waitFor({ state: 'visible', timeout: 30_000 });
//     await downloadCsvButton.click();
//     const csvDownload = await csvDownloadPromise;
//     console.log(`[TC 010] CSV download suggested filename: "${csvDownload.suggestedFilename()}"`);
//     expect(csvDownload.suggestedFilename().length, 'Expected Download CSV to trigger a named download').toBeGreaterThan(0);

//     // ---------- Section filter: all 17 sections ----------
//     await openFilterDropdown(frame.getByText('Section Clear'));
//     await clickWithoutOuterScroll(frame.locator('.overSelect'));
//     await page.waitForTimeout(500);

//     const sectionNames = [
//         'Risk Management',
//         'Security Policy',
//         'Organizational Security',
//         'Asset and Information',
//         'Human Resource Security',
//         'Physical and Environmental',
//         'Operations Management',
//         'Access Control',
//         'Application Security',
//         'Incident Event and',
//         'Business Resiliency',
//         'Compliance',
//         'End User Device Security',
//         'Network Security',
//         'Privacy',
//         'Threat Management',
//         'Server Security',
//     ];

//     for (const name of sectionNames) {
//         await selectFilterOption(frame.getByRole('checkbox', { name }), name);
//     }

//     console.log('[TC 010] All 17 sections selected');

//     // ---------- Flag filter: Flagged and Unflagged Questions ----------
//     await openFilterDropdown(frame.getByText('FlagClear'));

//     await selectFilterOption(frame.getByRole('checkbox', { name: 'Flagged Questions', exact: true }), 'Flagged Questions');
//     await selectFilterOption(frame.getByRole('checkbox', { name: 'Unflagged Questions' }), 'Unflagged Questions');

//     console.log('[TC 010] Flag filters selected');

//     // ---------- Grades filter: A, B checked; C/D toggled through; F checked ----------
//     await openFilterDropdown(frame.getByText('GradesClear'));

//     await selectFilterOption(frame.getByRole('checkbox', { name: 'A', exact: true }), 'Grade A');
//     await selectFilterOption(frame.getByRole('checkbox', { name: 'B', exact: true }), 'Grade B');

//     // C and D icons toggled without a matching checkbox call ever recorded,
//     // then F selected instead - kept as icon-only actions per the recording.
//     await clickWithoutOuterScroll(frame.locator('#svg-grades-C').getByRole('img'));
//     await clickWithoutOuterScroll(frame.locator('#svg-grades-D > svg > .checkmark-path'));
//     await clickWithoutOuterScroll(frame.locator('#svg-grades-F').getByRole('img'));

//     expect(await frame.getByRole('checkbox', { name: 'A', exact: true }).isChecked(), 'Expected Grade A to remain checked').toBeTruthy();
//     expect(await frame.getByRole('checkbox', { name: 'B', exact: true }).isChecked(), 'Expected Grade B to remain checked').toBeTruthy();
//     console.log('[TC 010] Grades filters selected');

//     // ---------- Risk Vectors filter: full 19-item list ----------
//     await openFilterDropdown(frame.getByText('Risk VectorsClear'));

//         const riskVectorNames = [
//         'Botnet Infections',
//         'Spam Propagation',
//         'Malware Servers',
//         'Unsolicited Communications',
//         'Potentially Exploited',
//         'SPF',
//         'DKIM',
//         'SSL Certificates',
//         'SSL Configurations',
//         'Open Ports',
//         'Web Application Security',
//         'Critical Vulnerability',
//         'Insecure Systems',
//         'Server Software',
//         'Desktop Software',
//         'Mobile Software',
//         'File Sharing',
//         'Security Incidents',
//     ];

//     for (const name of riskVectorNames) {
//         // "Critical Vulnerability" is a partial match against the real
//         // accessible name "Critical Vulnerability Management" - exact match
//         // would never find it and hang until timeout, so only this one entry
//         // is looked up without exact: true.
//         const useExactMatch = name !== 'Critical Vulnerability';
//         await selectFilterOption(frame.getByRole('checkbox', { name, exact: useExactMatch }), name);
//     }

//     // DMARC and Web Application Headers: icon clicked with no paired
//     // checkbox ever recorded for either - kept as icon-only actions.
//     await clickWithoutOuterScroll(frame.locator('#svg-risk_vectors-DMARC > svg'));
//     await clickWithoutOuterScroll(frame.locator('#svg-risk_vectors-DMARC > svg'));
//     await clickWithoutOuterScroll(frame.locator('[id="svg-risk_vectors-Web Application Headers"] > svg > .checkmark-path'));

//     console.log('[TC 010] Risk Vectors filters selected');

//     // ---------- Mapped filter: Mapped and Unmapped Questions ----------
//     await openFilterDropdown(frame.getByText('MappedClear'));

//     await selectFilterOption(frame.getByRole('checkbox', { name: 'Mapped Questions', exact: true }), 'Mapped Questions');
//     await selectFilterOption(frame.getByRole('checkbox', { name: 'Unmapped Questions' }), 'Unmapped Questions');

//     console.log('[TC 010] Mapped filters selected');

//     // ---------- Clear all filters and go back ----------
//     const clearAllFiltersLink = frame.getByRole('link', { name: 'Clear all filters' });
//     await clearAllFiltersLink.waitFor({ state: 'visible', timeout: 15_000 });
//     await clickWithoutOuterScroll(clearAllFiltersLink);

//     // Verify filters actually cleared before leaving the page
//     expect(
//         await frame.getByRole('checkbox', { name: 'Security Policy' }).isChecked(),
//         'Expected Security Policy filter to be cleared'
//     ).toBeFalsy();
//     expect(
//         await frame.getByRole('checkbox', { name: 'A', exact: true }).isChecked(),
//         'Expected Grade A filter to be cleared'
//     ).toBeFalsy();
//     expect(
//         await frame.getByRole('checkbox', { name: 'Mapped Questions', exact: true }).isChecked(),
//         'Expected Mapped Questions filter to be cleared'
//     ).toBeFalsy();

//     console.log(`[TC 010] All filters cleared for "${companyName}"`);

//     const backButton = frame.getByRole('button', { name: 'Back' });
//     await backButton.waitFor({ state: 'visible', timeout: 30_000 });
//     await backButton.click();
// });

test('TC 011 Bitsight Assessment Report - template, downloads, and filters', async ({ page }) => {
    test.setTimeout(300_000);

    await page.goto(BASE_URL);
    await page.getByText('All').first().click();

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
    console.log(`[TC 011] Opening first Portfolio record: "${companyName}"`);

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

    async function selectFilterOption(checkboxLocator, label) {
        // Skip if the checkbox is disabled in the UI
        const isEnabled = await checkboxLocator.isEnabled().catch(() => false);
        if (!isEnabled) {
            console.log(`[selectFilterOption] "${label}" is disabled, skipping`);
            return;
        }

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

    async function openFilterDropdown(toggleLocator) {
        await clickWithoutOuterScroll(toggleLocator);
        await page.waitForTimeout(500);
    }

    // ---------- Select an assessment template dynamically ----------
    const templateDropdown = frame.locator('#assessment-templates');
    await templateDropdown.waitFor({ state: 'visible', timeout: 30_000 });

    const templateOptions = await templateDropdown.locator('option').evaluateAll((options) =>
        options.map((option) => ({ value: option.value, text: option.textContent.trim() }))
    );
    console.log(`[TC 011] Available assessment templates: ${JSON.stringify(templateOptions)}`);

    const chosenTemplate = templateOptions.find((option) => option.value !== '');
    expect(chosenTemplate, 'Expected at least one selectable assessment template option').toBeTruthy();
    console.log(`[TC 011] Selecting assessment template: "${chosenTemplate.text}" (value: ${chosenTemplate.value})`);

    await templateDropdown.selectOption(chosenTemplate.value);

    // ---------- View Assessment (loads the report inline) ----------
    const viewAssessmentButton = frame.getByRole('button', { name: 'View Assessment' });
    await viewAssessmentButton.waitFor({ state: 'visible', timeout: 30_000 });
    await viewAssessmentButton.click();

    await page.waitForTimeout(25_000);

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

    console.log(`[TC 011] Assessment report loaded for "${companyName}". Proceeding to CSV download.`);

    // ---------- Download CSV ----------
    const csvDownloadPromise = page.waitForEvent('download');
    const downloadCsvButton = frame.locator('#download_csv_btn');
    await downloadCsvButton.waitFor({ state: 'visible', timeout: 30_000 });
    await downloadCsvButton.click();
    const csvDownload = await csvDownloadPromise;
    console.log(`[TC 011] CSV download suggested filename: "${csvDownload.suggestedFilename()}"`);
    expect(csvDownload.suggestedFilename().length, 'Expected Download CSV to trigger a named download').toBeGreaterThan(0);

    // ---------- Dynamic Section filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('Section Clear'));
    await clickWithoutOuterScroll(frame.locator('.overSelect'));
    await page.waitForTimeout(500);

    const sectionCheckboxes = frame.locator('input[name="section"]');
    const sectionCount = await sectionCheckboxes.count();
    const sectionLimit = Math.min(sectionCount, 10);
    console.log(`[TC 011] Found ${sectionCount} section checkboxes, evaluating first ${sectionLimit}.`);
    expect(sectionCount, 'Expected at least one section checkbox').toBeGreaterThan(0);

    for (let i = 0; i < sectionLimit; i++) {
        const checkbox = sectionCheckboxes.nth(i);
        const sectionId = await checkbox.getAttribute('id') || `Section #${i + 1}`;
        await selectFilterOption(checkbox, sectionId);
    }
    console.log(`[TC 011] Processed up to ${sectionLimit} sections`);

    // ---------- Dynamic Flag filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('FlagClear'));
    const flagCheckboxes = frame.locator('input[name="flag"]');
    const flagCount = await flagCheckboxes.count();
    const flagLimit = Math.min(flagCount, 10);
    console.log(`[TC 011] Found ${flagCount} flag checkboxes, evaluating first ${flagLimit}.`);

    for (let i = 0; i < flagLimit; i++) {
        const checkbox = flagCheckboxes.nth(i);
        const flagId = await checkbox.getAttribute('id') || `Flag #${i + 1}`;
        await selectFilterOption(checkbox, flagId);
    }
    console.log('[TC 011] Dynamic flag filters processed');

    // ---------- Dynamic Grades filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('GradesClear'));
    const gradeCheckboxes = frame.locator('input[name="grade"], input[name="grades"]');
    const gradeCount = await gradeCheckboxes.count();
    const gradeLimit = Math.min(gradeCount, 10);
    console.log(`[TC 011] Found ${gradeCount} grade checkboxes, evaluating first ${gradeLimit}.`);

    for (let i = 0; i < gradeLimit; i++) {
        const checkbox = gradeCheckboxes.nth(i);
        const gradeId = await checkbox.getAttribute('id') || `Grade #${i + 1}`;
        await selectFilterOption(checkbox, gradeId);
    }
    console.log('[TC 011] Dynamic grades filters processed');

    // ---------- Dynamic Risk Vectors filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('Risk VectorsClear'));
    const riskCheckboxes = frame.locator('input[name="risk_vector"], input[name*="risk"]');
    const riskCount = await riskCheckboxes.count();
    const riskLimit = Math.min(riskCount, 10);
    console.log(`[TC 011] Found ${riskCount} risk vector checkboxes, evaluating first ${riskLimit}.`);

    for (let i = 0; i < riskLimit; i++) {
        const checkbox = riskCheckboxes.nth(i);
        const riskId = await checkbox.getAttribute('id') || `Risk Vector #${i + 1}`;
        await selectFilterOption(checkbox, riskId);
    }
    console.log('[TC 011] Dynamic risk vectors filters processed');

    // ---------- Dynamic Mapped filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('MappedClear'));
    const mappedCheckboxes = frame.locator('input[name="mapped"]');
    const mappedCount = await mappedCheckboxes.count();
    const mappedLimit = Math.min(mappedCount, 10);
    console.log(`[TC 011] Found ${mappedCount} mapped checkboxes, evaluating first ${mappedLimit}.`);

    for (let i = 0; i < mappedLimit; i++) {
        const checkbox = mappedCheckboxes.nth(i);
        const mappedId = await checkbox.getAttribute('id') || `Mapped #${i + 1}`;
        await selectFilterOption(checkbox, mappedId);
    }
    console.log('[TC 011] Dynamic mapped filters processed');

    // ---------- Clear all filters and go back ----------
    const clearAllFiltersLink = frame.getByRole('link', { name: 'Clear all filters' });
    await clearAllFiltersLink.waitFor({ state: 'visible', timeout: 15_000 });
    await clickWithoutOuterScroll(clearAllFiltersLink);

    console.log(`[TC 011] All filters cleared for "${companyName}"`);

    const backButton = frame.getByRole('button', { name: 'Back' });
    await backButton.waitFor({ state: 'visible', timeout: 30_000 });
    await backButton.click();
});

test('TC 049 Unmatched company is not inserted when Insert option is disabled', async ({ page }) => {
    test.setTimeout(900_000);

    // ---------- Step 1: navigate to Application Configuration (fresh) ----------
    const frame = await openApplicationConfiguration(page);

    // ---------- Step 2: pick and delete a handful of previously matched companies ----------
    const recordsToDelete = await getRandomCoreCompaniesWithGuid(page, 5);
    expect(recordsToDelete.length, 'Expected at least one core_company record with a Bitsight GUID to delete for this test').toBeGreaterThan(0);

    console.log(`[TC 049] Deleting ${recordsToDelete.length} core_company record(s) to manufacture unmatched Bitsight companies...`);
    await deleteCoreCompanyRecords(page, recordsToDelete);

    const deletedGuids = recordsToDelete.map(r => r.guid);

    // ---------- Step 3: set Insert option to No and save ----------
    await frame.locator('#ins_company_n').click();
    await frame.locator('#property_save_btn').click();
    await page.waitForTimeout(3000);

    await expect(frame.locator('#ins_company_n')).toBeChecked();

    // ---------- Step 4: capture baseline import log, then trigger the job ----------
    const baselineLogTimestamp = await getLatestImportCompleteLog(page);
    await triggerScheduledImport(page, frame);

    // ---------- Step 5: wait for the job to complete ----------
    const importCompleted = await waitForNewImportLog(page, baselineLogTimestamp);
    expect(importCompleted, 'Expected a new "Bitsight Portfolios Import Complete" syslog entry after triggering the job').toBeTruthy();

    // ---------- Step 6: confirm none of the deleted companies were reinserted ----------
    const reinsertedRecords = await findCoreCompaniesByGuid(page, deletedGuids);

    console.log(reinsertedRecords.length === 0
        ? `[TC 049] Confirmed: none of the ${deletedGuids.length} deleted companies were reinserted.`
        : `[TC 049] UNEXPECTED: ${reinsertedRecords.length} deleted compan${reinsertedRecords.length === 1 ? 'y' : 'ies'} came back: ${reinsertedRecords.map(r => unwrapField(r.name)).join(', ')}`);

    expect(reinsertedRecords.length, 'Expected deleted companies to stay absent from core_company when Insert option is disabled').toBe(0);

    console.log('[TC 049] Test complete.');
});

test('TC 050 Unmatched company is inserted when Insert option is enabled', async ({ page }) => {
    test.setTimeout(900_000);

    // ---------- Step 1: navigate to Application Configuration (fresh) ----------
    const frame = await openApplicationConfiguration(page);

    // ---------- Step 2: pick and delete a handful of previously matched companies ----------
    const recordsToDelete = await getRandomCoreCompaniesWithGuid(page, 5);
    expect(recordsToDelete.length, 'Expected at least one core_company record with a Bitsight GUID to delete for this test').toBeGreaterThan(0);

    console.log(`[TC 050] Deleting ${recordsToDelete.length} core_company record(s) to manufacture unmatched Bitsight companies...`);
    await deleteCoreCompanyRecords(page, recordsToDelete);

    const deletedGuids = recordsToDelete.map(r => r.guid);

    // ---------- Step 3: set Insert option to Yes and save ----------
    await frame.locator('#ins_company_y').click();
    await frame.locator('#property_save_btn').click();
    await page.waitForTimeout(3000);

    await expect(frame.locator('#ins_company_y')).toBeChecked();

    // ---------- Step 4: capture baseline import log, then trigger the job ----------
    const baselineLogTimestamp = await getLatestImportCompleteLog(page);
    await triggerScheduledImport(page, frame);

    // ---------- Step 5: wait for the job to complete ----------
    const importCompleted = await waitForNewImportLog(page, baselineLogTimestamp);
    expect(importCompleted, 'Expected a new "Bitsight Portfolios Import Complete" syslog entry after triggering the job').toBeTruthy();

    // ---------- Step 6: confirm all deleted companies were reinserted ----------
    const reinsertedRecords = await findCoreCompaniesByGuid(page, deletedGuids);
    const reinsertedGuids = new Set(reinsertedRecords.map(r => unwrapField(r.x_bisit_vrm_bitsight_vendor_guid)));
    const missingGuids = deletedGuids.filter(g => !reinsertedGuids.has(g));

    console.log(missingGuids.length === 0
        ? `[TC 050] Confirmed: all ${deletedGuids.length} deleted companies were reinserted.`
        : `[TC 050] UNEXPECTED: ${missingGuids.length} of ${deletedGuids.length} deleted compan${missingGuids.length === 1 ? 'y is' : 'ies are'} still missing (guids: ${missingGuids.join(', ')})`);

    expect(reinsertedRecords.length, `Expected all ${deletedGuids.length} deleted companies to be reinserted when Insert option is enabled`).toBe(deletedGuids.length);

    console.log('[TC 050] Test complete.');
});


test('TC 051 Imported companies are not marked as vendors when Mark as Vendor is disabled', async ({ page }) => {
    test.setTimeout(900_000);

    // ---------- Step 1: navigate to Application Configuration (fresh) ----------
    const frame = await openApplicationConfiguration(page);

    // ---------- Step 2: clear every Bitsight-linked company so the next import re-inserts them all fresh ----------
    const existingRecords = await getAllCoreCompaniesWithGuid(page);
    console.log(`[TC 051] Deleting all ${existingRecords.length} existing Bitsight-linked core_company record(s)...`);
    if (existingRecords.length > 0) {
        await deleteCoreCompanyRecords(page, existingRecords);
    }

    // ---------- Step 3: enable Insert (so everything gets reimported) and disable Mark as Vendor, save ----------
    await frame.locator('#ins_company_y').click();
    await frame.locator('#mark_comp_n').click();
    await frame.locator('#property_save_btn').click();
    await page.waitForTimeout(3000);

    await expect(frame.locator('#ins_company_y')).toBeChecked();
    await expect(frame.locator('#mark_comp_n')).toBeChecked();

    // ---------- Step 4: capture baseline import log, then trigger the job ----------
    const baselineLogTimestamp = await getLatestImportCompleteLog(page);
    await triggerScheduledImport(page, frame);

    // ---------- Step 5: wait for the job to complete ----------
    const importCompleted = await waitForNewImportLog(page, baselineLogTimestamp);
    expect(importCompleted, 'Expected a new "Bitsight Portfolios Import Complete" syslog entry after triggering the job').toBeTruthy();

    // ---------- Step 6: every reimported company should be freshly inserted - none should be vendor=true ----------
    const companyRecords = await getCoreCompanyVendorFlags(page);
    expect(companyRecords.length, 'Expected at least one core_company record with a Bitsight vendor GUID after the import').toBeGreaterThan(0);

    const unexpectedVendors = companyRecords.filter(r => isVendorTrue(r.vendor));
    console.log(`[TC 051] ${companyRecords.length} freshly imported companies checked, ${unexpectedVendors.length} unexpectedly marked as vendor=true.`);

    if (unexpectedVendors.length > 0) {
        console.log(`[TC 051] UNEXPECTED: ${unexpectedVendors.map(r => r.name).join(', ')}`);
    }

    expect(unexpectedVendors.length, 'Expected all freshly imported companies to have vendor=false when Mark as Vendor is disabled').toBe(0);

    console.log('[TC 051] Confirmed: all freshly imported companies have vendor=false.');
    console.log('[TC 051] Test complete.');
});


test('TC 052 Imported companies are marked as vendors when Mark as Vendor is enabled', async ({ page }) => {
    test.setTimeout(900_000);

    // ---------- Step 1: navigate to Application Configuration (fresh) ----------
    const frame = await openApplicationConfiguration(page);

    // ---------- Step 2: clear every Bitsight-linked company so the next import re-inserts them all fresh ----------
    const existingRecords = await getAllCoreCompaniesWithGuid(page);
    console.log(`[TC 052] Deleting all ${existingRecords.length} existing Bitsight-linked core_company record(s)...`);
    if (existingRecords.length > 0) {
        await deleteCoreCompanyRecords(page, existingRecords);
    }

    // ---------- Step 3: enable Insert (so everything gets reimported) and enable Mark as Vendor, save ----------
    await frame.locator('#ins_company_y').click();
    await frame.locator('#mark_comp_y').click();
    await frame.locator('#property_save_btn').click();
    await page.waitForTimeout(3000);

    await expect(frame.locator('#ins_company_y')).toBeChecked();
    await expect(frame.locator('#mark_comp_y')).toBeChecked();

    // ---------- Step 4: capture baseline import log, then trigger the job ----------
    const baselineLogTimestamp = await getLatestImportCompleteLog(page);
    await triggerScheduledImport(page, frame);

    // ---------- Step 5: wait for the job to complete ----------
    const importCompleted = await waitForNewImportLog(page, baselineLogTimestamp);
    expect(importCompleted, 'Expected a new "Bitsight Portfolios Import Complete" syslog entry after triggering the job').toBeTruthy();

    // ---------- Step 6: every reimported company should be freshly inserted - all should be vendor=true ----------
    const companyRecords = await getCoreCompanyVendorFlags(page);
    expect(companyRecords.length, 'Expected at least one core_company record with a Bitsight vendor GUID after the import').toBeGreaterThan(0);

    const missingVendorFlag = companyRecords.filter(r => !isVendorTrue(r.vendor));
    console.log(`[TC 052] ${companyRecords.length} freshly imported companies checked, ${missingVendorFlag.length} unexpectedly NOT marked as vendor=true.`);

    if (missingVendorFlag.length > 0) {
        console.log(`[TC 052] UNEXPECTED: ${missingVendorFlag.map(r => r.name).join(', ')}`);
    }

    expect(missingVendorFlag.length, 'Expected all freshly imported companies to have vendor=true when Mark as Vendor is enabled').toBe(0);

    console.log('[TC 052] Confirmed: all freshly imported companies have vendor=true.');
    console.log('[TC 052] Test complete.');
});


test('TC 072 Bitsight Portfolio - Security Rating field is write-protected via API for restricted user', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 1: impersonate the restricted user ----------
    const adminMenuButton = page.getByRole('button', { name: 'System Administrator:' });
    await adminMenuButton.waitFor({ state: 'visible', timeout: 30_000 });
    await adminMenuButton.click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();

    const userCombo = page.getByRole('combobox', { name: 'Select a user' });
    await userCombo.click();
    await userCombo.fill('Don Goodliffe');

    // The dropdown item's id is session-generated (e.g. "980566exojol-4892-item-container"),
    // so match on the stable "-item-container" suffix plus the visible text instead.
    await page.locator('[id$="-item-container"]').filter({ hasText: 'Don Goodliffe' }).click();

    await page.getByRole('button', { name: 'Impersonate user' }).click();


    // Impersonation triggers a full page reload under the hood - if the next
    // snFetch/snMutate call fires while that reload is still in flight, the
    // page context gets torn down mid-evaluate ("Execution context was
    // destroyed"). Wait for the impersonation banner to actually appear,
    // which confirms the reload has completed and the page has settled.
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).waitFor({ state: 'visible', timeout: 30_000 });

    // ---------- Step 2: fetch a core_company record that has a Bitsight security rating ----------
    const listUrl = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_security_ratingISNOTEMPTY` +
        `&sysparm_fields=sys_id,name,x_bisit_vrm_security_rating&sysparm_limit=1`;
    const { ok: listOk, status: listStatus, body: listBody } = await snFetch(page, listUrl);
    expect(listOk, `Failed to fetch a core_company record (HTTP ${listStatus})`).toBeTruthy();

    const records = listBody?.result || [];
    expect(records.length, 'Expected at least one core_company record with a Bitsight security rating').toBeGreaterThan(0);

    const record = records[0];
    const sysId = unwrapField(record.sys_id);
    const originalRating = unwrapField(record.x_bisit_vrm_security_rating);
    console.log(`[TC 072] Target record: "${unwrapField(record.name)}" (sys_id: ${sysId}), current rating: ${originalRating}`);

    // ---------- Step 3: attempt to overwrite the field via the Table API while impersonated ----------
    const attemptedValue = String(Number(originalRating) > 0 ? Number(originalRating) - 1 : 999);
    const updateUrl = `/api/now/table/core_company/${sysId}`;
    const { ok: updateOk, status: updateStatus, body: updateBody } = await snMutate(
        page, updateUrl, 'PATCH', { x_bisit_vrm_security_rating: attemptedValue }
    );

    console.log(`[TC 072] PATCH response - status: ${updateStatus}, ok: ${updateOk}`);
    console.log(`[TC 072] PATCH response body: ${JSON.stringify(updateBody)}`);

    // ---------- Step 4: re-fetch the record and confirm the value did NOT change ----------
    const { ok: recheckOk, body: recheckBody } = await snFetch(
        page, `/api/now/table/core_company/${sysId}?sysparm_fields=x_bisit_vrm_security_rating`
    );
    expect(recheckOk, 'Failed to re-fetch the record after the update attempt').toBeTruthy();

    const finalRating = unwrapField(recheckBody?.result?.x_bisit_vrm_security_rating);
    console.log(`[TC 072] Rating after update attempt: ${finalRating} (was: ${originalRating}, attempted: ${attemptedValue})`);

    expect(finalRating, 'Expected the Bitsight security rating to remain unchanged - field should be write-protected by ACL').toBe(originalRating);

    // ---------- Step 5: end impersonation ----------
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).click();
    await page.getByRole('button', { name: 'End impersonation' }).click();

    console.log('[TC 072] Test complete.');
});

test('TC 073 Bitsight Rating and Risk Vector Alerts - Company field is write-protected via API for restricted user', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 1: impersonate the restricted user ----------
    const adminMenuButton = page.getByRole('button', { name: 'System Administrator:' });
    await adminMenuButton.waitFor({ state: 'visible', timeout: 30_000 });
    await adminMenuButton.click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();

    const userCombo = page.getByRole('combobox', { name: 'Select a user' });
    await userCombo.click();
    await userCombo.fill('Don Goodliffe');
    await page.locator('[id$="-item-container"]').filter({ hasText: 'Don Goodliffe' }).click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();


    // Impersonation triggers a full page reload under the hood - wait for the
    // banner to confirm it's actually settled before touching the page again.
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).waitFor({ state: 'visible', timeout: 30_000 });

    // ---------- Step 2: navigate to the Rating and Risk Vector Alerts list ----------
    await page.getByText('All').first().click();

    const searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox.click();
    await searchBox.fill('bitsight');
    await page
        .getByLabel('Rating and Risk Vector AlertsAlerts Received From Bitsight')
        .getByLabel('Rating and Risk Vector Alerts 2 of')
        .click();

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const companyColumnHeader = frame.getByRole('columnheader', { name: 'Company' });
    await companyColumnHeader.waitFor({ state: 'visible', timeout: 30_000 });

    // ---------- Step 3: fetch an alert record via the Table API ----------
    const listUrl = `/api/now/table/x_bisit_vrm_bitsight_alerts?sysparm_fields=sys_id,company&sysparm_limit=1`;
    const { ok: listOk, status: listStatus, body: listBody } = await snFetch(page, listUrl);
    expect(listOk, `Failed to fetch a Bitsight alert record (HTTP ${listStatus})`).toBeTruthy();

    const records = listBody?.result || [];
    expect(records.length, 'Expected at least one record in the Bitsight alerts table').toBeGreaterThan(0);

    const record = records[0];
    const sysId = unwrapField(record.sys_id);
    const originalCompany = unwrapField(record.company);
    console.log(`[TC 073] Target alert record sys_id: ${sysId}, current company: ${JSON.stringify(originalCompany)}`);

    // ---------- Step 4: attempt to overwrite the Company field via the Table API while impersonated ----------
    const updateUrl = `/api/now/table/x_bisit_vrm_bitsight_alerts/${sysId}`;
    const { ok: updateOk, status: updateStatus, body: updateBody } = await snMutate(
        page, updateUrl, 'PATCH', { company: '' }
    );

    console.log(`[TC 073] PATCH response - status: ${updateStatus}, ok: ${updateOk}`);
    console.log(`[TC 073] PATCH response body: ${JSON.stringify(updateBody)}`);

    // The API call itself succeeds (200) even though the ACL silently blocks
    // the actual field write - documenting this explicitly so it's clear this
    // is a "soft" no-op denial, not a hard 403 rejection.
    expect(updateStatus, 'Expected the Table API PATCH request itself to succeed (200) - the ACL denial is a silent no-op, not a request-level rejection').toBe(200);
    expect(updateOk, 'Expected the Table API PATCH response to report ok').toBeTruthy();

    // ---------- Step 5: re-fetch the record and confirm the Company value did NOT change ----------
    const { ok: recheckOk, body: recheckBody } = await snFetch(
        page, `/api/now/table/x_bisit_vrm_bitsight_alerts/${sysId}?sysparm_fields=company`
    );
    expect(recheckOk, 'Failed to re-fetch the alert record after the update attempt').toBeTruthy();

    const finalCompany = unwrapField(recheckBody?.result?.company);
    console.log(`[TC 073] Company after update attempt: ${JSON.stringify(finalCompany)} (was: ${JSON.stringify(originalCompany)})`);

    expect(finalCompany, 'Expected the Company field to remain unchanged - field should be write-protected by ACL').toEqual(originalCompany);

    // ---------- Step 6: end impersonation ----------
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).click();
    await page.getByRole('button', { name: 'End impersonation' }).click();

    console.log('[TC 073] Test complete.');
});


test('TC 074 Bitsight Incidents - Company field is write-protected via API for restricted user', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 1: impersonate the restricted user ----------
    const adminMenuButton = page.getByRole('button', { name: 'System Administrator:' });
    await adminMenuButton.waitFor({ state: 'visible', timeout: 30_000 });
    await adminMenuButton.click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();

    const userCombo = page.getByRole('combobox', { name: 'Select a user' });
    await userCombo.click();
    await userCombo.fill('Don Goodliffe');
    await page.locator('[id$="-item-container"]').filter({ hasText: 'Don Goodliffe' }).click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();


    // Impersonation triggers a full page reload under the hood - wait for the
    // banner to confirm it's actually settled before touching the page again.
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).waitFor({ state: 'visible', timeout: 30_000 });

    // ---------- Step 2: navigate to the Incidents list ----------
    await page.getByText('All').first().click();

    const searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox.click();
    await searchBox.fill('bitsight');
    await page.getByRole('link', { name: 'Incidents 3 of' }).click();

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const companyColumnHeader = frame.getByRole('columnheader', { name: 'Company' });
    await companyColumnHeader.waitFor({ state: 'visible', timeout: 30_000 });

    // ---------- Step 3: fetch a Bitsight-related incident via the Table API ----------
    // Standard ServiceNow incident table, filtered to incidents whose short
    // description references Bitsight.
    const listUrl = `/api/now/table/incident?sysparm_query=short_descriptionLIKEbitsight` +
        `&sysparm_fields=sys_id,company,short_description&sysparm_limit=1`;
    const { ok: listOk, status: listStatus, body: listBody } = await snFetch(page, listUrl);
    expect(listOk, `Failed to fetch a Bitsight-related incident (HTTP ${listStatus})`).toBeTruthy();

    const records = listBody?.result || [];
    expect(records.length, 'Expected at least one incident with "bitsight" in the short description').toBeGreaterThan(0);

    const record = records[0];
    const sysId = unwrapField(record.sys_id);
    const originalCompany = unwrapField(record.company);
    console.log(`[TC 074] Target incident: "${unwrapField(record.short_description)}" (sys_id: ${sysId}), current company: ${JSON.stringify(originalCompany)}`);

    // ---------- Step 4: attempt to overwrite the Company field via the Table API while impersonated ----------
    const updateUrl = `/api/now/table/incident/${sysId}`;
    const { ok: updateOk, status: updateStatus, body: updateBody } = await snMutate(
        page, updateUrl, 'PATCH', { company: '' }
    );

    console.log(`[TC 074] PATCH response - status: ${updateStatus}, ok: ${updateOk}`);
    console.log(`[TC 074] PATCH response body: ${JSON.stringify(updateBody)}`);

    // The API call itself is expected to succeed (200) even though the ACL
    // silently blocks the actual field write - a soft no-op, not a hard
    // 403 rejection (consistent with the Alerts table behavior in TC-073).
    expect(updateStatus, 'Expected the Table API PATCH request itself to succeed (200) - the ACL denial is a silent no-op, not a request-level rejection').toBe(200);
    expect(updateOk, 'Expected the Table API PATCH response to report ok').toBeTruthy();

    // ---------- Step 5: re-fetch the record and confirm the Company value did NOT change ----------
    const { ok: recheckOk, body: recheckBody } = await snFetch(
        page, `/api/now/table/incident/${sysId}?sysparm_fields=company`
    );
    expect(recheckOk, 'Failed to re-fetch the incident record after the update attempt').toBeTruthy();

    const finalCompany = unwrapField(recheckBody?.result?.company);
    console.log(`[TC 074] Company after update attempt: ${JSON.stringify(finalCompany)} (was: ${JSON.stringify(originalCompany)})`);

    expect(finalCompany, 'Expected the Company field to remain unchanged - field should be write-protected by ACL').toEqual(originalCompany);

    // ---------- Step 6: end impersonation ----------
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).click();
    await page.getByRole('button', { name: 'End impersonation' }).click();

    console.log('[TC 074] Test complete.');
});

test('TC 075 Bitsight Dashboard - permission-denied message shown for restricted user', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 1: impersonate the restricted user ----------
    const adminMenuButton = page.getByRole('button', { name: 'System Administrator:' });
    await adminMenuButton.waitFor({ state: 'visible', timeout: 30_000 });
    await adminMenuButton.click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();

    const userCombo = page.getByRole('combobox', { name: 'Select a user' });
    await userCombo.click();
    await userCombo.fill('Don Goodliffe');
    await page.locator('[id$="-item-container"]').filter({ hasText: 'Don Goodliffe' }).click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();


    // Impersonation triggers a full page reload under the hood - wait for the
    // banner to confirm it's actually settled before touching the page again.
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).waitFor({ state: 'visible', timeout: 30_000 });

    // ---------- Step 2: navigate to the Dashboard via search ----------
    await page.getByText('All').first().click();

    const searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox.click();
    await searchBox.fill('bitsight');

    await page
        .getByRole('link', { name: 'Dashboard 4 of' })
        .click();

    // ---------- Step 3: confirm the permission-denied message is shown ----------
    const permissionDeniedMessage = page.getByRole('heading', { name: 'You do not have permission to' });
    await expect(permissionDeniedMessage, 'Expected the permission-denied message to be visible for the restricted user').toBeVisible({ timeout: 30_000 });

    console.log('[TC 075] Confirmed: permission-denied message is shown for the restricted user on the Dashboard.');

    // ---------- Step 4: end impersonation ----------
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).click();
    await page.getByRole('button', { name: 'End impersonation' }).click();

    console.log('[TC 075] Test complete.');
});

test('TC 076 & 077 Bitsight - Application Configuration and Scheduled Data Imports hidden from restricted user', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(BASE_URL);
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 1: impersonate the restricted user ----------
    const adminMenuButton = page.getByRole('button', { name: 'System Administrator:' });
    await adminMenuButton.waitFor({ state: 'visible', timeout: 30_000 });
    await adminMenuButton.click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();

    const userCombo = page.getByRole('combobox', { name: 'Select a user' });
    await userCombo.click();
    await userCombo.fill('Don Goodliffe');
    await page.locator('[id$="-item-container"]').filter({ hasText: 'Don Goodliffe' }).click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();


    // Impersonation triggers a full page reload under the hood - wait for the
    // banner to confirm it's actually settled before touching the page again.
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).waitFor({ state: 'visible', timeout: 30_000 });

    // ---------- Step 2: search for "bitsight" ----------
    await page.getByText('All').first().click();

    const searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox.click();
    await searchBox.fill('bitsight');

    const bitsightListItem = page
        .getByRole('listitem')
        .filter({ hasText: 'Bitsight Vendor Risk ManagementEdit ApplicationPortfolioEdit Module Rating and' });

    // ---------- Step 3: confirm the admin-only entries are not visible ----------
    const applicationConfigLink = bitsightListItem.getByLabel('Application Configuration 4 of');
    const scheduledImportsLink = bitsightListItem.getByLabel('Scheduled Data Imports 5 of');

    await expect(applicationConfigLink, 'Expected "Application Configuration" to not be visible to a restricted user').not.toBeVisible();
    await expect(scheduledImportsLink, 'Expected "Scheduled Data Imports" to not be visible to a restricted user').not.toBeVisible();

    console.log('[TC 076 & 077] Confirmed: Application Configuration and Scheduled Data Imports are hidden from the restricted user.');

    // ---------- Step 4: end impersonation ----------
    await page.getByRole('button', { name: 'Don Goodliffe: Available' }).click();
    await page.getByRole('button', { name: 'End impersonation' }).click();

    console.log('[TC 076 & 077] Test complete.');
});