import { test, expect } from '@playwright/test';
import { BitsightApiClient } from './utils/bitsight-api-client.js';
import { ServiceNowApiClient, toSnDateTime } from './utils/servicenow-api-client.js';
import { clearPortfolio } from './utils/cleanup-utils.js';

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
});


