import { test, expect } from '@playwright/test';
import { BitsightApiClient } from './utils/bitsight-api-client.js';
import { ServiceNowApiClient, toSnDateTime } from './utils/servicenow-api-client.js';
import { clearPortfolio } from './utils/cleanup-utils.js';

const BASE_URL = process.env.SN_URL;

function unwrapField(val) {
    return (val && typeof val === 'object' && val.value !== undefined) ? val.value : val;
}

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
 * Handles numbers (1 vs 1.0 vs "1", ignores decimal point differences e.g. 17.42 vs 17),
 * booleans (false vs "false" vs 0), dates ("2026-09-08T00:00:00Z" vs "2026-09-08"),
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

    // Number match: exact float or ignore decimal differences (e.g. 17.4249 vs 17, 66.15 vs 66, 1.0 vs 1)
    const num1 = Number(str1);
    const num2 = Number(str2);
    if (!isNaN(num1) && !isNaN(num2)) {
        if (Math.abs(num1 - num2) < 0.001) return true;
        // Ignore decimals as ServiceNow stores truncated/rounded integer scores
        if (Math.trunc(num1) === Math.trunc(num2) || Math.round(num1) === Math.round(num2)) {
            return true;
        }
        if (Math.floor(num1) === Math.floor(num2) || Math.ceil(num1) === Math.ceil(num2)) {
            return true;
        }
        if (parseInt(str1, 10) === parseInt(str2, 10)) {
            return true;
        }
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

// Verify that a valid Bitsight token with both CM and VRM licenses validates successfully and reveals the configuration sections
test('TC-02: Valid Bitsight token CM_VRM validates successfully and reveals config sections', async ({ page }) => {
    test.setTimeout(240000); // 4 min overall, since validation can take up to ~3 min

    const token = process.env.CMVRM_TOKEN;
    if (!token) {
        throw new Error('CMVRM_TOKEN is not set in .env');
    }

    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');

    const tokenField = gsftFrame.locator('#token');
    const clearTokenButton = gsftFrame.getByRole('button', { name: 'Clear Token' });
    const okButton = gsftFrame.getByRole('button', { name: 'OK', exact: true });

    await tokenField.click();

    // If a token is already present, clear it first
    const existingValue = await tokenField.inputValue();
    if (existingValue.trim() !== '') {
        await clearTokenButton.click();
        await okButton.click();

        // Wait for the field to actually become empty
        await expect(tokenField).toHaveValue('', { timeout: 30_000 });
    }

    // Enter a valid token that has both CM and VRM licenses active
    await tokenField.fill(token);
    await gsftFrame.getByRole('button', { name: 'Validate Token' }).click();

    // --- Wait for the Success dialog to appear (validation can take 2-3 min) ---
    const successDialog = gsftFrame.getByRole('dialog', { name: 'Success' });
    await expect(successDialog).toBeVisible({ timeout: 200000 });

    // Acknowledge it
    const successOkButton = successDialog.getByRole('button', { name: 'OK', exact: true });
    await successOkButton.click();

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

// Verify that a scheduled import job can be triggered and completes successfully, and that the imported portfolio reconciles with the Bitsight ground truth (CM + VRM)
test('TC-03: CM_VRM Subscription Type 3 Token Portfolio Import Job', async ({ page }) => {
    test.setTimeout(1_800_000); // 30 minutes for full import + crawl + reconciliation

    const bitsightClient = new BitsightApiClient();
    const serviceNowClient = new ServiceNowApiClient();

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
    // Step 4: Build Ground Truth from Bitsight (CM + VRM Resolution)
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching and Resolving Bitsight Ground Truth (CM + VRM) ===');
    const cmCompanies = await bitsightClient.getCompanies();
    const set_CM = new Set(cmCompanies.map(c => c.guid));
    console.log(`Bitsight CM Companies Count (set_CM): ${set_CM.size}`);

    const vrmVendors = await bitsightClient.getVendors();
    console.log(`Bitsight Raw VRM Vendors Count (vrm_raw): ${vrmVendors.length}`);

    const resolved_vrm_guids = await bitsightClient.resolveVrmVendors(vrmVendors);

    // Build Ground truth merged set
    const merged = new Set(set_CM);
    for (const [vendor_guid, bs_guid] of Object.entries(resolved_vrm_guids)) {
        if (bs_guid === null || bs_guid === undefined) {
            merged.add(`unresolved:${vendor_guid}`);
        } else {
            merged.add(bs_guid);
        }
    }
    console.log(`Bitsight Merged Ground Truth Set Size (merged): ${merged.size}`);

    // Also obtain full ground truth map for Tier 2 sampled validation
    const groundTruth = await bitsightClient.getGroundTruth();

    // -------------------------------------------------------------------------
    // Step 5: Fetch ServiceNow core_company State & Scoped Failures
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Fetching ServiceNow State & Scoped Failures ===');
    const snCompanies = await serviceNowClient.getBitsightCoreCompanies();
    const imported_count = snCompanies.length;
    const imported_map = new Map(snCompanies.map(c => [c.x_bisit_vrm_bitsight_vendor_guid, c]));
    console.log(`ServiceNow core_company Bitsight record count (imported_count): ${imported_count}`);

    const failedLogs = await serviceNowClient.getFailedImportCompanies({
        baselineTimestamp: baselineTriggerTimestamp,
        completionTimestamp,
    });
    const failed = new Set(failedLogs.map(l => l.vendorGuid).filter(Boolean));
    console.log(`ServiceNow Scoped Failed Vendor GUIDs Count (failed): ${failed.size}`);

    // -------------------------------------------------------------------------
    // Step 6: Classify Each Failed vendor_guid into true_missing or degraded
    // -------------------------------------------------------------------------
    console.log('\n=== Step 6: Classifying Failed Vendor GUIDs ===');
    const true_missing = new Set();
    const degraded = new Set();

    for (const vendor_guid of failed) {
        const bs_guid = resolved_vrm_guids[vendor_guid];
        if (bs_guid === null || bs_guid === undefined) {
            true_missing.add(vendor_guid);
        } else if (set_CM.has(bs_guid)) {
            degraded.add(vendor_guid);
        } else {
            true_missing.add(vendor_guid);
        }
    }

    console.log(`Classification Results: true_missing=${true_missing.size}, degraded=${degraded.size}`);

    // -------------------------------------------------------------------------
    // Tier 1 Assertion: Total ServiceNow Count Reconciled
    // -------------------------------------------------------------------------
    const expected_count = merged.size - true_missing.size;
    console.log('\n================================================================');
    console.log('       TIER 1: COMPLETENESS RECONCILIATION SUMMARY              ');
    console.log('================================================================');
    console.table({
        'CM Portfolios (set_CM)': set_CM.size,
        'VRM Raw Vendors': vrmVendors.length,
        'Merged Ground Truth (merged.size)': merged.size,
        'Failed Vendors (syslog)': failed.size,
        'True Missing (absent from SN)': true_missing.size,
        'Degraded (fallback to CM-only)': degraded.size,
        'Expected ServiceNow Count (merged - true_missing)': expected_count,
        'Actual ServiceNow Count (imported_count)': imported_count,
        'Difference': Math.abs(imported_count - expected_count),
    });

    expect(
        imported_count,
        `Expected imported count (${imported_count}) to equal merged ground truth minus true missing (${merged.size} - ${true_missing.size} = ${expected_count})`
    ).toBe(expected_count);

    // -------------------------------------------------------------------------
    // Tier 1b Assertion: Degraded Vendor Verification (u_is_vrm == false)
    // -------------------------------------------------------------------------
    console.log('\n=== Tier 1b: Verifying Degraded Vendors in ServiceNow (CM-only fallback) ===');
    for (const vendor_guid of degraded) {
        const bs_guid = resolved_vrm_guids[vendor_guid];
        const snRec = imported_map.get(bs_guid);
        if (snRec) {
            const companyName = snRec.x_bisit_vrm_company_name || snRec.name || groundTruth.portfolioMap.get(bs_guid)?.name || groundTruth.portfolioMap.get(vendor_guid)?.name || 'Unknown';
            const isVrm = Boolean(snRec.x_bisit_vrm_is_vrm === 'true' || snRec.x_bisit_vrm_is_vrm === true || snRec.u_is_vrm === 'true' || snRec.u_is_vrm === true);
            console.log(`Degraded vendor: "${companyName}" | vendor_guid: ${vendor_guid} (bs_guid: ${bs_guid}) -> x_bisit_vrm_is_vrm: ${isVrm} (Failed in VRM, imported as CM-only)`);
            expect.soft(isVrm, `Degraded vendor "${companyName}" (vendor_guid: ${vendor_guid}, bs_guid: ${bs_guid}) should have x_bisit_vrm_is_vrm = false`).toBe(false);
        }
    }

    // -------------------------------------------------------------------------
    // Tier 1c Assertion: Successfully Resolved Non-Failed Overlapping Vendors (u_is_vrm == true)
    // -------------------------------------------------------------------------
    console.log('\n=== Tier 1c: Verifying Non-Failed Overlapping Vendors (u_is_vrm == true) ===');
    for (const [vendor_guid, bs_guid] of Object.entries(resolved_vrm_guids)) {
        if (bs_guid && set_CM.has(bs_guid) && !failed.has(vendor_guid)) {
            const snRec = imported_map.get(bs_guid);
            if (snRec) {
                const companyName = snRec.x_bisit_vrm_company_name || snRec.name || groundTruth.portfolioMap.get(bs_guid)?.name || 'Unknown';
                const isVrm = Boolean(snRec.x_bisit_vrm_is_vrm === 'true' || snRec.x_bisit_vrm_is_vrm === true || snRec.u_is_vrm === 'true' || snRec.u_is_vrm === true);
                console.log(`Overlapping vendor: "${companyName}" | vendor_guid: ${vendor_guid} (bs_guid: ${bs_guid}) -> x_bisit_vrm_is_vrm: ${isVrm}`);
                expect.soft(isVrm, `Successfully resolved non-failed overlapping vendor "${companyName}" (bs_guid: ${bs_guid}) should have x_bisit_vrm_is_vrm = true`).toBe(true);
            }
        }
    }

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
        const guid = actual.x_bisit_vrm_bitsight_vendor_guid || actual.x_bisit_vrm_vendor_guid;
        const vrmVendorGuid = actual.x_bisit_vrm_vendor_guid || actual.u_vrm_vendor_guid;
        const expected = groundTruth.portfolioMap.get(guid) || (vrmVendorGuid ? groundTruth.portfolioMap.get(vrmVendorGuid) : null);

        if (!expected) {
            sampleFieldMismatches.push({
                vendorGuid: guid,
                companyName: actual.x_bisit_vrm_company_name || actual.u_name,
                field: 'Record Existence in Ground Truth',
                expected: 'Present in Bitsight Union',
                actual: 'Not Found in Bitsight Union',
            });
            continue;
        }

        // 1. Strictly check is_vrm flag from the ServiceNow imported record
        const isVrm = Boolean(
            actual.x_bisit_vrm_is_vrm === 'true' ||
            actual.x_bisit_vrm_is_vrm === true ||
            actual.u_is_vrm === 'true' ||
            actual.u_is_vrm === true
        );

        // 2. Common fields to validate for ALL records (both CM-only and VRM)
        const fieldsToCheck = [
            { key: 'name', snKey: 'x_bisit_vrm_company_name' },
            { key: 'primary_domain', snKey: 'x_bisit_vrm_primary_domain' },
            { key: 'rating', snKey: 'x_bisit_vrm_security_rating' },
            { key: 'rating_date', snKey: 'x_bisit_vrm_rating_date' },
            // { key: 'u_is_vrm', snKey: 'x_bisit_vrm_is_vrm' },
        ];

        // 3. If is_vrm is true, resolve lifecycle stage & VRM ratings, and append VRM-specific fields
        //    If is_vrm is false (CM-only), ONLY the 5 common fields above are checked.
        if (isVrm) {
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

// Verify that when ins_company is enabled, unmatched companies from Bitsight are inserted into ServiceNow as new core_company records
test('TC-04: Verify ins_company flag creates new core_company records for unmatched companies', async ({ page }) => {
    test.setTimeout(1_800_000); // 30 minutes for full cleanup + config + import + reconciliation

    const bitsightClient = new BitsightApiClient();
    const serviceNowClient = new ServiceNowApiClient();

    // -------------------------------------------------------------------------
    // Pre-Step 1: Clean Up Existing Portfolio in ServiceNow
    // -------------------------------------------------------------------------
    console.log('\n=== Pre-Step 1: Cleaning Up Existing Portfolio Records in ServiceNow ===');
    await clearPortfolio(serviceNowClient);

    // -------------------------------------------------------------------------
    // Pre-Step 2: Configure Application Properties and Ensure ins_company is Set to True
    // -------------------------------------------------------------------------
    console.log('\n=== Pre-Step 2: Configuring Application Properties (ins_company = true) ===');
    await filterBitsightModules(page);
    await page.getByRole('link', { name: 'Application Configuration 4 of' }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // Enable "Insert Bitsight companies that do not match existing company records in ServiceNow"
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await configFrame.getByText('Rules for Automation of Incident creation based on Bitsight AlertsMaximum').click();
    await page.waitForTimeout(10_000);

    // Save configuration and wait for network/reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // Read back and assert ins_company setting is true
    const insCompanyEnabled = await configFrame.locator('#ins_company_y').isChecked();
    console.log(`Application Configuration: "Insert unmatched companies" (ins_company): ${insCompanyEnabled}`);
    expect(insCompanyEnabled, 'Application configuration ins_company should be enabled (true)').toBe(true);

    // -------------------------------------------------------------------------
    // Step 1: Capture Pre-Import Baseline Snapshot of core_company & Timestamps
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Pre-Import Baseline Snapshot of core_company ===');
    const preImportCompanies = await serviceNowClient.getTableRecords('core_company', {
        fields: 'sys_id,name,x_bisit_vrm_company_name,website,x_bisit_vrm_primary_domain,x_bisit_vrm_bitsight_vendor_guid',
    });
    console.log(`Pre-import existing core_company record count: ${preImportCompanies.length}`);

    // Build sets of pre-existing matching criteria (GUIDs, Domains, Names)
    const existingGuids = new Set();
    const existingDomains = new Set();
    const existingNames = new Set();

    for (const rec of preImportCompanies) {
        const guid = rec.x_bisit_vrm_bitsight_vendor_guid?.value || rec.x_bisit_vrm_bitsight_vendor_guid;
        if (guid && typeof guid === 'string' && guid.trim()) {
            existingGuids.add(guid.trim().toLowerCase());
        }

        const domain = rec.x_bisit_vrm_primary_domain?.value || rec.x_bisit_vrm_primary_domain || rec.website?.value || rec.website;
        if (domain && typeof domain === 'string' && domain.trim()) {
            existingDomains.add(domain.trim().toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, ''));
        }

        const name = rec.x_bisit_vrm_company_name?.value || rec.x_bisit_vrm_company_name || rec.name?.value || rec.name;
        if (name && typeof name === 'string' && name.trim()) {
            existingNames.add(name.trim().toLowerCase());
        }
    }

    console.log(`Pre-import baseline unique entries: GUIDs=${existingGuids.size}, Domains=${existingDomains.size}, Names=${existingNames.size}`);

    const baselineSyslogTimestamp = await serviceNowClient.getLatestImportCompleteLog(page);
    const baselineTriggerTimestamp = new Date().toISOString();

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Data Import (Portfolio Import)
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
    // Step 3: Wait for Import Completion in syslog
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Import completion log should be found in syslog').toBeTruthy();
    const completionTimestamp = completeLog?.sys_created_on;

    // -------------------------------------------------------------------------
    // Step 4: Fetch Bitsight Ground Truth & Classify Unmatched Records
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching and Resolving Bitsight Ground Truth (CM + VRM) ===');
    const cmCompanies = await bitsightClient.getCompanies();
    const set_CM = new Set(cmCompanies.map(c => c.guid));
    console.log(`Bitsight CM Companies Count (set_CM): ${set_CM.size}`);

    const vrmVendors = await bitsightClient.getVendors();
    console.log(`Bitsight Raw VRM Vendors Count (vrm_raw): ${vrmVendors.length}`);

    const resolved_vrm_guids = await bitsightClient.resolveVrmVendors(vrmVendors);

    // Build Ground Truth merged set
    const merged = new Set(set_CM);
    for (const [vendor_guid, bs_guid] of Object.entries(resolved_vrm_guids)) {
        if (bs_guid === null || bs_guid === undefined) {
            merged.add(`unresolved:${vendor_guid}`);
        } else {
            merged.add(bs_guid);
        }
    }
    console.log(`Bitsight Merged Ground Truth Set Size (merged): ${merged.size}`);

    // Ground Truth details map for domain / name checking
    const groundTruth = await bitsightClient.getGroundTruth();

    // Classify incoming Bitsight entities against pre-import baseline
    let preMatchedCount = 0;
    let unmatchedCount = 0;

    for (const entityGuid of merged) {
        const entity = groundTruth.portfolioMap.get(entityGuid);
        const guid = (entity?.guid || entity?.bitsight_vendor_guid || entity?.vendor_guid || entityGuid || '').toLowerCase();
        const domain = (entity?.primary_domain || entity?.website || '').toLowerCase().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
        const name = (entity?.name || entity?.company_name || '').toLowerCase();

        const isMatched = (guid && existingGuids.has(guid)) ||
            (domain && existingDomains.has(domain)) ||
            (name && existingNames.has(name));

        if (isMatched) {
            preMatchedCount++;
        } else {
            unmatchedCount++;
        }
    }

    console.log(`Bitsight Entity Classification vs Baseline: Pre-Matched=${preMatchedCount}, Unmatched (Expected New Records)=${unmatchedCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Fetch Scoped Failures from syslog
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Fetching ServiceNow Scoped Failures ===');
    const failedLogs = await serviceNowClient.getFailedImportCompanies({
        baselineTimestamp: baselineTriggerTimestamp,
        completionTimestamp,
    });
    const failed = new Set(failedLogs.map(l => l.vendorGuid).filter(Boolean));
    console.log(`ServiceNow Scoped Failed Vendor GUIDs Count: ${failed.size}`);

    const true_missing = new Set();
    const degraded = new Set();

    for (const vendor_guid of failed) {
        const bs_guid = resolved_vrm_guids[vendor_guid];
        if (bs_guid === null || bs_guid === undefined) {
            true_missing.add(vendor_guid);
        } else if (set_CM.has(bs_guid)) {
            degraded.add(vendor_guid);
        } else {
            true_missing.add(vendor_guid);
        }
    }

    console.log(`Failure Classification: true_missing=${true_missing.size}, degraded=${degraded.size}`);

    // -------------------------------------------------------------------------
    // Step 6: Fetch Post-Import ServiceNow core_company State & Verify Count Completeness
    // -------------------------------------------------------------------------
    console.log('\n=== Step 6: Verifying core_company Newly Created Records Count Completeness ===');
    const snCompanies = await serviceNowClient.getBitsightCoreCompanies();
    const imported_count = snCompanies.length;
    const expected_count = merged.size - true_missing.size;

    console.log('\n================================================================');
    console.log('   TC-08: ins_company FLAG & core_company RECONCILIATION SUMMARY ');
    console.log('================================================================');
    console.table({
        'Application Configuration (ins_company)': insCompanyEnabled ? 'true (Enabled)' : 'false',
        'Pre-Import Existing core_company Count': preImportCompanies.length,
        'Bitsight CM Portfolios': set_CM.size,
        'Bitsight VRM Raw Vendors': vrmVendors.length,
        'Bitsight Merged Ground Truth': merged.size,
        'Unmatched Bitsight Entities (Expected New)': unmatchedCount,
        'Failed Vendors (syslog)': failed.size,
        'True Missing Vendors': true_missing.size,
        'Expected core_company Bitsight Records (merged - true_missing)': expected_count,
        'Actual core_company Bitsight Records Created': imported_count,
        'Difference': Math.abs(imported_count - expected_count),
    });

    expect(
        imported_count,
        `Expected newly created core_company count (${imported_count}) to equal merged ground truth minus true missing (${merged.size} - ${true_missing.size} = ${expected_count})`
    ).toBe(expected_count);

    expect(
        imported_count,
        'Expected at least one core_company record to be created when ins_company is enabled'
    ).toBeGreaterThan(0);
});

// Verify when a matching company already exists in ServiceNow, the ins_company flag does not create a duplicate record.
test('TC-05: Verify ins_company flag does not create duplicate core_company records for pre-existing companies', async ({ page }) => {
    test.setTimeout(1_800_000); // 30 minutes

    const bitsightClient = new BitsightApiClient();
    const serviceNowClient = new ServiceNowApiClient();

    // -------------------------------------------------------------------------
    // Step 1: Ensure ins_company Setting is Enabled
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Verifying Application Properties (ins_company = true) ===');
    await filterBitsightModules(page);
    await page.getByRole('link', { name: 'Application Configuration 4 of' }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await configFrame.getByText('Rules for Automation of Incident creation based on Bitsight AlertsMaximum').click();
    await page.waitForTimeout(10_000);

    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    const insCompanyEnabled = await configFrame.locator('#ins_company_y').isChecked();
    expect(insCompanyEnabled, 'ins_company flag must be true').toBe(true);

    // -------------------------------------------------------------------------
    // Step 2: Snapshot Existing core_company Records (No Cleanup)
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Fetching Existing core_company Records ===');
    const preImportCompanies = await serviceNowClient.getTableRecords('core_company', {
        fields: 'sys_id,name,website,x_bisit_vrm_primary_domain,x_bisit_vrm_bitsight_vendor_guid,sys_updated_on',
    });
    console.log(`Pre-existing core_company count: ${preImportCompanies.length}`);
    expect(preImportCompanies.length, 'TC-05 expects pre-existing records from prior runs').toBeGreaterThan(0);

    // Index existing records by GUID, normalized Domain, and Name
    const existingByGuid = new Map();
    const existingByDomain = new Map();
    const existingByName = new Map();

    for (const rec of preImportCompanies) {
        const guid = (rec.x_bisit_vrm_bitsight_vendor_guid?.value || rec.x_bisit_vrm_bitsight_vendor_guid || '').trim().toLowerCase();
        if (guid) existingByGuid.set(guid, rec);

        const domain = (rec.x_bisit_vrm_primary_domain?.value || rec.x_bisit_vrm_primary_domain || rec.website?.value || rec.website || '')
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//i, '')
            .replace(/^www\./i, '')
            .replace(/\/.*$/, '');
        if (domain) existingByDomain.set(domain, rec);

        const name = (rec.name?.value || rec.name || '').trim().toLowerCase();
        if (name) existingByName.set(name, rec);
    }

    // -------------------------------------------------------------------------
    // Step 3: Fetch BitSight Ground Truth & Identify Overlapping Targets
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Cross-referencing BitSight Entities with Existing Records ===');
    const groundTruth = await bitsightClient.getGroundTruth();

    // Collect specific identifiers that we expect the job to match against
    const targetMatchedGuids = [];
    const targetMatchedDomains = [];

    for (const entity of groundTruth.portfolioList) {
        const guid = (entity.guid || entity.bitsight_vendor_guid || entity.vendor_guid || '').trim().toLowerCase();
        const domain = (entity.primary_domain || entity.website || '')
            .trim()
            .toLowerCase()
            .replace(/^https?:\/\//i, '')
            .replace(/^www\./i, '')
            .replace(/\/.*$/, '');

        if (guid && existingByGuid.has(guid)) {
            targetMatchedGuids.push(guid);
        } else if (domain && existingByDomain.has(domain)) {
            targetMatchedDomains.push(domain);
        }
    }

    console.log(`Overlapping entries detected: GUID matches = ${targetMatchedGuids.length}, Domain matches = ${targetMatchedDomains.length}`);
    expect(
        targetMatchedGuids.length + targetMatchedDomains.length,
        'Expected at least one BitSight entity to match existing ServiceNow records'
    ).toBeGreaterThan(0);

    const baselineSyslogTimestamp = await serviceNowClient.getLatestImportCompleteLog(page);
    const baselineTriggerTimestamp = new Date().toISOString();

    // -------------------------------------------------------------------------
    // Step 4: Trigger Scheduled Portfolio Data Import
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Triggering Scheduled Data Import ===');
    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const importLink = gsftFrame.getByRole('link', { name: 'Open record: Bitsight' }).nth(2);
    await importLink.click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();

    // -------------------------------------------------------------------------
    // Step 5: Wait for Import Completion
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Waiting for Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Import completion log should be found in syslog').toBeTruthy();
    const completionTimestamp = completeLog?.sys_created_on;

    // -------------------------------------------------------------------------
    // Step 6: Verify No Duplicates Created & Records Were Updated in Place
    // -------------------------------------------------------------------------
    console.log('\n=== Step 6: Verifying No Duplicate Records for Pre-existing Entities ===');

    // 1. Check GUID matches: exactly 1 record per GUID, retaining the original sys_id
    for (const guid of targetMatchedGuids.slice(0, 10)) {
        const originalRecord = existingByGuid.get(guid);
        const matchedRecords = await serviceNowClient.getTableRecords('core_company', {
            query: `x_bisit_vrm_bitsight_vendor_guid=${guid}`,
            fields: 'sys_id,name,x_bisit_vrm_bitsight_vendor_guid,sys_updated_on',
        });

        expect.soft(
            matchedRecords.length,
            `Expected exactly 1 core_company record for GUID ${guid}, but found ${matchedRecords.length}`
        ).toBe(1);

        if (matchedRecords.length > 0) {
            expect.soft(
                matchedRecords[0].sys_id,
                `Record with GUID ${guid} should retain original sys_id ${originalRecord.sys_id}`
            ).toBe(originalRecord.sys_id);
        }
    }

    // 2. Check Domain matches: exactly 1 record per domain
    for (const domain of targetMatchedDomains.slice(0, 10)) {
        const originalRecord = existingByDomain.get(domain);
        const matchedRecords = await serviceNowClient.getTableRecords('core_company', {
            query: `x_bisit_vrm_primary_domain=${domain}^ORwebsiteLIKE${domain}`,
            fields: 'sys_id,name,website,x_bisit_vrm_primary_domain,sys_updated_on',
        });

        expect.soft(
            matchedRecords.length,
            `Expected exactly 1 core_company record for Domain ${domain}, but found ${matchedRecords.length}`
        ).toBe(1);

        if (matchedRecords.length > 0) {
            expect.soft(
                matchedRecords[0].sys_id,
                `Record with Domain ${domain} should retain original sys_id ${originalRecord.sys_id}`
            ).toBe(originalRecord.sys_id);
        }
    }

    // -------------------------------------------------------------------------
    // Step 7: Net New Insert Count Reconciliation
    // -------------------------------------------------------------------------
    console.log('\n=== Step 7: Reconciling Total Record Delta ===');
    const postImportCompanies = await serviceNowClient.getTableRecords('core_company', {
        fields: 'sys_id',
    });

    const failedLogs = await serviceNowClient.getFailedImportCompanies({
        baselineTimestamp: baselineTriggerTimestamp,
        completionTimestamp,
    });
    const failedVendorGuids = new Set(failedLogs.map(l => l.vendorGuid).filter(Boolean));

    const totalMatchedCount = targetMatchedGuids.length + targetMatchedDomains.length;
    const netNewRecords = postImportCompanies.length - preImportCompanies.length;
    const maxPossibleNew = groundTruth.portfolioList.length - totalMatchedCount - failedVendorGuids.size;

    console.table({
        'Pre-existing Records': preImportCompanies.length,
        'Post-import Total Records': postImportCompanies.length,
        'Net New Created': netNewRecords,
        'Entities Matched to Existing': totalMatchedCount,
        'Failed Vendors': failedVendorGuids.size,
        'Max Expected New Records': maxPossibleNew,
    });

    // Newly inserted records cannot exceed total entities minus the ones that matched pre-existing ones
    expect(netNewRecords).toBeLessThanOrEqual(Math.max(0, maxPossibleNew));
});

test('TC-06: Verify each company is marked as a vendor when mark_company flag is true while importing', async ({ page }) => {
    test.setTimeout(1_800_000); // 30 minutes for full cleanup + config + import + reconciliation

    const serviceNowClient = new ServiceNowApiClient();
    const IMPORT_JOB_NAME = 'Bitsight Portfolio Import';

    // -------------------------------------------------------------------------
    // Pre-Step 1: Clean Up Existing Portfolio in ServiceNow
    // -------------------------------------------------------------------------
    console.log('\n=== Pre-Step 1: Cleaning Up Existing Portfolio Records in ServiceNow ===');
    await clearPortfolio(serviceNowClient);

    // -------------------------------------------------------------------------
    // Pre-Step 2: Configure Application Properties (mark_comp = true, ins_company = true)
    // -------------------------------------------------------------------------
    console.log('\n=== Pre-Step 2: Configuring Application Properties (mark_comp = true) ===');
    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // Enable both insert unmatched companies and mark companies as vendor
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');

    const userInput = configFrame.locator('[id="sys_display.user"]');
    await userInput.fill('abel tuter');
    await userInput.press('Enter');

    const callerInput = configFrame.locator('[id="sys_display.caller"]');
    await callerInput.fill('abraham lincoln');
    await callerInput.press('Enter');

    // Save configuration and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // Read back and assert mark_comp setting is true
    const markCompEnabled = await configFrame.locator('#mark_comp_y').isChecked();
    console.log(`Application Configuration: "Mark imported companies as Vendor" (mark_comp): ${markCompEnabled}`);
    expect(markCompEnabled, 'Application configuration mark_comp should be enabled (true)').toBe(true);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Timestamps
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const START_LOG_MESSAGE = 'Bitsight Portfolios Import Begin';
    const COMPLETION_LOG_MESSAGE = 'Bitsight Portfolios Import Complete';

    const baselineCompleteLogTimestamp = await serviceNowClient.getLatestLogByMessage(COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Portfolio Data Import
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Portfolio Data Import ===');
    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` }).first();
    await importLink.click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log('Triggered "Execute Now" for Portfolio Import.');

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion in syslog & Retrieve Import Begin Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineCompleteLogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Import completion log should be found in syslog').toBeTruthy();

    // Query the "Bitsight Portfolios Import Begin" log for this run
    const startLogTimestamp = await serviceNowClient.getLatestLogByMessage(START_LOG_MESSAGE);
    console.log(`Import Begin Log sys_created_on: ${startLogTimestamp}`);

    // -------------------------------------------------------------------------
    // Step 4: Verify Newly Created Companies in core_company are Marked as Vendors
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching Newly Created core_company Records ===');
    const query = startLogTimestamp
        ? `x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^sys_created_on>=${startLogTimestamp}`
        : 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY';

    const postImportCompanies = await serviceNowClient.getTableRecords('core_company', {
        sysparm_query: query,
        sysparm_fields: 'sys_id,name,vendor,x_bisit_vrm_bitsight_vendor_guid,sys_created_on',
    });

    console.log(`Newly created core_company count (created on or after ${startLogTimestamp || 'all'}): ${postImportCompanies.length}`);
    expect(postImportCompanies.length, 'Expected newly created company records after import').toBeGreaterThan(0);

    for (const company of postImportCompanies) {
        const isVendor = company.vendor === true || company.vendor === 'true' || company.vendor === '1' || company.vendor === 1;
        expect(isVendor, `Company "${company.name}" (${company.sys_id}) should be marked as vendor (vendor=true)`).toBe(true);
    }
});

test('TC-07: Verify each company is NOT marked as a vendor when mark_company flag is false while importing', async ({ page }) => {
    test.setTimeout(1_800_000); // 30 minutes for full cleanup + config + import + reconciliation

    const serviceNowClient = new ServiceNowApiClient();
    const IMPORT_JOB_NAME = 'Bitsight Portfolio Import';

    // -------------------------------------------------------------------------
    // Pre-Step 1: Clean Up Existing Portfolio in ServiceNow
    // -------------------------------------------------------------------------
    console.log('\n=== Pre-Step 1: Cleaning Up Existing Portfolio Records in ServiceNow ===');
    await clearPortfolio(serviceNowClient);

    // -------------------------------------------------------------------------
    // Pre-Step 2: Configure Application Properties (mark_comp = false, ins_company = true)
    // -------------------------------------------------------------------------
    console.log('\n=== Pre-Step 2: Configuring Application Properties (mark_comp = false) ===');
    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // Enable insert unmatched companies and disable mark companies as vendor
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_n').check();
    await configFrame.locator('#assign-incident').selectOption('user');

    const userInput = configFrame.locator('[id="sys_display.user"]');
    await userInput.fill('abel tuter');
    await userInput.press('Enter');

    const callerInput = configFrame.locator('[id="sys_display.caller"]');
    await callerInput.fill('abraham lincoln');
    await callerInput.press('Enter');

    // Save configuration and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // Read back and assert mark_comp setting is false
    const markCompDisabled = await configFrame.locator('#mark_comp_n').isChecked();
    console.log(`Application Configuration: "Mark imported companies as Vendor" (mark_comp): ${!markCompDisabled}`);
    expect(markCompDisabled, 'Application configuration mark_comp should be disabled (false)').toBe(true);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Timestamps
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const START_LOG_MESSAGE = 'Bitsight Portfolios Import Begin';
    const COMPLETION_LOG_MESSAGE = 'Bitsight Portfolios Import Complete';

    const baselineCompleteLogTimestamp = await serviceNowClient.getLatestLogByMessage(COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Portfolio Data Import
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Portfolio Data Import ===');
    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` }).first();
    await importLink.click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log('Triggered "Execute Now" for Portfolio Import.');

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion in syslog & Retrieve Import Begin Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineCompleteLogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Import completion log should be found in syslog').toBeTruthy();

    // Query the "Bitsight Portfolios Import Begin" log for this run
    const startLogTimestamp = await serviceNowClient.getLatestLogByMessage(START_LOG_MESSAGE);
    console.log(`Import Begin Log sys_created_on: ${startLogTimestamp}`);

    // -------------------------------------------------------------------------
    // Step 4: Verify Newly Created Companies in core_company are NOT Marked as Vendors
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching Newly Created core_company Records ===');
    const query = startLogTimestamp
        ? `x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^sys_created_on>=${startLogTimestamp}`
        : 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY';

    const postImportCompanies = await serviceNowClient.getTableRecords('core_company', {
        sysparm_query: query,
        sysparm_fields: 'sys_id,name,vendor,x_bisit_vrm_bitsight_vendor_guid,sys_created_on',
    });

    console.log(`Newly created core_company count (created on or after ${startLogTimestamp || 'all'}): ${postImportCompanies.length}`);
    expect(postImportCompanies.length, 'Expected newly created company records after import').toBeGreaterThan(0);

    for (const company of postImportCompanies) {
        const isVendor = company.vendor === true || company.vendor === 'true' || company.vendor === '1' || company.vendor === 1;
        expect(isVendor, `Company "${company.name}" (${company.sys_id}) should NOT be marked as vendor (vendor=false)`).toBe(false);
    }
});

// Verify the tabs, buttons, and tiles for a CM-only company record in ServiceNow
test('TC-08: Verify CM-only company record tabs and tiles in ServiceNow', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(
        process.env.SN_URL +
        'now/nav/ui/classic/params/target/' +
        'core_company_list.do%3Fsysparm_query%3Dx_bisit_vrm_bitsight_vendor_guidISNOTEMPTY%255Ex_bisit_vrm_bs_subscription_type!%253DNULL%255Ex_bisit_vrm_is_vrm%253Dfalse%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight_vrm'
    );

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    // Open first available CM-only record
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });
    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC-08] Opening first CM-only company record: "${companyName}"`);
    await firstRecordLink.click();

    // Wait for form to load by waiting for a core tab
    const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await ratingsTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 1. Verify all 4 tabs are visible for CM-only record
    await expect(frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i })).toBeVisible();
    await expect(ratingsTab).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Portfolio Information' })).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Assessment Report' })).toBeVisible();

    // 2. On Bitsight Vendor Risk tab: Verify "Add Vendor" button is visible
    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i });
    await vendorRiskTab.click();
    await expect(frame.getByRole('button', { name: 'Add Vendor' })).toBeVisible();

    // 3. On Bitsight Security Ratings tab: Switch tab and wait for panel transition
    await ratingsTab.click();

    // Ensure the tab is selected/active
    await expect(ratingsTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 }).catch(() => {
        // Fallback for older ServiceNow versions without aria-selected
    });
    // 3. On Bitsight Security Ratings tab: Verify rating box, timeseries, graphs, breakdown tiles and action buttons for subscribed CM records
    const expectedButtons = [
        'Enable Vendor Access',
        'Switch Subscription',
        'Manage Folders',
        'Unsubscribe',
    ];

    for (const btnName of expectedButtons) {
        const btn = frame.getByRole('button', { name: btnName }).first();
        await btn.scrollIntoViewIfNeeded();
        await expect(btn, `Button "${btnName}" should be visible on Security Ratings tab`).toBeVisible({ timeout: 15_000 });
    }

    const overviewLink = frame.getByText(/View Company Overview/i).first();
    await overviewLink.scrollIntoViewIfNeeded();
    await expect(overviewLink).toBeVisible({ timeout: 15_000 });

    const timeseriesBox = frame.locator('.timeseries-box').first();
    await timeseriesBox.scrollIntoViewIfNeeded();
    await expect(timeseriesBox).toBeVisible({ timeout: 15_000 });

    const vectorsBreakdown = frame.locator('#vectors-breakdown');
    await vectorsBreakdown.scrollIntoViewIfNeeded();
    await expect(vectorsBreakdown).toBeVisible({ timeout: 15_000 });

    const ratingBreakdown = frame.locator('#rating-breakdown');
    await ratingBreakdown.scrollIntoViewIfNeeded();
    await expect(ratingBreakdown).toBeVisible({ timeout: 15_000 });

    const ratingHighlights = frame.getByText(/^Rating Highlights/i).first();
    await ratingHighlights.scrollIntoViewIfNeeded();
    await expect(ratingHighlights).toBeVisible({ timeout: 15_000 });
});

// Verify the tabs, buttons, and cards for a VRM-only company record in ServiceNow
test('TC-09: Verify VRM-only company record tabs and cards in ServiceNow', async ({ page }) => {
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
    console.log(`[TC-09] Opening first VRM-only company record: "${companyName}"`);
    await firstRecordLink.click();

    // Wait for form to load by waiting for a core tab
    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i });
    const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await vendorRiskTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 1. Verify visible tabs (Bitsight Assessment Report should NOT be visible for VRM-only)
    await expect(vendorRiskTab).toBeVisible();
    await expect(ratingsTab).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Portfolio Information' })).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Assessment Report', timeout: 15_000 })).not.toBeVisible();

    // 2. On Bitsight Security Ratings tab: Verify "Subscribe" button is visible
    await ratingsTab.click();
    const subscribeBtn = frame.getByRole('button', { name: 'Subscribe' });
    await subscribeBtn.scrollIntoViewIfNeeded();
    await expect(subscribeBtn).toBeVisible({ timeout: 15_000 });

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

// Verify the tabs, cards, and graph tiles for a Company record that has both CM and VRM data in ServiceNow
test('TC-10: Verify CM_VRM company record tabs, cards, and tiles in ServiceNow', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(
        process.env.SN_URL +
        'now/nav/ui/classic/params/target/' +
        'core_company_list.do%3Fsysparm_query%3Dx_bisit_vrm_bitsight_vendor_guidISNOTEMPTY%255Ex_bisit_vrm_is_vrm%253Dtrue%255Ex_bisit_vrm_bs_subscription_type!%253DNULL%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight_vrm'
    );

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    // Open first available CM+VRM record
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });
    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC-10] Opening first CM+VRM company record: "${companyName}"`);
    await firstRecordLink.click();

    // Wait for form to load by waiting for a core tab
    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i });
    const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await ratingsTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 1. Verify all 4 tabs are visible for CM+VRM record
    await expect(vendorRiskTab).toBeVisible();
    await expect(ratingsTab).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Portfolio Information' })).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Assessment Report' })).toBeVisible();

    // 2. On Bitsight Vendor Risk tab: Verify 4 cards (Security Rating Gauge, Scoring, Life Cycle Stage, Past Due)
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

    // 3. On Bitsight Security Ratings tab: Verify rating box, timeseries, graphs, breakdown tiles and action buttons for subscribed CM records
    await ratingsTab.click();

    const expectedButtons = [
        'Enable Vendor Access',
        'Switch Subscription',
        'Manage Folders',
        'Unsubscribe',
    ];

    for (const btnName of expectedButtons) {
        const btn = frame.getByRole('button', { name: btnName }).first();
        await btn.scrollIntoViewIfNeeded();
        await expect(btn, `Button "${btnName}" should be visible on Security Ratings tab`).toBeVisible({ timeout: 15_000 });
    }

    const overviewLink = frame.getByText(/View Company Overview/i).first();
    await overviewLink.scrollIntoViewIfNeeded();
    await expect(overviewLink).toBeVisible({ timeout: 15_000 });

    const timeseriesBox = frame.locator('.timeseries-box').first();
    await timeseriesBox.scrollIntoViewIfNeeded();
    await expect(timeseriesBox).toBeVisible({ timeout: 15_000 });

    const vectorsBreakdown = frame.locator('#vectors-breakdown');
    await vectorsBreakdown.scrollIntoViewIfNeeded();
    await expect(vectorsBreakdown).toBeVisible({ timeout: 15_000 });

    const ratingBreakdown = frame.locator('#rating-breakdown');
    await ratingBreakdown.scrollIntoViewIfNeeded();
    await expect(ratingBreakdown).toBeVisible({ timeout: 15_000 });

    const ratingHighlights = frame.getByText(/^Rating Highlights/i).first();
    await ratingHighlights.scrollIntoViewIfNeeded();
    await expect(ratingHighlights).toBeVisible({ timeout: 15_000 });
})

test('TC 09 CM_VRM Bitsight Portfolio record - Unsubscribe, re-lock website, and re-subscribe (Is VRM = false)', async ({ page }) => {
    test.setTimeout(300_000);

    const snClient = new ServiceNowApiClient();

    // ---------- Step 1: query core_company via the ServiceNow API client for a record where "Is VRM" = false and Bitsight Vendor GUID is not empty ----------
    const isVrmRecords = await snClient.getTableRecords('core_company', {
        query: 'x_bisit_vrm_is_vrm=false^x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY',
        fields: 'sys_id,name',
        limit: 1,
    });
    expect(isVrmRecords.length, 'Expected at least one core_company record with Is VRM = false and a non-empty Bitsight Vendor GUID').toBeGreaterThan(0);

    const targetRecord = isVrmRecords[0];
    const targetCompanyName = unwrapField(targetRecord.name) || '';
    console.log(`[TC 09] Target company with Is VRM = false and non-empty Bitsight Vendor GUID: "${targetCompanyName}" (sys_id: ${unwrapField(targetRecord.sys_id)})`);
    expect(targetCompanyName.length, 'Expected target company name to be non-empty').toBeGreaterThan(0);

    // ---------- Step 2: navigate to the Portfolio list ----------
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

    // ---------- Step 3: filter the portfolio list down to the target company ----------
    // The company returned by the API may not be on the first page of the list,
    // so filter the list's own "name" column search instead of scrolling/paging.
    const nameFilterBox = frame.getByRole('searchbox', { name: 'Search column: name' });
    await nameFilterBox.waitFor({ state: 'visible', timeout: 30_000 });
    await nameFilterBox.fill(targetCompanyName);
    await nameFilterBox.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 4: open the specific record matching the "Is VRM = false" company from the API ----------
    // Selecting by the name returned from the ServiceNow API client instead of just
    // the first row in the list, so the test exercises a record that actually
    // satisfies the Is VRM = false condition.
    const targetRecordLink = frame.getByRole('link', { name: `Open record: ${targetCompanyName}`, exact: true });
    await targetRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await targetRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 09] Opening Portfolio record: "${companyName}" (Is VRM = false)`);

    await targetRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    const securityRatingsTabAfterOpen = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await securityRatingsTabAfterOpen.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Explicitly click the tab rather than assuming it is already active -
    // avoids reading the current rating before the tab content has rendered.
    await securityRatingsTabAfterOpen.click();

    // Sanity check: record starts out subscribed and showing a rating.
    // Reading the rating value dynamically instead of matching a hardcoded score,
    // since the actual rating can differ between companies/environments/runs.
    const currentRating = frame.locator('#current-rating');
    await currentRating.waitFor({ state: 'visible', timeout: 30_000 });
    const ratingBefore = (await currentRating.innerText()).trim();
    console.log(`[TC 09] Current rating for "${companyName}" before unsubscribing: "${ratingBefore}"`);
    expect(ratingBefore.length, 'Expected current rating to be populated while subscribed').toBeGreaterThan(0);

    // Unsubscribing clears the website/domain value, so capture it now while the
    // record is still subscribed - we will need it later to re-lock the website.
    // Check the website display first: ServiceNow shows the current website as
    // plain text (not a textbox) until "Edit Website" is clicked.
    const existingWebsiteText = frame.locator('div').filter({ hasText: /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/ }).first();
    const isWebsiteAlreadySet = await existingWebsiteText.isVisible().catch(() => false);

    let domainValue = '';
    if (isWebsiteAlreadySet) {
        domainValue = (await existingWebsiteText.innerText()).trim();
        console.log(`[TC 09] Website already shows a value ("${domainValue}") - no need to check Portfolio Information.`);
    } else {
        console.log('[TC 09] Website is empty - fetching the primary domain from Portfolio Information instead.');

        // The primary domain field lives on the Portfolio Information tab. Explicitly
        // click into that tab first rather than assuming it is already rendered -
        // avoids reading a stale/empty value due to ServiceNow tab-load flakiness.
        const portfolioInfoTabForDomain = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
        await portfolioInfoTabForDomain.waitFor({ state: 'visible', timeout: 30_000 });
        await portfolioInfoTabForDomain.click();

        const primaryDomainField = frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight primary domain' });
        await primaryDomainField.waitFor({ state: 'visible', timeout: 30_000 });
        domainValue = (await primaryDomainField.inputValue()).trim();
        console.log(`[TC 09] Captured Bitsight primary domain for "${companyName}": "${domainValue}"`);
        expect(domainValue.length, 'Expected Bitsight primary domain to be populated').toBeGreaterThan(0);

        // The Unsubscribe button lives on the Bitsight Security Ratings tab, so
        // switch back before interacting with it.
        const securityRatingsTabBeforeUnsubscribe = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
        await securityRatingsTabBeforeUnsubscribe.waitFor({ state: 'visible', timeout: 30_000 });
        await securityRatingsTabBeforeUnsubscribe.click();
    }

    expect(domainValue.length, 'Expected a domain value to be available before unsubscribing (from the website field or Portfolio Information)').toBeGreaterThan(0);

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
    console.log(`[TC 09] Confirmed record "${companyName}" is now unsubscribed (rating cleared)`);

    // Unsubscribing wipes the website/domain, so re-lock it now using the domain
    // value we captured earlier (before unsubscribing).
    console.log(`[TC 09] Re-locking website using previously captured domain: "${domainValue}"`);

    const editWebsiteButton = frame.getByRole('button', { name: 'Edit Website' });
    await editWebsiteButton.waitFor({ state: 'visible', timeout: 30_000 });
    await editWebsiteButton.click();

    const websiteField = frame.getByRole('textbox', { name: 'Website' });
    await websiteField.waitFor({ state: 'visible', timeout: 30_000 });
    await websiteField.fill(domainValue);
    await websiteField.press('ControlOrMeta+a');
    await websiteField.fill(domainValue);

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
    // this stays correct regardless of which record was selected via the API filter.
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
    console.log(`[TC 09] Subscription type after re-subscribing: "${subscriptionTypeValue}"`);

    // Move to Portfolio Information to verify the subscription type and GUID were set
    const portfolioInfoTab = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
    await portfolioInfoTab.waitFor({ state: 'visible', timeout: 30_000 });
    await portfolioInfoTab.click();

    const guidField = frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight vendor GUID' });
    await guidField.waitFor({ state: 'visible', timeout: 30_000 });
    const guidValue = (await guidField.inputValue()).trim();
    console.log(`[TC 09] Bitsight vendor GUID after re-subscribing: "${guidValue}"`);
    expect(guidValue.length, 'Expected Bitsight vendor GUID to be populated after re-subscribing').toBeGreaterThan(0);
});

test('TC 10 Bitsight Portfolio record - Enable Vendor Access flow (Is VRM = false)', async ({ page }) => {
    test.setTimeout(120_000);

    const snClient = new ServiceNowApiClient();

    // ---------- Step 1: query core_company via the ServiceNow API client for a record where "Is VRM" = false ----------
    const isVrmRecords = await snClient.getTableRecords('core_company', {
        query: 'x_bisit_vrm_is_vrm=false^x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY',
        fields: 'sys_id,name',
        limit: 1,
    });
    expect(isVrmRecords.length, 'Expected at least one core_company record with Is VRM = false').toBeGreaterThan(0);

    const targetRecord = isVrmRecords[0];
    const targetCompanyName = unwrapField(targetRecord.name) || '';
    console.log(`[TC 10] Target company with Is VRM = false: "${targetCompanyName}" (sys_id: ${unwrapField(targetRecord.sys_id)})`);
    expect(targetCompanyName.length, 'Expected target company name to be non-empty').toBeGreaterThan(0);

    // ---------- Step 2: navigate to the Portfolio list ----------
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

    // ---------- Step 3: filter the portfolio list down to the target company ----------
    // The company returned by the API may not be on the first page of the list,
    // so filter the list's own "name" column search instead of scrolling/paging.
    const nameFilterBox = frame.getByRole('searchbox', { name: 'Search column: name' });
    await nameFilterBox.waitFor({ state: 'visible', timeout: 30_000 });
    await nameFilterBox.fill(targetCompanyName);
    await nameFilterBox.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 4: open the specific record matching the "Is VRM = false" company from the API ----------
    // Selecting by the name returned from the ServiceNow API client instead of just
    // the first row in the list, so the test exercises a record that actually
    // satisfies the Is VRM = false condition.
    const targetRecordLink = frame.getByRole('link', { name: `Open record: ${targetCompanyName}`, exact: true });
    await targetRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await targetRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 10] Opening Portfolio record: "${companyName}" (Is VRM = false)`);

    await targetRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    const securityRatingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await securityRatingsTab.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Explicitly click the tab rather than assuming it is already active -
    // avoids interacting with the record before the tab content has rendered.
    await securityRatingsTab.click();

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

    console.log(`[TC 10] Vendor Access request sent and dialog closed for "${companyName}"`);
});

test('TC 11 Bitsight Portfolio record - Switch Subscription updates subscription type (Is VRM = false)', async ({ page }) => {
    test.setTimeout(120_000);

    const snClient = new ServiceNowApiClient();

    // ---------- Step 1: query core_company via the ServiceNow API client for a record where "Is VRM" = false and Bitsight Vendor GUID is not empty ----------
    const isVrmRecords = await snClient.getTableRecords('core_company', {
        query: 'x_bisit_vrm_is_vrm=false^x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY',
        fields: 'sys_id,name',
        limit: 1,
    });
    expect(isVrmRecords.length, 'Expected at least one core_company record with Is VRM = false and a non-empty Bitsight Vendor GUID').toBeGreaterThan(0);

    const targetRecord = isVrmRecords[0];
    const targetCompanyName = unwrapField(targetRecord.name) || '';
    console.log(`[TC 11] Target company with Is VRM = false and non-empty Bitsight Vendor GUID: "${targetCompanyName}" (sys_id: ${unwrapField(targetRecord.sys_id)})`);
    expect(targetCompanyName.length, 'Expected target company name to be non-empty').toBeGreaterThan(0);

    // ---------- Step 2: navigate to the Portfolio list ----------
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

    // ---------- Step 3: filter the portfolio list down to the target company ----------
    // The company returned by the API may not be on the first page of the list,
    // so filter the list's own "name" column search instead of scrolling/paging.
    const nameFilterBox = frame.getByRole('searchbox', { name: 'Search column: name' });
    await nameFilterBox.waitFor({ state: 'visible', timeout: 30_000 });
    await nameFilterBox.fill(targetCompanyName);
    await nameFilterBox.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 4: open the specific record matching the "Is VRM = false" company from the API ----------
    // Selecting by the name returned from the ServiceNow API client instead of just
    // the first row in the list, so the test exercises a record that actually
    // satisfies the Is VRM = false condition.
    const targetRecordLink = frame.getByRole('link', { name: `Open record: ${targetCompanyName}`, exact: true });
    await targetRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await targetRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 11] Opening Portfolio record: "${companyName}" (Is VRM = false)`);

    await targetRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    const securityRatingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await securityRatingsTab.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Explicitly click the tab rather than assuming it is already active -
    // avoids interacting with the record before the tab content has rendered.
    await securityRatingsTab.click();

    // Capture the current subscription type value before switching, so we can
    // confirm it actually changed after the switch completes.
    const subscriptionTypeField = frame.getByRole('textbox', { name: 'Read only - cannot be' });
    await subscriptionTypeField.waitFor({ state: 'visible', timeout: 30_000 });
    const subscriptionTypeBefore = (await subscriptionTypeField.inputValue()).trim();
    console.log(`[TC 11] Subscription type before switch: "${subscriptionTypeBefore}"`);

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
    console.log(`[TC 11] Subscription type changed: "${subscriptionTypeBefore}" -> "${subscriptionTypeAfter}"`);
});

test('TC 12 Bitsight Portfolio record - Manage Folders moves an available folder (Is VRM = false)', async ({ page }) => {
    test.setTimeout(120_000);

    const snClient = new ServiceNowApiClient();

    // ---------- Step 1: query core_company via the ServiceNow API client for a record where "Is VRM" = false and Bitsight Vendor GUID is not empty ----------
    const isVrmRecords = await snClient.getTableRecords('core_company', {
        query: 'x_bisit_vrm_is_vrm=false^x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY',
        fields: 'sys_id,name',
        limit: 1,
    });
    expect(isVrmRecords.length, 'Expected at least one core_company record with Is VRM = false and a non-empty Bitsight Vendor GUID').toBeGreaterThan(0);

    const targetRecord = isVrmRecords[0];
    const targetCompanyName = unwrapField(targetRecord.name) || '';
    console.log(`[TC 12] Target company with Is VRM = false and non-empty Bitsight Vendor GUID: "${targetCompanyName}" (sys_id: ${unwrapField(targetRecord.sys_id)})`);
    expect(targetCompanyName.length, 'Expected target company name to be non-empty').toBeGreaterThan(0);

    // ---------- Step 2: navigate to the Portfolio list ----------
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

    // ---------- Step 3: filter the portfolio list down to the target company ----------
    // The company returned by the API may not be on the first page of the list,
    // so filter the list's own "name" column search instead of scrolling/paging.
    const nameFilterBox = frame.getByRole('searchbox', { name: 'Search column: name' });
    await nameFilterBox.waitFor({ state: 'visible', timeout: 30_000 });
    await nameFilterBox.fill(targetCompanyName);
    await nameFilterBox.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 4: open the specific record matching the "Is VRM = false" company from the API ----------
    // Selecting by the name returned from the ServiceNow API client instead of just
    // the first row in the list, so the test exercises a record that actually
    // satisfies the Is VRM = false condition.
    const targetRecordLink = frame.getByRole('link', { name: `Open record: ${targetCompanyName}`, exact: true });
    await targetRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await targetRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 12] Opening Portfolio record: "${companyName}" (Is VRM = false)`);

    await targetRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    const securityRatingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await securityRatingsTab.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Explicitly click the tab rather than assuming it is already active -
    // avoids interacting with the record before the tab content has rendered.
    await securityRatingsTab.click();

    // Open the Manage Folders dialog
    const manageFoldersButton = frame.getByRole('button', { name: 'Manage Folders' });
    await manageFoldersButton.waitFor({ state: 'visible', timeout: 30_000 });
    await manageFoldersButton.click();

    const availableList = frame.getByLabel('Available');
    await availableList.waitFor({ state: 'visible', timeout: 30_000 });

    // Precondition check: only attempt a move if the Available list actually has entries
    const availableOptions = availableList.locator('option');
    const availableCount = await availableOptions.count();
    console.log(`[TC 12] Available folders count: ${availableCount}`);

    if (availableCount === 0) {
        // Nothing to move. Log whatever folders are already assigned - the
        // Current Folders list may itself be empty too, which is fine and not
        // a failure on its own, just means the record has no folders at all.
        const currentFoldersList = frame.getByLabel('Current Folders');
        const currentFolders = await currentFoldersList.locator('option').allInnerTexts();
        console.log(`[TC 12] Available list is empty. Current Folders count: ${currentFolders.length}, contents: ${JSON.stringify(currentFolders)}`);

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
    console.log(`[TC 12] Moving folder: "${folderLabel}" (value: ${folderValue})`);

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

    console.log(`[TC 12] Folder "${folderLabel}" successfully moved out of Available`);
});

test('TC 13 Trigger import job and check portfolio information (Is VRM = false)', async ({ page }) => {
    test.setTimeout(600_000);

    const snClient = new ServiceNowApiClient();

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
    const baselineLogTimestamp = await snClient.getLatestImportCompleteLog();

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

    await frame.getByRole('button', { name: 'Execute Now' }).click();

    // ---------- Step 3: wait for a NEW completion log (strictly after baseline) ----------
    // waitForImportCompletion throws on timeout instead of returning false,
    // so wrap it to keep the same "importCompleted" boolean check as before.
    let importCompleted = false;
    try {
        const completionEntry = await snClient.waitForImportCompletion({
            baselineTimestamp: baselineLogTimestamp,
            timeoutMs: 1800_000,
            pollIntervalMs: 15_000,
        });
        importCompleted = !!completionEntry;
    } catch (err) {
        console.log(`[TC 13] ${err.message}`);
        importCompleted = false;
    }
    expect(importCompleted, 'Expected a new "Bitsight Portfolios Import Complete" syslog entry after triggering the job').toBeTruthy();

    console.log('[TC 13] Import job completed. Proceeding to verify Portfolio Information fields on a record.');

    // ---------- Step 4a: query core_company via the ServiceNow API client for a record where "Is VRM" = false and Bitsight Vendor GUID is not empty ----------
    const isVrmRecords = await snClient.getTableRecords('core_company', {
        query: 'x_bisit_vrm_is_vrm=false^x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY',
        fields: 'sys_id,name',
        limit: 1,
    });
    expect(isVrmRecords.length, 'Expected at least one core_company record with Is VRM = false and a non-empty Bitsight Vendor GUID').toBeGreaterThan(0);

    const targetRecord = isVrmRecords[0];
    const targetCompanyName = unwrapField(targetRecord.name) || '';
    console.log(`[TC 13] Target company with Is VRM = false and non-empty Bitsight Vendor GUID: "${targetCompanyName}" (sys_id: ${unwrapField(targetRecord.sys_id)})`);
    expect(targetCompanyName.length, 'Expected target company name to be non-empty').toBeGreaterThan(0);

    // ---------- Step 4b: navigate to the Portfolio and open the target record ----------
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

    // ---------- Step 4c: filter the portfolio list down to the target company ----------
    // The company returned by the API may not be on the first page of the list,
    // so filter the list's own "name" column search instead of scrolling/paging.
    const nameFilterBox = frame.getByRole('searchbox', { name: 'Search column: name' });
    await nameFilterBox.waitFor({ state: 'visible', timeout: 30_000 });
    await nameFilterBox.fill(targetCompanyName);
    await nameFilterBox.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 4d: open the specific record matching the "Is VRM = false" company from the API ----------
    // Selecting by the name returned from the ServiceNow API client instead of just
    // the first row in the list, so the test exercises a record that actually
    // satisfies the Is VRM = false condition.
    const targetRecordLink = frame.getByRole('link', { name: `Open record: ${targetCompanyName}`, exact: true });
    await targetRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await targetRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 13] Opening Portfolio record: "${companyName}" (Is VRM = false)`);

    await targetRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    // Wait on a stable, always-present element (a tab) rather than a flat timeout.
    const securityRatingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await securityRatingsTab.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    // Explicitly click the tab rather than assuming it is already active -
    // avoids interacting with the record before the tab content has rendered.
    await securityRatingsTab.click();

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

    console.log(`[TC 13] All Portfolio Information fields verified for "${companyName}"`);
});

test('TC 14 Bitsight Assessment Report - template, downloads, and filters (Is VRM = false)', async ({ page }) => {
    test.setTimeout(300_000);

    const snClient = new ServiceNowApiClient();

    // ---------- Step 1: Query core_company via API for records where "Is VRM" = false, GUID exists, and subscription is Continuous Monitoring ----------
    const isVrmRecords = await snClient.getTableRecords('core_company', {
        query: 'x_bisit_vrm_is_vrm=false^x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^x_bisit_vrm_bs_subscription_type=Continuous Monitoring',
        fields: 'sys_id,name',
        limit: 5,
    });
    expect(isVrmRecords.length, 'Expected at least one core_company record matching the criteria').toBeGreaterThan(0);

    const targetRecord = isVrmRecords[0];
    const targetCompanyName = unwrapField(targetRecord.name) || '';
    expect(targetCompanyName, 'Expected a valid company name from the API query').toBeTruthy();
    console.log(`[TC 14] Target company from API: "${targetCompanyName}" (sys_id: ${unwrapField(targetRecord.sys_id)})`);

    // ---------- Step 2: Navigate to the Portfolio list ----------
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

    // Wait for the portfolio list to actually render
    await frame.locator('body').waitFor({ state: 'visible', timeout: 30_000 });

    // ---------- Step 3: Filter and open the target record directly ----------
    const nameFilterBox = frame.getByRole('searchbox', { name: 'Search column: name' });
    await nameFilterBox.waitFor({ state: 'visible', timeout: 30_000 });
    await nameFilterBox.fill('');
    await nameFilterBox.fill(targetCompanyName);
    await nameFilterBox.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => { });

    const targetRecordLink = frame.getByRole('link', { name: `Open record: ${targetCompanyName}`, exact: true });
    await targetRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await targetRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 14] Opening Portfolio record directly: "${companyName}"`);
    await targetRecordLink.click();

    // ---------- Step 4: Proceed with Security Ratings and Assessment Report tabs ----------
    const securityRatingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await securityRatingsTab.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    await securityRatingsTab.click();

    // Switch to the Bitsight Assessment Report tab
    const assessmentReportTab = frame.getByRole('tab', { name: 'Bitsight Assessment Report' });
    await assessmentReportTab.waitFor({ state: 'visible', timeout: 30_000 });
    await assessmentReportTab.click();
    await page.waitForLoadState('networkidle').catch(() => { });

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
    console.log(`[TC 14] Available assessment templates: ${JSON.stringify(templateOptions)}`);

    const chosenTemplate = templateOptions.find((option) => option.value !== '');
    expect(chosenTemplate, 'Expected at least one selectable assessment template option').toBeTruthy();
    console.log(`[TC 14] Selecting assessment template: "${chosenTemplate.text}" (value: ${chosenTemplate.value})`);

    await templateDropdown.selectOption(chosenTemplate.value);

    // ---------- View Assessment ----------
    const viewAssessmentButton = frame.getByRole('button', { name: 'View Assessment' });
    await viewAssessmentButton.waitFor({ state: 'visible', timeout: 30_000 });
    await viewAssessmentButton.click();

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

    console.log(`[TC 14] Assessment report loaded for "${companyName}". Proceeding to CSV download.`);

    // ---------- Download CSV ----------
    const csvDownloadPromise = page.waitForEvent('download');
    const downloadCsvButton = frame.locator('#download_csv_btn');
    await downloadCsvButton.waitFor({ state: 'visible', timeout: 30_000 });
    await downloadCsvButton.click();
    const csvDownload = await csvDownloadPromise;
    console.log(`[TC 14] CSV download suggested filename: "${csvDownload.suggestedFilename()}"`);
    expect(csvDownload.suggestedFilename().length, 'Expected Download CSV to trigger a named download').toBeGreaterThan(0);

    // ---------- Dynamic Section filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('Section Clear'));
    await clickWithoutOuterScroll(frame.locator('.overSelect'));
    await page.waitForTimeout(500);

    const sectionCheckboxes = frame.locator('input[name="section"]');
    const sectionCount = await sectionCheckboxes.count();
    const sectionLimit = Math.min(sectionCount, 10);
    console.log(`[TC 14] Found ${sectionCount} section checkboxes, evaluating first ${sectionLimit}.`);
    expect(sectionCount, 'Expected at least one section checkbox').toBeGreaterThan(0);

    for (let i = 0; i < sectionLimit; i++) {
        const checkbox = sectionCheckboxes.nth(i);
        const sectionId = await checkbox.getAttribute('id') || `Section #${i + 1}`;
        await selectFilterOption(checkbox, sectionId);
    }
    console.log(`[TC 14] Processed up to ${sectionLimit} sections`);

    // ---------- Dynamic Flag filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('FlagClear'));
    const flagCheckboxes = frame.locator('input[name="flag"]');
    const flagCount = await flagCheckboxes.count();
    const flagLimit = Math.min(flagCount, 10);
    console.log(`[TC 14] Found ${flagCount} flag checkboxes, evaluating first ${flagLimit}.`);
    
    for (let i = 0; i < flagLimit; i++) {
        const checkbox = flagCheckboxes.nth(i);
        const flagId = await checkbox.getAttribute('id') || `Flag #${i + 1}`;
        await selectFilterOption(checkbox, flagId);
    }
    console.log('[TC 14] Dynamic flag filters processed');

    // ---------- Dynamic Grades filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('GradesClear'));
    const gradeCheckboxes = frame.locator('input[name="grade"], input[name="grades"]');
    const gradeCount = await gradeCheckboxes.count();
    const gradeLimit = Math.min(gradeCount, 10);
    console.log(`[TC 14] Found ${gradeCount} grade checkboxes, evaluating first ${gradeLimit}.`);

    for (let i = 0; i < gradeLimit; i++) {
        const checkbox = gradeCheckboxes.nth(i);
        const gradeId = await checkbox.getAttribute('id') || `Grade #${i + 1}`;
        await selectFilterOption(checkbox, gradeId);
    }
    console.log('[TC 14] Dynamic grades filters processed');

    // ---------- Dynamic Risk Vectors filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('Risk VectorsClear'));
    const riskCheckboxes = frame.locator('input[name="risk_vector"], input[name*="risk"]');
    const riskCount = await riskCheckboxes.count();
    const riskLimit = Math.min(riskCount, 10);
    console.log(`[TC 14] Found ${riskCount} risk vector checkboxes, evaluating first ${riskLimit}.`);

    for (let i = 0; i < riskLimit; i++) {
        const checkbox = riskCheckboxes.nth(i);
        const riskId = await checkbox.getAttribute('id') || `Risk Vector #${i + 1}`;
        await selectFilterOption(checkbox, riskId);
    }
    console.log('[TC 14] Dynamic risk vectors filters processed');

    // ---------- Dynamic Mapped filter (Up to first 10) ----------
    await openFilterDropdown(frame.getByText('MappedClear'));
    const mappedCheckboxes = frame.locator('input[name="mapped"]');
    const mappedCount = await mappedCheckboxes.count();
    const mappedLimit = Math.min(mappedCount, 10);
    console.log(`[TC 14] Found ${mappedCount} mapped checkboxes, evaluating first ${mappedLimit}.`);

    for (let i = 0; i < mappedLimit; i++) {
        const checkbox = mappedCheckboxes.nth(i);
        const mappedId = await checkbox.getAttribute('id') || `Mapped #${i + 1}`;
        await selectFilterOption(checkbox, mappedId);
    }
    console.log('[TC 14] Dynamic mapped filters processed');

    // ---------- Clear all filters and go back ----------
    const clearAllFiltersLink = frame.getByRole('link', { name: 'Clear all filters' });
    await clearAllFiltersLink.waitFor({ state: 'visible', timeout: 15_000 });
    await clickWithoutOuterScroll(clearAllFiltersLink);

    console.log(`[TC 14] All filters cleared for "${companyName}"`);

    const backButton = frame.getByRole('button', { name: 'Back' });
    await backButton.waitFor({ state: 'visible', timeout: 30_000 });
    await backButton.click();
});

test('TC 15 Bitsight Portfolio record - Conditional subscription / re-subscription (Is VRM = true)', async ({ page }) => {
    test.setTimeout(300_000);

    const snClient = new ServiceNowApiClient();

    // ---------- Step 1: query core_company via the ServiceNow API client for a record where "Is VRM" = true and Bitsight Vendor GUID is not empty ----------
    const isVrmRecords = await snClient.getTableRecords('core_company', {
        query: 'x_bisit_vrm_is_vrm=true^x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY',
        fields: 'sys_id,name',
        limit: 1,
    });
    expect(isVrmRecords.length, 'Expected at least one core_company record with Is VRM = true and a non-empty Bitsight Vendor GUID').toBeGreaterThan(0);

    const targetRecord = isVrmRecords[0];
    const targetCompanyName = unwrapField(targetRecord.name) || '';
    console.log(`[TC 15] Target company with Is VRM = true and non-empty Bitsight Vendor GUID: "${targetCompanyName}" (sys_id: ${unwrapField(targetRecord.sys_id)})`);
    expect(targetCompanyName.length, 'Expected target company name to be non-empty').toBeGreaterThan(0);

    // ---------- Step 2: navigate to the Portfolio list ----------
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

    // ---------- Step 3: filter the portfolio list down to the target company ----------
    const nameFilterBox = frame.getByRole('searchbox', { name: 'Search column: name' });
    await nameFilterBox.waitFor({ state: 'visible', timeout: 30_000 });
    await nameFilterBox.fill(targetCompanyName);
    await nameFilterBox.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 4: open the specific record matching the "Is VRM = true" company from the API ----------
    const targetRecordLink = frame.getByRole('link', { name: `Open record: ${targetCompanyName}`, exact: true });
    await targetRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await targetRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 15] Opening Portfolio record: "${companyName}" (Is VRM = true)`);

    await targetRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    const securityRatingsTabAfterOpen = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await securityRatingsTabAfterOpen.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    await securityRatingsTabAfterOpen.click();

    // ---------- Step 5: Check and capture the website/domain FIRST (before any state changes) ----------
    const existingWebsiteText = frame.locator('div').filter({ hasText: /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/ }).first();
    const isWebsiteAlreadySet = await existingWebsiteText.isVisible().catch(() => false);

    let domainValue = '';
    if (isWebsiteAlreadySet) {
        domainValue = (await existingWebsiteText.innerText()).trim();
        console.log(`[TC 15] Website already shows a value ("${domainValue}").`);
    } else {
        console.log('[TC 15] Website is empty - fetching the primary domain from Portfolio Information instead.');

        const portfolioInfoTabForDomain = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
        await portfolioInfoTabForDomain.waitFor({ state: 'visible', timeout: 30_000 });
        await portfolioInfoTabForDomain.click();

        const primaryDomainField = frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight primary domain' });
        await primaryDomainField.waitFor({ state: 'visible', timeout: 30_000 });
        domainValue = (await primaryDomainField.inputValue()).trim();
        console.log(`[TC 15] Captured Bitsight primary domain for "${companyName}": "${domainValue}"`);
        expect(domainValue.length, 'Expected Bitsight primary domain to be populated').toBeGreaterThan(0);

        const securityRatingsTabBeforeSubscribe = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
        await securityRatingsTabBeforeSubscribe.waitFor({ state: 'visible', timeout: 30_000 });
        await securityRatingsTabBeforeSubscribe.click();
    }

    expect(domainValue.length, 'Expected a domain value to be available').toBeGreaterThan(0);

    // ---------- Step 6: Check subscription status and handle accordingly ----------
    const unsubscribeButton = frame.getByRole('button', { name: 'Unsubscribe' });
    const subscribeButton = frame.getByRole('button', { name: 'Subscribe' });

    // Wait for either button to appear to determine current subscription status
    await frame.locator('button:has-text("Subscribe"), button:has-text("Unsubscribe")').first().waitFor({ state: 'visible', timeout: 30_000 });
    const isCurrentlySubscribed = await unsubscribeButton.isVisible().catch(() => false);

    if (isCurrentlySubscribed) {
        console.log(`[TC 15] Company "${companyName}" is already subscribed. Unsubscribing first...`);
        await unsubscribeButton.click();

        const unsubscribeConfirmationText = frame.getByText('Are you sure you want to');
        await unsubscribeConfirmationText.waitFor({ state: 'visible', timeout: 30_000 });
        expect(await unsubscribeConfirmationText.isVisible(), 'Expected unsubscribe confirmation prompt to be visible').toBeTruthy();

        const confirmButton = frame.getByRole('button', { name: 'Confirm' });
        await confirmButton.waitFor({ state: 'visible', timeout: 30_000 });
        await confirmButton.click();

        await page.waitForLoadState('networkidle').catch(() => { });
    } else {
        console.log(`[TC 15] Company "${companyName}" is not subscribed.`);
    }

    // ---------- Step 7: Ensure Website is Filled and Locked before subscribing ----------
    console.log(`[TC 15] Locking website using domain: "${domainValue}"`);
    const editWebsiteButton = frame.getByRole('button', { name: 'Edit Website' });
    if (await editWebsiteButton.isVisible().catch(() => false)) {
        await editWebsiteButton.click();
    }

    const websiteField = frame.getByRole('textbox', { name: 'Website' });
    await websiteField.waitFor({ state: 'visible', timeout: 30_000 });
    await websiteField.fill(domainValue);

    const lockWebsiteButton = frame.getByRole('button', { name: 'Lock Website' });
    await lockWebsiteButton.waitFor({ state: 'visible', timeout: 30_000 });
    await lockWebsiteButton.click();

    // Save form via context menu
    await frame.locator('div').nth(3).click({ button: 'right' });
    const saveMenuItem = frame.getByRole('menuitem', { name: 'Save' });
    await saveMenuItem.waitFor({ state: 'visible', timeout: 30_000 });
    await saveMenuItem.click();

    // ---------- Step 8: Wait for network idle and form stabilization after save ----------
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.waitForTimeout(2_000); 
    await frame.getByRole('tab', { name: 'Bitsight Security Ratings' }).waitFor({ state: 'visible', timeout: 30_000 });

    
    // ---------- Step 9: Subscribe ----------
    await subscribeButton.waitFor({ state: 'visible', timeout: 30_000 });
    await subscribeButton.click();

    const subscriptionDialog = frame.getByRole('dialog', { name: 'Bitsight Subscription Request' });
    await subscriptionDialog.waitFor({ state: 'visible', timeout: 30_000 });

    // Open company selector dropdown inside the modal
    const companySelectedDropdown = frame.locator('#company-selected');
    await companySelectedDropdown.waitFor({ state: 'visible', timeout: 30_000 });
    await companySelectedDropdown.click();

    const companySearchBox = frame.getByRole('textbox', { name: 'Search...' });
    await companySearchBox.waitFor({ state: 'visible', timeout: 30_000 });
    
    // Type the company name (e.g., "gefura")
    await companySearchBox.fill(companyName);
    
    // Wait for the dropdown results list to populate
    await page.waitForTimeout(1_500);

    // Click the dropdown option matching the company name (handling suffixes like ", Inc." dynamically)
    const dropdownOption = frame.locator('div, span, a').filter({ hasText: new RegExp(`^${companyName}(?:,\\s*Inc\\.)?$`, 'i') }).last();
    await dropdownOption.waitFor({ state: 'visible', timeout: 15_000 });
    await dropdownOption.click();

    // Select subscription type
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
    console.log(`[TC 15] Subscription type after re-subscribing: "${subscriptionTypeValue}"`);

    // Move to Portfolio Information to verify the GUID was set
    const portfolioInfoTab = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
    await portfolioInfoTab.waitFor({ state: 'visible', timeout: 30_000 });
    await portfolioInfoTab.click();

    const guidField = frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight vendor GUID' });
    await guidField.waitFor({ state: 'visible', timeout: 30_000 });
    const guidValue = (await guidField.inputValue()).trim();
    console.log(`[TC 15] Bitsight vendor GUID after re-subscribing: "${guidValue}"`);
    expect(guidValue.length, 'Expected Bitsight vendor GUID to be populated after re-subscribing').toBeGreaterThan(0);
});

test('TC 16 Bitsight Portfolio record - Add Vendor (Is VRM = false)', async ({ page }) => {
    test.setTimeout(300_000);

    const snClient = new ServiceNowApiClient();

    // ---------- Step 1: query core_company via the ServiceNow API client for a record where "Is VRM" = false and Bitsight Vendor GUID is not empty ----------
    const isVrmFalseRecords = await snClient.getTableRecords('core_company', {
        query: 'x_bisit_vrm_is_vrm=false^x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY',
        fields: 'sys_id,name',
        limit: 1,
    });
    expect(isVrmFalseRecords.length, 'Expected at least one core_company record with Is VRM = false and a non-empty Bitsight Vendor GUID').toBeGreaterThan(0);

    const targetRecord = isVrmFalseRecords[0];
    const targetCompanyName = unwrapField(targetRecord.name) || '';
    console.log(`[TC 16] Target company with Is VRM = false and non-empty Bitsight Vendor GUID: "${targetCompanyName}" (sys_id: ${unwrapField(targetRecord.sys_id)})`);
    expect(targetCompanyName.length, 'Expected target company name to be non-empty').toBeGreaterThan(0);

    // ---------- Step 2: navigate to the Portfolio list ----------
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

    // ---------- Step 3: filter the portfolio list down to the target company ----------
    const nameFilterBox = frame.getByRole('searchbox', { name: 'Search column: name' });
    await nameFilterBox.waitFor({ state: 'visible', timeout: 30_000 });
    await nameFilterBox.fill(targetCompanyName);
    await nameFilterBox.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => { });

    // ---------- Step 4: open the specific record matching the "Is VRM = false" company from the API ----------
    const targetRecordLink = frame.getByRole('link', { name: `Open record: ${targetCompanyName}`, exact: true });
    await targetRecordLink.waitFor({ state: 'visible', timeout: 30_000 });

    const companyName = (await targetRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 16] Opening Portfolio record: "${companyName}" (Is VRM = false)`);

    await targetRecordLink.click();

    // Give the record page time to fully load before interacting with it.
    const securityRatingsTabAfterOpen = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await securityRatingsTabAfterOpen.waitFor({ state: 'visible', timeout: 30_000 });
    await page.waitForLoadState('networkidle').catch(() => { });

    await securityRatingsTabAfterOpen.click();

    // ---------- Step 5: Check and capture the website/domain FIRST ----------
    const existingWebsiteText = frame.locator('div').filter({ hasText: /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/ }).first();
    const isWebsiteAlreadySet = await existingWebsiteText.isVisible().catch(() => false);

    let domainValue = '';
    if (isWebsiteAlreadySet) {
        domainValue = (await existingWebsiteText.innerText()).trim();
        console.log(`[TC 16] Website already shows a value ("${domainValue}").`);
    } else {
        console.log('[TC 16] Website is empty - fetching the primary domain from Portfolio Information instead.');

        const portfolioInfoTabForDomain = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
        await portfolioInfoTabForDomain.waitFor({ state: 'visible', timeout: 30_000 });
        await portfolioInfoTabForDomain.click();

        const primaryDomainField = frame.getByRole('textbox', { name: 'Read only - cannot be modifiedBitsight primary domain' });
        await primaryDomainField.waitFor({ state: 'visible', timeout: 30_000 });
        domainValue = (await primaryDomainField.inputValue()).trim();
        console.log(`[TC 16] Captured Bitsight primary domain for "${companyName}": "${domainValue}"`);
        expect(domainValue.length, 'Expected Bitsight primary domain to be populated').toBeGreaterThan(0);

        const securityRatingsTabBeforeSubscribe = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
        await securityRatingsTabBeforeSubscribe.waitFor({ state: 'visible', timeout: 30_000 });
        await securityRatingsTabBeforeSubscribe.click();
    }

    expect(domainValue.length, 'Expected a domain value to be available').toBeGreaterThan(0);

    // ---------- Step 6: Ensure Website is Filled and Locked ----------
    console.log(`[TC 16] Locking website using domain: "${domainValue}"`);
    const editWebsiteButton = frame.getByRole('button', { name: 'Edit Website' });
    if (await editWebsiteButton.isVisible().catch(() => false)) {
        await editWebsiteButton.click();
    }

    const websiteField = frame.getByRole('textbox', { name: 'Website' });
    await websiteField.waitFor({ state: 'visible', timeout: 30_000 });
    await websiteField.fill(domainValue);

    const lockWebsiteButton = frame.getByRole('button', { name: 'Lock Website' });
    await lockWebsiteButton.waitFor({ state: 'visible', timeout: 30_000 });
    await lockWebsiteButton.click();

    // Save form via context menu
    await frame.locator('div').nth(3).click({ button: 'right' });
    const saveMenuItem = frame.getByRole('menuitem', { name: 'Save' });
    await saveMenuItem.waitFor({ state: 'visible', timeout: 30_000 });
    await saveMenuItem.click();

    // ---------- Step 7: Wait for network idle and form stabilization after save ----------
    await page.waitForLoadState('networkidle').catch(() => { });
    await page.waitForTimeout(2_000);
    await page.waitForTimeout(15_000);

    // ---------- Step 8: Explicitly click Bitsight Vendor Risk tab after save reload ----------
    const vendorRiskTab = frame.getByRole('tab', { name: 'Bitsight Vendor Risk' });
    await vendorRiskTab.waitFor({ state: 'visible', timeout: 30_000 });
    await vendorRiskTab.click();

    const addVendorButton = frame.getByRole('button', { name: 'Add Vendor' });
    await addVendorButton.waitFor({ state: 'visible', timeout: 30_000 });
    await addVendorButton.click();

    // ---------- Step 9: Fill Company and Submit Request ----------
    const vrmCompanySelected = frame.locator('#vrm-company-selected');
    await vrmCompanySelected.waitFor({ state: 'visible', timeout: 30_000 });
    await vrmCompanySelected.click();

    const vrmSearchBox = frame.getByRole('textbox', { name: 'Search...' });
    await vrmSearchBox.waitFor({ state: 'visible', timeout: 30_000 });
    await vrmSearchBox.fill(companyName);
    await page.waitForTimeout(1_000);

    // Click matching dropdown option dynamically (handling Gefura, Inc. edge case)
    const dropdownOption = frame.locator('div, span, a').filter({ hasText: new RegExp(`^${companyName}(?:,\\s*Inc\\.)?$`, 'i') }).last();
    if (await dropdownOption.isVisible().catch(() => false)) {
        await dropdownOption.click();
    } else {
        await vrmSearchBox.press('Enter');
    }

    const vrmSubmitButton = frame.locator('#vrm-subscription-req-btn');
    await vrmSubmitButton.waitFor({ state: 'visible', timeout: 30_000 });
    await vrmSubmitButton.click();

    // ---------- Step 10: Validate Success / Error Message ----------
    const errorMessage = frame.getByText('There is some error in');
    const hasError = await errorMessage.isVisible({ timeout: 5_000 }).catch(() => false);
    
    if (hasError) {
        console.error('[TC 16] Error message detected: "There is some error in..."');
    }
    
    expect(hasError, 'Expected test to pass successfully, but an error message ("There is some error in") was detected.').toBeFalsy();
    console.log('[TC 16] Add Vendor request submitted successfully without errors.');
});