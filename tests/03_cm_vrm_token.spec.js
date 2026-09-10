import { test, expect } from '@playwright/test';
import { BitsightApiClient } from './utils/bitsight-api-client.js';
import { ServiceNowApiClient } from './utils/servicenow-api-client.js';

const MODULES = [
    'Portfolio',
    'Rating and Risk Vector Alerts',
    'Incidents',
    'Application Configuration',
    'Scheduled Data Imports',
    'Dashboard',
    'About Bitsight',
    'Contact Support',
    'App Privacy Policy',
];

// Shared navigation: search for "bitsight" in the nav filter so module links are visible
async function filterBitsightModules(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByText('All').first().click();

    // Nudge mouse to dismiss any overlay
    await page.mouse.move(100, 100);
    await page.mouse.move(200, 200);

    const filter = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await filter.click();
    await filter.fill('bitsight');
    await filter.press('Enter');
}

/**
 * Value comparison helper: Validates that field values match without requiring identical data types
 * Handles numbers (1 vs 1.0 vs "1"), booleans (false vs "false" vs 0), dates ("2026-09-08T00:00:00Z" vs "2026-09-08"),
 * and case-insensitive trimmed strings.
 */
function areValuesEqual(v1, v2) {
    const isV1Empty = v1 === null || v1 === undefined || v1 === '';
    const isV2Empty = v2 === null || v2 === undefined || v2 === '';
    if (isV1Empty && isV2Empty) return true;
    if (isV1Empty || isV2Empty) return false;

    const str1 = String(v1).trim();
    const str2 = String(v2).trim();

    // Exact or case-insensitive string match
    if (str1.toLowerCase() === str2.toLowerCase()) return true;

    // Boolean match ("true"/true/"1" vs "false"/false/"0")
    const isBool1 = str1 === 'true' || str1 === 'false' || typeof v1 === 'boolean';
    const isBool2 = str2 === 'true' || str2 === 'false' || typeof v2 === 'boolean';
    if (isBool1 && isBool2) {
        const b1 = (str1 === 'true' || str1 === '1' || v1 === true);
        const b2 = (str2 === 'true' || str2 === '1' || v2 === true);
        return b1 === b2;
    }

    // Number match (e.g. 1.0 vs "1", 730 vs "730", 28.19 vs "28.19")
    const num1 = Number(str1);
    const num2 = Number(str2);
    if (!isNaN(num1) && !isNaN(num2)) {
        return Math.abs(num1 - num2) < 0.001;
    }

    // Date match (e.g. "2026-09-08T00:00:00Z" vs "2026-09-08" or "2026-09-08 12:00:00")
    const date1 = str1.split('T')[0].split(' ')[0];
    const date2 = str2.split('T')[0].split(' ')[0];
    if (date1 === date2) return true;

    return false;
}

test('TC-01: Verify all Bitsight VRM modules are reachable', async ({ page }) => {
    await filterBitsightModules(page);

    for (const module of MODULES) {
        const link = page.getByRole('link', {
            name: new RegExp(`^${module} \\d+ of \\d+$`),
        });
        await expect(link).toBeVisible();
        await link.click();
    }
});

test('TC-02: Valid Bitsight token (CM + VRM) validates successfully and reveals config sections', async ({ page }) => {
    test.setTimeout(240000); // 4 min overall, since validation can take up to ~3 min

    const token = process.env.CMVRM_TOKEN;
    if (!token) {
        throw new Error('CMVRM_TOKEN is not set in .env');
    }

    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');

    // Enter a valid token that has both CM and VRM licenses active
    const tokenField = gsftFrame.locator('#token');
    await tokenField.click();
    await tokenField.fill(token);
    await gsftFrame.getByRole('button', { name: 'Validate Token' }).click();

    // --- Wait for the Success dialog to appear (validation can take 2-3 min) ---
    const successDialog = gsftFrame.getByRole('dialog', { name: 'Success' });
    await expect(successDialog).toBeVisible({ timeout: 200000 });

    // Acknowledge it
    const okButton = successDialog.getByRole('button', { name: 'OK', exact: true });
    await okButton.click();

    // --- Assert: Token field retains the entered value ---
    await expect(tokenField).toHaveValue(token);

    // --- Assert: License status table is visible with both products listed ---
    const licenseTable = gsftFrame.locator('#bs_token').getByRole('table');
    await expect(licenseTable).toBeVisible();
    await expect(licenseTable.getByRole('row', { name: /Continuous Monitoring/ })).toBeVisible();
    await expect(licenseTable.getByRole('row', { name: /Risk Monitoring/ })).toBeVisible();

    await expect(licenseTable.getByRole('row', { name: /Continuous Monitoring/ })).toContainText(/\d+\/\d+/);
    await expect(licenseTable.getByRole('row', { name: /Risk Monitoring/ })).toContainText(/\d+\/\d+/);

    // --- Assert: Configuration options section becomes visible post-validation ---
    const configSection = gsftFrame.locator('#bs-tprm-config');
    await expect(configSection).toBeVisible();
    await expect(configSection.getByText('Insert Bitsight companies that do not match existing company records in ServiceNow', { exact: true })).toBeVisible();
    await expect(configSection.getByText('Mark all imported Bitsight companies as Vendors', { exact: true })).toBeVisible();
    await expect(configSection.getByText('Rules for Automation of Incident creation based on Bitsight Alerts', { exact: true })).toBeVisible();
    await expect(configSection.getByText('Create Incident on Score Change', { exact: true })).toBeVisible();
    await expect(configSection.getByText('Bitsight Rating Drop Trigger', { exact: true })).toBeVisible();
    await expect(configSection.getByText('Create Incident on Bitsight alerts with "Critical Decrease" Severity', { exact: true })).toBeVisible();
    await expect(configSection.getByText('Create Incidents on Bitsight alerts with "Decrease" Severity', { exact: true })).toBeVisible();
    await expect(configSection.getByText('Incident Assignment', { exact: true })).toBeVisible();
    await expect(configSection.getByText('Incident Caller', { exact: true })).toBeVisible();
    await expect(configSection.getByRole('button', { name: 'Save' })).toBeVisible();

    // --- Assert: Disable/Clear Token section becomes visible post-validation ---
    const clearTokenSection = gsftFrame.locator('#bs-clear-token');
    await expect(clearTokenSection).toBeVisible();
    await expect(clearTokenSection.getByText('Disable Bitsight Integration', { exact: true })).toBeVisible();
    await expect(clearTokenSection.getByText('Clear Bitsight API token', { exact: true })).toBeVisible();
    await expect(clearTokenSection.getByRole('button', { name: 'Clear Token' })).toBeVisible();
});

test('TC-03: CM + VRM Subscription Type 3 API Ground Truth Reconciliation', async ({ page }) => {
    test.setTimeout(1_800_000); // 30 minutes for full import + crawl + reconciliation

    const bitsightClient = new BitsightApiClient();
    const serviceNowClient = new ServiceNowApiClient();

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Timestamps
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestImportCompleteLog(page);
    const baselineTriggerTimestamp = new Date().toISOString();

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Data Import ===');
    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const importLink = gsftFrame.getByRole('link', { name: 'Open record: Bitsight' }).nth(2);
    await importLink.click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log('Triggered "Execute Now" for Bitsight Import.');

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
    // Step 4: Fetch Bitsight Ground Truth Union (mergeCompanyVendorPortfoliosLikeProd)
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching Bitsight Ground Truth Union (CM + VRM) ===');
    const groundTruth = await bitsightClient.getGroundTruth();
    const totalUnionCount = groundTruth.passed_portfolio;
    console.log(`Bitsight Ground Truth Union Count (passed_portfolio): ${totalUnionCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Fetch Full ServiceNow core_company GUIDs count
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Fetching ServiceNow core_company GUIDs Count ===');
    const snGuidsList = await serviceNowClient.getBitsightVendorGuids();
    const snTotalCount = snGuidsList.length;
    console.log(`ServiceNow core_company Bitsight record count: ${snTotalCount}`);

    // -------------------------------------------------------------------------
    // Step 6: Extract Failed Portfolios Count from syslog
    // -------------------------------------------------------------------------
    console.log('\n=== Step 6: Extracting Failed Portfolios Count from syslog ===');
    const failedPortfoliosCount = await serviceNowClient.getFailedPortfoliosCount({
        baselineTimestamp: baselineSyslogTimestamp,
        completionTimestamp,
    });
    console.log(`Failed Portfolios Count from syslog: ${failedPortfoliosCount}`);

    const expectedSnCount = totalUnionCount - failedPortfoliosCount;
    console.log(`Calculation: Ground Truth Union (${totalUnionCount}) - Failed (${failedPortfoliosCount}) = Expected (${expectedSnCount})`);

    // -------------------------------------------------------------------------
    // Tier 1 Assertion: Total ServiceNow count must match (Union - Failed)
    // -------------------------------------------------------------------------
    console.log('\n================================================================');
    console.log('       TIER 1: COMPLETENESS RECONCILIATION SUMMARY              ');
    console.log('================================================================');
    console.table({
        'Bitsight Union Total (passed_portfolio)': totalUnionCount,
        'Failed Portfolios (from syslog)': failedPortfoliosCount,
        'Expected ServiceNow Count (Union - Failed)': expectedSnCount,
        'Actual ServiceNow Count (core_company)': snTotalCount,
        'Difference': Math.abs(snTotalCount - expectedSnCount),
    });

    expect.soft(
        snTotalCount,
        `Expected ServiceNow core_company count (${snTotalCount}) to match Ground Truth minus failed portfolios (${totalUnionCount} - ${failedPortfoliosCount} = ${expectedSnCount})`
    ).toBe(expectedSnCount);

    // -------------------------------------------------------------------------
    // Step 7: Tier 2 - Fetch 15 Random Recently Updated Records from ServiceNow
    // -------------------------------------------------------------------------
    console.log('\n=== Step 7: Fetching 15 Random Recently Updated Records from ServiceNow ===');
    const sampleRecords = await serviceNowClient.getRandomRecentlyUpdatedCoreCompanies(15, 50);
    expect(sampleRecords.length, 'Expected to retrieve sampled records from ServiceNow').toBeGreaterThan(0);

    const lifecycleStagesMap = await bitsightClient.getLifecycleStages();

    // -------------------------------------------------------------------------
    // Step 8: Field-by-Field Validation for the 15 records against Ground Truth Union
    // -------------------------------------------------------------------------
    console.log('\n=== Step 8: Validating Sampled Records Field-by-Field against Portfolio Union ===');
    const sampleFieldMismatches = [];
    const sampleValidationSummary = [];

    for (const actual of sampleRecords) {
        const guid = actual.x_bisit_vrm_bitsight_vendor_guid;
        const vrmVendorGuid = actual.u_vrm_vendor_guid;
        const expected = groundTruth.portfolioMap.get(guid) || (vrmVendorGuid ? groundTruth.portfolioMap.get(vrmVendorGuid) : null);

        if (!expected) {
            sampleFieldMismatches.push({
                vendorGuid: guid,
                companyName: actual.u_name,
                field: 'Record Existence in Ground Truth',
                expected: 'Present in Bitsight Union',
                actual: 'Not Found in Bitsight Union',
            });
            continue;
        }

        // If VRM record, resolve lifecycle stage data and fetch VRM rating if needed
        const isVrm = Boolean(actual.x_bisit_vrm_is_vrm || actual.u_is_vrm || expected.u_is_vrm);
        if (isVrm) {
            const stageId = expected.life_cycle_stage_guid || expected.life_cycle_stage_id || expected.lifecycle_stage_id;
            if (stageId && String(stageId).trim() !== '') {
                const stageName = lifecycleStagesMap[String(stageId).trim()] || stageId;
                expected.u_vrm_life_cycle_stage = stageName;
                expected.x_bisit_vrm_life_cycle_stage_name = stageName;
            }

            // If rating not populated from company, fetch from VRM ratings endpoint
            if ((expected.rating === null || expected.rating === undefined) && guid) {
                const ratingInfo = await bitsightClient.getVendorRatings(guid);
                if (ratingInfo && ratingInfo.rating !== null) {
                    expected.rating = ratingInfo.rating;
                    expected.x_bisit_vrm_security_rating = ratingInfo.rating;
                    if (ratingInfo.ratingDate) {
                        expected.rating_date = ratingInfo.ratingDate;
                        expected.ratingDate = ratingInfo.ratingDate;
                        expected.x_bisit_vrm_rating_date = ratingInfo.ratingDate;
                    }
                }
            }
        }

        // Define fields to validate matching ServiceNow's exact fields with Bitsight fields
        const fieldsToCheck = [
            { key: 'name', snKey: 'x_bisit_vrm_company_name' },
            { key: 'primary_domain', snKey: 'x_bisit_vrm_primary_domain' },
            { key: 'rating', snKey: 'x_bisit_vrm_security_rating' },
            { key: 'rating_date', snKey: 'x_bisit_vrm_rating_date' },
            { key: 'u_is_vrm', snKey: 'x_bisit_vrm_is_vrm' },
        ];

        if (isVrm) {
            fieldsToCheck.push(
                { key: 'impact_score', snKey: 'x_bisit_vrm_impact_score' },
                { key: 'risk_score', snKey: 'x_bisit_vrm_risk_score' },
                { key: 'trust_score', snKey: 'x_bisit_vrm_trust_score' },
                { key: 'due_date', snKey: 'x_bisit_vrm_due_date' },
                { key: 'vendor_guid', snKey: 'x_bisit_vrm_vendor_guid' },
                { key: 'is_managed', snKey: 'x_bisit_vrm_is_managed' },
                { key: 'x_bisit_vrm_life_cycle_stage_name', snKey: 'x_bisit_vrm_life_cycle_stage_name' }
            );
        }

        let recordMismatches = 0;

        for (const f of fieldsToCheck) {
            const expVal = expected[f.key] !== undefined ? expected[f.key] : expected[f.snKey];
            const actVal = actual[f.snKey] !== undefined ? actual[f.snKey] : actual[f.key];

            const matches = areValuesEqual(expVal, actVal);

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
            is_vrm: isVrm,
            fieldsChecked: fieldsToCheck.length,
            mismatches: recordMismatches,
            status: recordMismatches === 0 ? 'MATCH' : 'MISMATCH',
        });
    }

    // -------------------------------------------------------------------------
    // Step 9: Print Structured Summary & Assertions
    // -------------------------------------------------------------------------
    console.log('\n================================================================');
    console.log('       TIER 2: 15-RECORD SAMPLE DEEP VALIDATION REPORT          ');
    console.log('================================================================');
    console.table(sampleValidationSummary);

    if (sampleFieldMismatches.length > 0) {
        console.log('\n--- SAMPLE FIELD MISMATCHES ---');
        console.table(sampleFieldMismatches);
    } else {
        console.log('\n✅ All 15 sampled records matched perfectly with Ground Truth!');
    }
    console.log('================================================================\n');

    expect.soft(
        sampleFieldMismatches.length,
        `Expected 0 field mismatches in 15-record sample, but found ${sampleFieldMismatches.length}. Mismatches: ${JSON.stringify(sampleFieldMismatches, null, 2)}`
    ).toBe(0);
});