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
    filterBitsightModules,
    navigateToApplicationConfiguration,
    navigateToScheduledDataImports,
    configureApplicationProperties,
    triggerAndWaitForAlertsImport,
} from './utils/servicenow-session-helpers';

import { clearPortfolio } from './utils/cleanup-utils.js';
import { clearAlerts, clearIncidents } from './utils/cleanup-utils.js';


const BASE_URL = process.env.SN_URL;
const COMPLETE_MESSAGE = 'Bitsight Portfolios Import Complete';
const { BitsightApiClient } = require('./utils/bitsight-api-client'); // adjust path as needed
const { ServiceNowApiClient } = require('./utils/servicenow-api-client'); // adjust path as needed

test('TC 001 Bitsight token validation', async ({ page }) => {
    test.setTimeout(600_000);

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

    await tokenInput.fill(process.env.VRM_TOKEN);
    await validateButton.click();

    // Validation can take a while — give it up to 2 minutes
    await expect(frame.getByText('Token validated successfully')).toBeVisible({
        timeout: 400_000,
    });

    await okButton.click();
});

test('TC 002 VRM Subscription Type 2 Token Portfolio Import Job', async ({ page }) => {
    test.setTimeout(1_800_000); // 30 minutes for full import + crawl + reconciliation

    const bitsightClient = new BitsightApiClient();
    const serviceNowClient = new ServiceNowApiClient();
    const frame = await openApplicationConfiguration(page);
    await frame.locator('#ins_company_y').click();
    await frame.locator('#property_save_btn').click();
    await page.waitForTimeout(3000);

    await expect(frame.locator('#ins_company_y')).toBeChecked();
    // -------------------------------------------------------------------------
    // Pre-Step 1: Clean Up Existing Portfolio in ServiceNow
    // -------------------------------------------------------------------------
    console.log('\n=== Pre-Step 1: Cleaning Up Existing Portfolio Records ===');
    await clearPortfolio(serviceNowClient);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Timestamps
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestImportCompleteLog(page);
    const baselineTriggerTimestamp = new Date().toISOString();

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Portfolio Data Import ===');
    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const importLink = gsftFrame.getByRole('link', { name: 'Open record: Bitsight' }).nth(2);
    await importLink.click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log('Triggered "Execute Now" for Portfolio Import.');

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Import completion log should be found').toBeTruthy();
    const completionTimestamp = completeLog.sys_created_on;

    // -------------------------------------------------------------------------
    // Step 4: Build Ground Truth from Bitsight (VRM Resolution Only)
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching and Resolving Bitsight VRM Ground Truth ===');
    const vrmVendors = await bitsightClient.getVendors();
    console.log(`Bitsight Raw VRM Vendors Count (vrm_raw): ${vrmVendors.length}`);

    const resolved_vrm_guids = await bitsightClient.resolveVrmVendors(vrmVendors);

    // Build VRM-only ground truth set (resolved bs_guid, or unresolved placeholder)
    const merged_vrm = new Set();
    for (const [vendor_guid, bs_guid] of Object.entries(resolved_vrm_guids)) {
        if (bs_guid === null || bs_guid === undefined) {
            merged_vrm.add(`unresolved:${vendor_guid}`);
        } else {
            merged_vrm.add(bs_guid);
        }
    }
    console.log(`Bitsight VRM Ground Truth Set Size (merged_vrm): ${merged_vrm.size}`);

    // Also obtain full ground truth map for Tier 2 sampled validation
    const groundTruth = await bitsightClient.getGroundTruth();

    // -------------------------------------------------------------------------
    // Step 5: Fetch ServiceNow core_company State (VRM records only) & Scoped Failures
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Fetching ServiceNow VRM State & Scoped Failures ===');
    const snCompanies = await serviceNowClient.getBitsightCoreCompanies();

    const isVrmRecord = (rec) => Boolean(
        rec.x_bisit_vrm_is_vrm === 'true' ||
        rec.x_bisit_vrm_is_vrm === true ||
        rec.u_is_vrm === 'true' ||
        rec.u_is_vrm === true
    );

    const vrmSnCompanies = snCompanies.filter(isVrmRecord);
    const imported_count = vrmSnCompanies.length;
    const imported_map = new Map(vrmSnCompanies.map(c => [c.x_bisit_vrm_bitsight_vendor_guid, c]));
    console.log(`ServiceNow core_company VRM record count (imported_count): ${imported_count}`);

    const failedLogs = await serviceNowClient.getFailedImportCompanies({
        baselineTimestamp: baselineTriggerTimestamp,
        completionTimestamp,
    });
    const failed = new Set(failedLogs.map(l => l.vendorGuid).filter(Boolean));
    console.log(`ServiceNow Scoped Failed Vendor GUIDs Count (failed): ${failed.size}`);

    // -------------------------------------------------------------------------
    // Step 6: Classify Each Failed vendor_guid as true_missing (no CM fallback in VRM-only scope)
    // -------------------------------------------------------------------------
    console.log('\n=== Step 6: Classifying Failed Vendor GUIDs (VRM-only, no degraded bucket) ===');
    const true_missing = new Set();

    for (const vendor_guid of failed) {
        true_missing.add(vendor_guid);
    }

    console.log(`Classification Results: true_missing=${true_missing.size}`);

    // -------------------------------------------------------------------------
    // Tier 1 Assertion: Total ServiceNow VRM Count Reconciled
    // -------------------------------------------------------------------------
    const expected_count = merged_vrm.size - true_missing.size;
    console.log('\n================================================================');
    console.log('       TIER 1: VRM COMPLETENESS RECONCILIATION SUMMARY          ');
    console.log('================================================================');
    console.table({
        'VRM Raw Vendors': vrmVendors.length,
        'VRM Ground Truth (merged_vrm.size)': merged_vrm.size,
        'Failed Vendors (syslog)': failed.size,
        'True Missing (absent from SN)': true_missing.size,
        'Expected ServiceNow VRM Count (merged_vrm - true_missing)': expected_count,
        'Actual ServiceNow VRM Count (imported_count)': imported_count,
        'Difference': Math.abs(imported_count - expected_count),
    });

    expect(
        imported_count,
        `Expected imported VRM count (${imported_count}) to equal VRM ground truth minus true missing (${merged_vrm.size} - ${true_missing.size} = ${expected_count})`
    ).toBe(expected_count);

    // -------------------------------------------------------------------------
    // Tier 1b Assertion: Successfully Resolved Non-Failed VRM Vendors (u_is_vrm == true)
    // -------------------------------------------------------------------------
    console.log('\n=== Tier 1b: Verifying Non-Failed VRM Vendors (u_is_vrm == true) ===');
    for (const [vendor_guid, bs_guid] of Object.entries(resolved_vrm_guids)) {
        if (bs_guid && !failed.has(vendor_guid)) {
            const snRec = imported_map.get(bs_guid);
            if (snRec) {
                const companyName = snRec.x_bisit_vrm_company_name || snRec.name || groundTruth.portfolioMap.get(bs_guid)?.name || 'Unknown';
                const isVrm = isVrmRecord(snRec);
                console.log(`VRM vendor: "${companyName}" | vendor_guid: ${vendor_guid} (bs_guid: ${bs_guid}) -> x_bisit_vrm_is_vrm: ${isVrm}`);
                expect.soft(isVrm, `Successfully resolved non-failed VRM vendor "${companyName}" (bs_guid: ${bs_guid}) should have x_bisit_vrm_is_vrm = true`).toBe(true);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Step 7: Tier 2 - Fetch 15 Random Recently Updated VRM Records from ServiceNow
    // -------------------------------------------------------------------------
    console.log('\n=== Step 7: Fetching 15 Random Recently Updated VRM Records from ServiceNow ===');
    const candidatePool = await serviceNowClient.getRandomRecentlyUpdatedCoreCompanies(50, 100);
    const sampleRecords = candidatePool.filter(isVrmRecord).slice(0, 15);
    expect(sampleRecords.length, 'Expected to retrieve sampled VRM records from ServiceNow').toBeGreaterThan(0);

    const lifecycleStagesMap = await bitsightClient.getLifecycleStages();

    // -------------------------------------------------------------------------
    // Step 8: Field-by-Field Validation for the 15 VRM records against Ground Truth
    // -------------------------------------------------------------------------
    console.log('\n=== Step 8: Validating Sampled VRM Records Field-by-Field against Ground Truth ===');
    const sampleFieldMismatches = [];
    const sampleValidationSummary = [];

    // ServiceNow stores risk_score / trust_score as rounded integers while Bitsight's
    // API returns full decimals (e.g. 13.575 vs "14"). This is expected platform
    // behaviour, so these two fields are compared with rounding tolerance instead
    // of strict equality. All other fields still require an exact match.
    const ROUNDED_SCORE_FIELDS = new Set(['risk_score', 'trust_score']);
    const isRoundedScoreMatch = (expectedVal, actualVal) => {
        const expNum = Number(expectedVal);
        const actNum = Number(actualVal);
        if (Number.isNaN(expNum) || Number.isNaN(actNum)) return false;
        return Math.round(expNum) === Math.round(actNum);
    };

    for (const actual of sampleRecords) {
        const guid = actual.x_bisit_vrm_bitsight_vendor_guid || actual.x_bisit_vrm_vendor_guid;
        const vrmVendorGuid = actual.x_bisit_vrm_vendor_guid || actual.u_vrm_vendor_guid;
        const expected = groundTruth.portfolioMap.get(guid) || (vrmVendorGuid ? groundTruth.portfolioMap.get(vrmVendorGuid) : null);

        if (!expected) {
            sampleFieldMismatches.push({
                vendorGuid: guid,
                companyName: actual.x_bisit_vrm_company_name || actual.u_name,
                field: 'Record Existence in Ground Truth',
                expected: 'Present in Bitsight VRM Ground Truth',
                actual: 'Not Found in Bitsight VRM Ground Truth',
            });
            continue;
        }

        // Resolve lifecycle stage name
        const stageId = expected.life_cycle_stage_guid || expected.life_cycle_stage_id || expected.lifecycle_stage_id;
        if (stageId && String(stageId).trim() !== '') {
            const stageName = lifecycleStagesMap[String(stageId).trim()] || stageId;
            expected.u_vrm_life_cycle_stage = stageName;
            expected.x_bisit_vrm_life_cycle_stage_name = stageName;
            expected.life_cycle_stage_name = stageName;
        }

        // Always fetch security rating and rating date via API if missing/empty on expected
        if (expected.rating === null || expected.rating === undefined || expected.rating === '' || !expected.rating_date) {
            const entityGuid = expected.bs_company_guid || expected.bitsight_vendor_guid || expected.guid || guid;
            const ratingInfo = await bitsightClient.getVendorRatings(entityGuid);
            if (ratingInfo && ratingInfo.rating !== null) {
                expected.rating = ratingInfo.rating;
                expected.x_bisit_vrm_security_rating = ratingInfo.rating;
                const rDate = ratingInfo.rating_date || ratingInfo.ratingDate;
                if (rDate) {
                    expected.rating_date = rDate;
                    expected.ratingDate = rDate;
                    expected.x_bisit_vrm_rating_date = rDate;
                }
            }
        }

        const fieldsToCheck = [
            { key: 'name', snKey: 'x_bisit_vrm_company_name' },
            { key: 'primary_domain', snKey: 'x_bisit_vrm_primary_domain' },
            { key: 'rating', snKey: 'x_bisit_vrm_security_rating' },
            { key: 'rating_date', snKey: 'x_bisit_vrm_rating_date' },
            { key: 'impact_score', snKey: 'x_bisit_vrm_impact_score' },
            { key: 'risk_score', snKey: 'x_bisit_vrm_risk_score' },
            { key: 'trust_score', snKey: 'x_bisit_vrm_trust_score' },
            // due_date intentionally excluded: it is not always populated
            // (depends on lifecycle/assessment state), so its absence or
            // presence is not a reliable indicator of an import defect.
            { key: 'vendor_guid', snKey: 'x_bisit_vrm_vendor_guid' },
            { key: 'is_managed', snKey: 'x_bisit_vrm_is_managed' },
            { key: 'x_bisit_vrm_life_cycle_stage_name', snKey: 'x_bisit_vrm_life_cycle_stage_name' },
        ];

        let recordMismatches = 0;

        for (const f of fieldsToCheck) {
            const expVal = expected[f.key] !== undefined ? expected[f.key] : expected[f.snKey];
            const actVal = actual[f.snKey] !== undefined ? actual[f.snKey] : actual[f.key];

            const matches = ROUNDED_SCORE_FIELDS.has(f.key)
                ? isRoundedScoreMatch(expVal, actVal)
                : areValuesEqual(expVal, actVal);

            if (!matches) {
                recordMismatches++;
                sampleFieldMismatches.push({
                    vendorGuid: guid,
                    companyName: actual.x_bisit_vrm_company_name || actual.u_name || expected.name,
                    field: f.snKey,
                    expected: expVal,
                    actual: actVal,
                });
            }
        }

        sampleValidationSummary.push({
            guid,
            name: actual.u_name || expected.name,
            is_vrm: true,
            fieldsChecked: fieldsToCheck.length,
            mismatches: recordMismatches,
            status: recordMismatches === 0 ? 'MATCH' : 'MISMATCH',
        });
    }

    // -------------------------------------------------------------------------
    // Step 9: Print Structured Summary & Assertions
    // -------------------------------------------------------------------------
    console.log('\n================================================================');
    console.log('       TIER 2: 15-RECORD VRM SAMPLE DEEP VALIDATION REPORT       ');
    console.log('================================================================');
    console.table(sampleValidationSummary);

    if (sampleFieldMismatches.length > 0) {
        console.log('\n--- SAMPLE FIELD MISMATCHES ---');
        console.table(sampleFieldMismatches);
    } else {
        console.log('\nAll sampled VRM records matched perfectly with Ground Truth.');
    }
    console.log('================================================================\n');

    expect.soft(
        sampleFieldMismatches.length,
        `Expected 0 field mismatches in 15-record VRM sample, but found ${sampleFieldMismatches.length}. Mismatches: ${JSON.stringify(sampleFieldMismatches, null, 2)}`
    ).toBe(0);
});

test('TC 003 Verify VRM-only company record tabs and cards in ServiceNow', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(
        process.env.SN_URL +
        'now/nav/ui/classic/params/target/' +
        'core_company_list.do%3Fsysparm_query%3Dx_bisit_vrm_bitsight_vendor_guidISNOTEMPTY%255Ex_bisit_vrm_is_vrm%253Dtrue%255Ex_bisit_vrm_bs_subscription_type%253DNULL%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight_vrm'
    );

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    // Open first available VRM-only record
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });
    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC-003] Opening first VRM-only company record: "${companyName}"`);
    await firstRecordLink.click();

    // Wait for form to load by waiting for a core tab
    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i });
    // const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await vendorRiskTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 1. Verify visible tabs (Bitsight Assessment Report should NOT be visible for VRM-only)
    await expect(vendorRiskTab).toBeVisible();
    // await expect(ratingsTab).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Portfolio Information' })).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Assessment Report', timeout: 15_000 })).not.toBeVisible();

    // // 2. On Bitsight Security Ratings tab: Verify "Subscribe" button is visible
    // await ratingsTab.click();
    // const subscribeBtn = frame.getByRole('button', { name: 'Subscribe' });
    // await subscribeBtn.scrollIntoViewIfNeeded();
    // await expect(subscribeBtn).toBeVisible({ timeout: 15_000 });

    // 3. On Bitsight Vendor Risk tab: Verify 4 cards (Security Rating Gauge, Scoring, Life Cycle Stage, Past Due)
    await vendorRiskTab.click();

    const aboutRating = frame.getByText(/About Rating/i).first();
    await aboutRating.scrollIntoViewIfNeeded();
    await expect(aboutRating).toBeVisible({ timeout: 15_000 });

    const scoringImpact = frame.getByText(/Scoring\s*(Impact)?/i).first();
    await scoringImpact.scrollIntoViewIfNeeded();
    await expect(scoringImpact).toBeVisible({ timeout: 15_000 });

    const lifeCycleStage = frame.getByText(/Life Cycle Stage/i).first();
    await lifeCycleStage.scrollIntoViewIfNeeded();
    await expect(lifeCycleStage).toBeVisible({ timeout: 15_000 });

    const pastDue = frame.getByText(/Past Due/i).first();
    await pastDue.scrollIntoViewIfNeeded();
    await expect(pastDue).toBeVisible({ timeout: 15_000 });
});

test('TC 004 Verify portfolio information fields ', async ({ page }) => {
    test.setTimeout(600_000);

    // ---------- Step 1: navigate to the Portfolio and open the first available record ----------
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
    console.log(`[TC 004] Opening first Portfolio record: "${companyName}"`);

    await firstRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 2: switch to the Bitsight Portfolio Information tab ----------
    const portfolioInfoTab = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
    await portfolioInfoTab.waitFor({ state: 'visible', timeout: 30_000 });
    await portfolioInfoTab.click();
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 3: verify the fields on this tab are populated ----------
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

    // // The Bitsight portal link is an anchor, not a textbox - check it separately
    // const bitsightPortalLink = frame.getByRole('link', { name: 'https://service.bitsighttech.' });
    // await bitsightPortalLink.waitFor({ state: 'visible', timeout: 30_000 });
    // const isPortalLinkVisible = await bitsightPortalLink.isVisible();
    // console.log(isPortalLinkVisible ? ' Bitsight portal link is visible' : ' Bitsight portal link is NOT visible');
    // expect(isPortalLinkVisible, 'Expected the Bitsight portal link to be visible on the Portfolio Information tab').toBeTruthy();

    console.log(`[TC 004] All Portfolio Information fields verified for "${companyName}"`);
});

test('TC 005 Unmatched company is not inserted when Insert option is disabled', async ({ page }) => {
    test.setTimeout(900_000);

    // ---------- Step 1: navigate to Application Configuration (fresh) ----------
    const frame = await openApplicationConfiguration(page);

    // ---------- Step 2: pick and delete a handful of previously matched companies ----------
    const recordsToDelete = await getRandomCoreCompaniesWithGuid(page, 5);
    expect(recordsToDelete.length, 'Expected at least one core_company record with a Bitsight GUID to delete for this test').toBeGreaterThan(0);

    console.log(`[TC 005] Deleting ${recordsToDelete.length} core_company record(s) to manufacture unmatched Bitsight companies...`);
    await deleteCoreCompanyRecords(page, recordsToDelete);

    const deletedGuids = recordsToDelete.map(r => r.guid);

    // ---------- Step 3: set Insert option to No, fill caller, and save ----------
    await frame.locator('#ins_company_n').click();
    // await frame.locator('[id="sys_display.caller"]').click();
    // await frame.locator('[id="sys_display.caller"]').fill('Abel Tuter');
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
        ? `[TC 005] Confirmed: none of the ${deletedGuids.length} deleted companies were reinserted.`
        : `[TC 005] UNEXPECTED: ${reinsertedRecords.length} deleted compan${reinsertedRecords.length === 1 ? 'y' : 'ies'} came back: ${reinsertedRecords.map(r => unwrapField(r.name)).join(', ')}`);

    expect(reinsertedRecords.length, 'Expected deleted companies to stay absent from core_company when Insert option is disabled').toBe(0);

    console.log('[TC 005] Test complete.');
});

test('TC 006 Unmatched company is inserted when Insert option is enabled', async ({ page }) => {
    test.setTimeout(900_000);

    // ---------- Step 1: navigate to Application Configuration (fresh) ----------
    const frame = await openApplicationConfiguration(page);

    // ---------- Step 2: pick and delete a handful of previously matched companies ----------
    const recordsToDelete = await getRandomCoreCompaniesWithGuid(page, 5);
    expect(recordsToDelete.length, 'Expected at least one core_company record with a Bitsight GUID to delete for this test').toBeGreaterThan(0);

    console.log(`[TC 006] Deleting ${recordsToDelete.length} core_company record(s) to manufacture unmatched Bitsight companies...`);
    await deleteCoreCompanyRecords(page, recordsToDelete);

    const deletedGuids = recordsToDelete.map(r => r.guid);

    // ---------- Step 3: set Insert option to Yes, fill caller, and save ----------
    await frame.locator('#ins_company_y').click();
    // await frame.locator('[id="sys_display.caller"]').click();
    // await frame.locator('[id="sys_display.caller"]').fill('Abel Tuter');
    // await page.waitForTimeout(3000);
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
        ? `[TC 006] Confirmed: all ${deletedGuids.length} deleted companies were reinserted.`
        : `[TC 006] UNEXPECTED: ${missingGuids.length} of ${deletedGuids.length} deleted compan${missingGuids.length === 1 ? 'y is' : 'ies are'} still missing (guids: ${missingGuids.join(', ')})`);

    expect(reinsertedRecords.length, `Expected all ${deletedGuids.length} deleted companies to be reinserted when Insert option is enabled`).toBe(deletedGuids.length);

    console.log('[TC 006] Test complete.');
});


test('TC 007 Imported companies are not marked as vendors when Mark as Vendor is disabled', async ({ page }) => {
    test.setTimeout(900_000);

    // ---------- Step 1: navigate to Application Configuration (fresh) ----------
    const frame = await openApplicationConfiguration(page);

    // ---------- Step 2: clear every Bitsight-linked company so the next import re-inserts them all fresh ----------
    const existingRecords = await getAllCoreCompaniesWithGuid(page);
    console.log(`[TC 007] Deleting all ${existingRecords.length} existing Bitsight-linked core_company record(s)...`);
    if (existingRecords.length > 0) {
        await deleteCoreCompanyRecords(page, existingRecords);
    }

    // ---------- Step 3: enable Insert (so everything gets reimported), disable Mark as Vendor, fill caller, and save ----------
    await frame.locator('#ins_company_y').click();
    await frame.locator('#mark_comp_n').click();
    // await frame.locator('[id="sys_display.caller"]').click();
    // await frame.locator('[id="sys_display.caller"]').fill('Abel Tuter');
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
    console.log(`[TC 007] ${companyRecords.length} freshly imported companies checked, ${unexpectedVendors.length} unexpectedly marked as vendor=true.`);

    if (unexpectedVendors.length > 0) {
        console.log(`[TC 007] UNEXPECTED: ${unexpectedVendors.map(r => r.name).join(', ')}`);
    }

    expect(unexpectedVendors.length, 'Expected all freshly imported companies to have vendor=false when Mark as Vendor is disabled').toBe(0);

    console.log('[TC 007] Confirmed: all freshly imported companies have vendor=false.');
    console.log('[TC 007] Test complete.');
});


test('TC 008 Imported companies are marked as vendors when Mark as Vendor is enabled', async ({ page }) => {
    test.setTimeout(900_000);

    // ---------- Step 1: navigate to Application Configuration (fresh) ----------
    const frame = await openApplicationConfiguration(page);

    // ---------- Step 2: clear every Bitsight-linked company so the next import re-inserts them all fresh ----------
    const existingRecords = await getAllCoreCompaniesWithGuid(page);
    console.log(`[TC 008] Deleting all ${existingRecords.length} existing Bitsight-linked core_company record(s)...`);
    if (existingRecords.length > 0) {
        await deleteCoreCompanyRecords(page, existingRecords);
    }

    // ---------- Step 3: enable Insert (so everything gets reimported), enable Mark as Vendor, fill caller, and save ----------
    await frame.locator('#ins_company_y').click();
    await frame.locator('#mark_comp_y').click();
    // await frame.locator('[id="sys_display.caller"]').click();
    // await frame.locator('[id="sys_display.caller"]').fill('Abel Tuter');
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
    console.log(`[TC 008] ${companyRecords.length} freshly imported companies checked, ${missingVendorFlag.length} unexpectedly NOT marked as vendor=true.`);

    if (missingVendorFlag.length > 0) {
        console.log(`[TC 008] UNEXPECTED: ${missingVendorFlag.map(r => r.name).join(', ')}`);
    }

    expect(missingVendorFlag.length, 'Expected all freshly imported companies to have vendor=true when Mark as Vendor is enabled').toBe(0);

    console.log('[TC 008] Confirmed: all freshly imported companies have vendor=true.');
    console.log('[TC 008] Test complete.');
});

test('TC 072 Bitsight Portfolio - Security Rating field is write-protected via API for restricted user', async ({ page }) => {
    test.setTimeout(120_000 + 1_800_000); // original timeout + 30 min for the import

    const token = process.env.CM_TOKEN;
    if (!token) {
        throw new Error('CM_TOKEN is not set in .env');
    }
    const bitsightClient = new BitsightApiClient({ token });
    const serviceNowClient = new ServiceNowApiClient();

    // ---------- Step 0: run alerts import reconciliation first ----------
    console.log('\n=== Step 0: Cleaning Up Existing Alerts & Incidents ===');
    await clearAlerts(serviceNowClient);
    await clearIncidents(serviceNowClient);

    console.log('\n=== Step 0: Configuring Application Properties ===');
    await configureApplicationProperties(page, {
        ins_company: true,
        mark_comp: true,
        maxpropertyinc: 10,
        inc_score: true,
        incscoredrop: 5,
        critcal_alert_inc: true,
        inc_warn_alert: true,
        assign_incident: 'user',
        user: 'abel tuter',
        caller: 'abraham lincoln',
    });

    await triggerAndWaitForAlertsImport(page, serviceNowClient);

    const snCompanyGuids = await serviceNowClient.getBitsightVendorGuids();
    console.log(`Found ${snCompanyGuids.length} active Bitsight companies in ServiceNow core_company.`);
    const alertsGroundTruth = await bitsightClient.getAlertsCount({
        portfolioGuids: snCompanyGuids.map(c => c.guid),
    });
    const totalAlertsCount = typeof alertsGroundTruth === 'number' ? alertsGroundTruth : (alertsGroundTruth.count ?? alertsGroundTruth);
    console.log(`Bitsight Alerts Ground Truth Count (matching ServiceNow portfolio): ${totalAlertsCount}`);

    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
        sysparm_limit: 10000,
        fields: 'sys_id',
    });
    const snAlertsCount = snAlertsList.length;
    console.log(`ServiceNow alerts table record count: ${snAlertsCount}`);

    console.table({
        'Bitsight Alerts Ground Truth Count': totalAlertsCount,
        'Actual ServiceNow Alerts Table Count': snAlertsCount,
        'Difference': Math.abs(snAlertsCount - totalAlertsCount),
    });

    expect(
        snAlertsCount,
        `Expected ServiceNow alerts table count (${snAlertsCount}) to match Bitsight Alerts ground truth count (${totalAlertsCount})`
    ).toBe(totalAlertsCount);

    // ---------- Step 1: impersonate the restricted user ----------
    const adminMenuButton = page.getByRole('button', { name: 'System Administrator:' });
    await adminMenuButton.waitFor({ state: 'visible', timeout: 30_000 });
    await adminMenuButton.click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();

    const userCombo = page.getByRole('combobox', { name: 'Select a user' });
    await userCombo.click();
    await userCombo.fill(process.env.VRM_USER_BASIC);
    await page.locator('[id$="-item-container"]').filter({ hasText: process.env.VRM_USER_BASIC }).click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();

    await page.waitForLoadState('networkidle').catch(() => { });
    await page.getByRole('button', { name: `${process.env.VRM_USER_BASIC}: Available` }).waitFor({ state: 'visible', timeout: 30_000 });

    try {
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
    } finally {
        // ---------- Step 5: end impersonation (always runs, even if an assertion above failed) ----------
        await page.getByRole('button', { name: `${process.env.VRM_USER_BASIC}: Available` }).click().catch(() => { });
        await page.getByRole('button', { name: 'End impersonation' }).click().catch(() => { });

        // Ending impersonation reloads the page just like starting it does -
        // wait for that reload to fully settle and confirm we're back to admin
        // before this test finishes, so the NEXT test doesn't inherit a
        // half-reverted impersonated session.
        await page.waitForLoadState('networkidle').catch(() => { });
        await page.getByRole('button', { name: 'System Administrator:' })
            .waitFor({ state: 'visible', timeout: 30_000 })
            .catch(() => { });

        console.log('[TC 072] Impersonation ended.');
    }

    console.log('[TC 072] Test complete.');
});

test('TC 075 Bitsight Dashboard - permission-denied message NOT shown for restricted user', async ({ page }) => {
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
    await userCombo.fill(process.env.VRM_USER_BASIC);
    await page.locator('[id$="-item-container"]').filter({ hasText: process.env.VRM_USER_BASIC }).click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();

    // Impersonation triggers a full page reload under the hood - wait for the
    // banner to confirm it's actually settled before touching the page again.
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.getByRole('button', { name: `${process.env.VRM_USER_BASIC}: Available` }).waitFor({ state: 'visible', timeout: 30_000 });

    try {
        // ---------- Step 2: navigate to the Dashboard via search ----------
        await page.getByText('All').first().click();

        const searchBox = page.getByRole('textbox', { name: 'Enter search term to filter' });
        await searchBox.click();
        await searchBox.fill('bitsight');

        await page
            .getByRole('link', { name: 'Dashboard 4 of' })
            .click();

        // ---------- Step 3: confirm the permission-denied message is NOT shown ----------
        const permissionDeniedMessage = page.getByRole('heading', { name: 'You do not have permission to' });
        await expect(
            permissionDeniedMessage,
            'Expected the permission-denied message to NOT be visible for the restricted user'
        ).not.toBeVisible({ timeout: 30_000 });

        console.log('[TC 075] Confirmed: permission-denied message is NOT shown for the restricted user on the Dashboard.');
    } finally {
        // ---------- Step 5: end impersonation (always runs, even if an assertion above failed) ----------
        await page.getByRole('button', { name: `${process.env.VRM_USER_BASIC}: Available` }).click().catch(() => { });
        await page.getByRole('button', { name: 'End impersonation' }).click().catch(() => { });

        // Ending impersonation reloads the page just like starting it does -
        // wait for that reload to fully settle and confirm we're back to admin
        // before this test finishes, so the NEXT test doesn't inherit a
        // half-reverted impersonated session.
        await page.waitForLoadState('networkidle').catch(() => { });
        await page.getByRole('button', { name: 'System Administrator:' })
            .waitFor({ state: 'visible', timeout: 30_000 })
            .catch(() => { });

        console.log('[TC 075] Impersonation ended.');
    }

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
    await userCombo.fill(process.env.VRM_USER_BASIC);
    await page.locator('[id$="-item-container"]').filter({ hasText: process.env.VRM_USER_BASIC }).click();
    await page.getByRole('button', { name: 'Impersonate user' }).click();

    // Impersonation triggers a full page reload under the hood - wait for the
    // banner to confirm it's actually settled before touching the page again.
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.getByRole('button', { name: `${process.env.VRM_USER_BASIC}: Available` }).waitFor({ state: 'visible', timeout: 30_000 });

    try {
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
    } finally {
        // ---------- Step 5: end impersonation (always runs, even if an assertion above failed) ----------
        await page.getByRole('button', { name: `${process.env.VRM_USER_BASIC}: Available` }).click().catch(() => { });
        await page.getByRole('button', { name: 'End impersonation' }).click().catch(() => { });

        // Ending impersonation reloads the page just like starting it does -
        // wait for that reload to fully settle and confirm we're back to admin
        // before this test finishes, so the NEXT test doesn't inherit a
        // half-reverted impersonated session.
        await page.waitForLoadState('networkidle').catch(() => { });
        await page.getByRole('button', { name: 'System Administrator:' })
            .waitFor({ state: 'visible', timeout: 30_000 })
            .catch(() => { });

        console.log('[TC 076 & 077] Impersonation ended.');
    }

    console.log('[TC 076 & 077] Test complete.');
});






