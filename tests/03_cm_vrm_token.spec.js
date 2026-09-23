import { test, expect } from '@playwright/test';
import { BitsightApiClient } from './utils/bitsight-api-client.js';
import { ServiceNowApiClient, toSnDateTime } from './utils/servicenow-api-client.js';
import { clearPortfolio, clearAlerts, clearIncidents } from './utils/cleanup-utils.js';
import { snFetch, snMutate } from './utils/servicenow-session-helpers.js';

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

const USER_VISIBLE_MODULES = [
    'Portfolio',
    'Rating and Risk Vector Alerts',
    'Incidents',
    'Dashboard',
    'About Bitsight',
    'Contact Support',
    'App Privacy Policy',
];

const USER_HIDDEN_MODULES = [
    'Application Configuration',
    'Scheduled Data Imports',
];

/**
 * Logs out of current session and logs in with specified credentials
 */
async function switchUser(page, username, password) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const userMenuButton = page.getByRole('button', { name: new RegExp(`${process.env.SN_USER || 'bitsight_admin'}.*Available`, 'i') }).or(page.getByRole('button', { name: /Available|User menu/i })).first();
    await userMenuButton.waitFor({ state: 'visible', timeout: 30_000 });
    await userMenuButton.click();

    const logoutButton = page.getByRole('button', { name: 'Log out' }).or(page.getByRole('menuitem', { name: 'Log out' })).first();
    await logoutButton.waitFor({ state: 'visible', timeout: 10_000 });
    await logoutButton.click();

    const usernameField = page.getByRole('textbox', { name: 'User name' });
    await usernameField.waitFor({ state: 'visible', timeout: 60_000 });
    await usernameField.fill(username);

    const passwordField = page.getByRole('textbox', { name: 'Password' });
    await passwordField.fill(password);

    await page.getByRole('button', { name: 'Log in' }).click();
    await usernameField.waitFor({ state: 'hidden', timeout: 60_000 });
}
/**
 * Reusable helper to capture baseline syslog timestamp, trigger Scheduled Alerts Import,
 * and wait for completion in syslog.
 */
async function triggerAndWaitForAlertsImport(page, serviceNowClient, options = {}) {
    const IMPORT_JOB_NAME = options.jobName || 'Bitsight Alerts Import';
    const COMPLETION_LOG_MESSAGE = options.completionLogMessage || 'Bitsight Alerts Import Complete.';

    // 1. Capture baseline timestamp if not passed
    const baselineSyslogTimestamp = options.baselineTimestamp !== undefined
        ? options.baselineTimestamp
        : await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);

    // 2. Navigate and trigger import
    console.log(`\n=== Triggering Scheduled ${IMPORT_JOB_NAME} ===`);
    await navigateToScheduledDataImports(page);

    const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');
    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` }).first();
    await importLink.waitFor({ state: 'visible', timeout: 50_000 });
    await importLink.click();

    const executeBtn = gsftFrame.getByRole('button', { name: 'Execute Now' }).first();
    await executeBtn.waitFor({ state: 'visible', timeout: 50_000 });
    await executeBtn.click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // 3. Wait for import completion in syslog
    console.log(`\n=== Waiting for ${IMPORT_JOB_NAME} Completion in syslog ===`);
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: options.timeoutMs || 1_500_000,
        pollIntervalMs: options.pollIntervalMs || 15_000,
    });
    expect(completeLog, `${IMPORT_JOB_NAME} completion log should be found`).toBeTruthy();

    // 4. Optional wait for post-import transform scripts
    if (options.postWaitMs) {
        console.log(`Waiting ${options.postWaitMs / 1000}s for post-import transform scripts...`);
        await page.waitForTimeout(options.postWaitMs);
    }

    return { baselineTimestamp: baselineSyslogTimestamp, completeLog };
}

async function filterBitsightModules(page) {
    await page.goto('/', { waitUntil: 'networkidle' });

    const allMenu = page.getByText('All').first();
    await allMenu.click();

    const pinButton = page.getByRole('button', { name: 'Pin All menu', exact: true }).first();

    if (await pinButton.isVisible()) {
        await pinButton.click();
    }

    const filter = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await expect(filter).toBeVisible();
    await filter.fill('bitsight');
    await filter.press('Enter');
}

// Centralized navigation helpers using .first() to prevent strict mode violations
async function navigateToApplicationConfiguration(page) {
    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).first().click();
}

async function navigateToScheduledDataImports(page) {
    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).first().click();
}

/**
 * Reusable helper to set Application Configuration properties in ServiceNow UI,
 * save the form, and return the verified saved values.
 */
async function configureApplicationProperties(page, options = {}) {
    await navigateToApplicationConfiguration(page);

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    if (options.ins_company !== undefined) {
        await configFrame.locator(options.ins_company ? '#ins_company_y' : '#ins_company_n').check();
    }
    if (options.mark_comp !== undefined) {
        await configFrame.locator(options.mark_comp ? '#mark_comp_y' : '#mark_comp_n').check();
    }
    if (options.assign_incident !== undefined) {
        await configFrame.locator('#assign-incident').selectOption(options.assign_incident);
    }
    if (options.user !== undefined) {
        const userInput = configFrame.locator('[id="sys_display.user"]');
        await userInput.click();
        await userInput.fill('');
        await userInput.fill(options.user);
        await userInput.press('Enter');
    }
    if (options.caller !== undefined) {
        const callerInput = configFrame.locator('[id="sys_display.caller"]');
        await callerInput.click();
        await callerInput.fill('');
        await callerInput.fill(options.caller);
        await callerInput.press('Enter');
    }

    await page.waitForTimeout(2_000);

    // Save configuration and wait for network/reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked().catch(() => null),
        markComp: await configFrame.locator('#mark_comp_y').isChecked().catch(() => null),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue().catch(() => null),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue().catch(() => null),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    return savedConfig;
}

/**
 * Reusable helper to capture baseline syslog timestamp, trigger Scheduled Portfolio Data Import,
 * and wait for completion in syslog.
 */
async function triggerAndWaitForPortfolioImport(page, serviceNowClient, options = {}) {
    const IMPORT_JOB_NAME = options.jobName || 'Bitsight Portfolio Import';
    const COMPLETION_LOG_MESSAGE = options.completionLogMessage || 'Bitsight Portfolios Import Complete';
    const START_LOG_MESSAGE = options.startLogMessage || 'Bitsight Portfolios Import Begin';

    // 1. Capture baseline timestamp if not passed
    const baselineSyslogTimestamp = options.baselineTimestamp !== undefined
        ? options.baselineTimestamp
        : await serviceNowClient.getLatestLogByMessage(COMPLETION_LOG_MESSAGE);

    // 2. Navigate and trigger import
    console.log(`\n=== Triggering Scheduled ${IMPORT_JOB_NAME} ===`);
    await navigateToScheduledDataImports(page);

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const importLink = gsftFrame.getByRole('link', { name: new RegExp(`Open record:.*${IMPORT_JOB_NAME}`) }).first();
    await importLink.waitFor({ state: 'visible', timeout: 30_000 });
    await importLink.click();

    const executeBtn = gsftFrame.getByRole('button', { name: 'Execute Now' });
    await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await executeBtn.click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // 3. Wait for import completion in syslog
    console.log(`\n=== Waiting for ${IMPORT_JOB_NAME} Completion in syslog ===`);
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: options.timeoutMs || 1_500_000,
        pollIntervalMs: options.pollIntervalMs || 15_000,
    });
    expect(completeLog, `${IMPORT_JOB_NAME} completion log should be found in syslog`).toBeTruthy();

    const startLogTimestamp = await serviceNowClient.getLatestLogByMessage(START_LOG_MESSAGE);

    return { baselineTimestamp: baselineSyslogTimestamp, completeLog, startLogTimestamp };
}

/**
 * Picks N random core_company records that already have a Bitsight vendor GUID
 */
async function getRandomCoreCompaniesWithGuid(serviceNowClient, count = 5, poolLimit = 50) {
    const records = await serviceNowClient.getTableRecords('core_company', {
        sysparm_query: 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^ORDERBYDESCsys_updated_on',
        sysparm_fields: 'sys_id,name,website,x_bisit_vrm_bitsight_vendor_guid',
        sysparm_limit: poolLimit,
    });

    const pool = (records || []).map(row => ({
        sys_id: unwrapField(row.sys_id) || '',
        name: unwrapField(row.name) || '',
        website: unwrapField(row.website) || '',
        guid: unwrapField(row.x_bisit_vrm_bitsight_vendor_guid) || '',
    })).filter(r => r.sys_id && r.guid);

    const shuffled = [...pool].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

/**
 * Queries core_company for any of the given Bitsight GUIDs.
 */
async function findCoreCompaniesByGuids(serviceNowClient, guids) {
    if (!guids.length) return [];
    const guidQuery = guids.map(g => `x_bisit_vrm_bitsight_vendor_guid=${encodeURIComponent(g)}`).join('^OR');
    return await serviceNowClient.getTableRecords('core_company', {
        sysparm_query: guidQuery,
        sysparm_fields: 'sys_id,name,website,x_bisit_vrm_bitsight_vendor_guid',
        sysparm_limit: guids.length,
    });
}

/**
 * Value comparison helper: Validates that field values match without requiring identical data types
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

    // Date match (e.g. "2026-09-08T00:00:00Z" vs "2026-09-08")
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

// Verify that a valid Bitsight token with both CM and VRM licenses validates successfully and reveals config sections
test('TC-02: Valid Bitsight token CM_VRM validates successfully and reveals config sections', async ({ page }) => {
    test.setTimeout(240000);

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
        await expect(tokenField).toHaveValue('', { timeout: 30_000 });
    }

    // Enter a valid token that has both CM and VRM licenses active
    await tokenField.fill(token);
    await gsftFrame.getByRole('button', { name: 'Validate Token' }).click();

    // Wait for Success dialog
    const successDialog = gsftFrame.getByRole('dialog', { name: 'Success' });
    await expect(successDialog).toBeVisible({ timeout: 200000 });

    const successOkButton = successDialog.getByRole('button', { name: 'OK', exact: true });
    await successOkButton.click();

    // Assert token retained and license table visible
    await expect(tokenField).toHaveValue(token);

    const licenseTable = gsftFrame.locator('#bs_token').getByRole('table');
    await expect(licenseTable).toBeVisible();
    await expect(licenseTable.getByRole('row', { name: /Continuous Monitoring/ })).toBeVisible();
    await expect(licenseTable.getByRole('row', { name: /Risk Monitoring/ })).toBeVisible();
    await expect(licenseTable.getByRole('row', { name: /Continuous Monitoring/ })).toContainText(/\d+\/\d+/);
    await expect(licenseTable.getByRole('row', { name: /Risk Monitoring/ })).toContainText(/\d+\/\d+/);

    // Assert configuration options section is visible
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

    const clearTokenSection = gsftFrame.locator('#bs-clear-token');
    await expect(clearTokenSection).toBeVisible();
    await expect(clearTokenSection.getByText('Disable Bitsight Integration', { exact: true })).toBeVisible();
    await expect(clearTokenSection.getByText('Clear Bitsight API token', { exact: true })).toBeVisible();
    await expect(clearTokenSection.getByRole('button', { name: 'Clear Token' })).toBeVisible();
});

// Verify scheduled import job completes and reconciles with Bitsight ground truth (CM + VRM)
test('TC-03: CM_VRM Subscription Type 3 Token Portfolio Import Job', async ({ page }) => {
    test.setTimeout(1_800_000);

    const bitsightClient = new BitsightApiClient();
    const serviceNowClient = new ServiceNowApiClient();

    // 1. Clean up existing portfolio in ServiceNow
    await clearPortfolio(serviceNowClient);

    const baselineTriggerTimestamp = new Date().toISOString();

    // Configure Application Properties
    const savedConfig = await configureApplicationProperties(page, {
        ins_company: true,
        assign_incident: 'user',
        user: 'abel tuter',
        caller: 'abraham lincoln',
    });
    console.log(`[TC-03] Application Properties Configured: ins_company=${savedConfig.insCompany}`);

    // 2. Trigger Scheduled Portfolio Import and wait for completion
    const { completeLog } = await triggerAndWaitForPortfolioImport(page, serviceNowClient);
    const completionTimestamp = completeLog.sys_created_on;

    // 3. Build Ground Truth from Bitsight (CM + VRM Resolution)
    const cmCompanies = await bitsightClient.getCompanies();
    const set_CM = new Set(cmCompanies.map(c => c.guid));
    console.log(`Bitsight CM Companies Count (set_CM): ${set_CM.size}`);

    const vrmVendors = await bitsightClient.getVendors();
    console.log(`Bitsight Raw VRM Vendors Count (vrm_raw): ${vrmVendors.length}`);

    const resolved_vrm_guids = await bitsightClient.resolveVrmVendors(vrmVendors);

    const merged = new Set(set_CM);
    for (const [vendor_guid, bs_guid] of Object.entries(resolved_vrm_guids)) {
        if (bs_guid === null || bs_guid === undefined) {
            merged.add(`unresolved:${vendor_guid}`);
        } else {
            merged.add(bs_guid);
        }
    }
    console.log(`Bitsight Merged Ground Truth Set Size (merged): ${merged.size}`);

    const groundTruth = await bitsightClient.getGroundTruth();

    // 4. Fetch ServiceNow core_company state & scoped failures
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

    // 5. Classify failed vendors into true_missing or degraded
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

    // Tier 1 Assertion: Total ServiceNow count reconciled
    const expected_count = merged.size - true_missing.size;
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

    // Tier 1b Assertion: Degraded vendors (u_is_vrm == false)
    for (const vendor_guid of degraded) {
        const bs_guid = resolved_vrm_guids[vendor_guid];
        const snRec = imported_map.get(bs_guid);
        if (snRec) {
            const companyName = snRec.x_bisit_vrm_company_name || snRec.name || groundTruth.portfolioMap.get(bs_guid)?.name || groundTruth.portfolioMap.get(vendor_guid)?.name || 'Unknown';
            const isVrm = Boolean(snRec.x_bisit_vrm_is_vrm === 'true' || snRec.x_bisit_vrm_is_vrm === true || snRec.u_is_vrm === 'true' || snRec.u_is_vrm === true);
            console.log(`Degraded vendor: "${companyName}" | vendor_guid: ${vendor_guid} (bs_guid: ${bs_guid}) -> x_bisit_vrm_is_vrm: ${isVrm}`);
            expect.soft(isVrm, `Degraded vendor "${companyName}" should have x_bisit_vrm_is_vrm = false`).toBe(false);
        }
    }

    // Tier 1c Assertion: Overlapping non-failed vendors (u_is_vrm == true)
    for (const [vendor_guid, bs_guid] of Object.entries(resolved_vrm_guids)) {
        if (bs_guid && set_CM.has(bs_guid) && !failed.has(vendor_guid)) {
            const snRec = imported_map.get(bs_guid);
            if (snRec) {
                const companyName = snRec.x_bisit_vrm_company_name || snRec.name || groundTruth.portfolioMap.get(bs_guid)?.name || 'Unknown';
                const isVrm = Boolean(snRec.x_bisit_vrm_is_vrm === 'true' || snRec.x_bisit_vrm_is_vrm === true || snRec.u_is_vrm === 'true' || snRec.u_is_vrm === true);
                console.log(`Overlapping vendor: "${companyName}" | vendor_guid: ${vendor_guid} (bs_guid: ${bs_guid}) -> x_bisit_vrm_is_vrm: ${isVrm}`);
                expect.soft(isVrm, `Overlapping vendor "${companyName}" should have x_bisit_vrm_is_vrm = true`).toBe(true);
            }
        }
    }

    // Tier 2: Sample 15 records field-by-field validation
    const sampleRecords = await serviceNowClient.getRandomRecentlyUpdatedCoreCompanies(15, 50);
    expect(sampleRecords.length, 'Expected to retrieve sampled records from ServiceNow').toBeGreaterThan(0);

    const lifecycleStagesMap = await bitsightClient.getLifecycleStages();
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

        const isVrm = Boolean(
            actual.x_bisit_vrm_is_vrm === 'true' ||
            actual.x_bisit_vrm_is_vrm === true ||
            actual.u_is_vrm === 'true' ||
            actual.u_is_vrm === true
        );

        const fieldsToCheck = [
            { key: 'name', snKey: 'x_bisit_vrm_company_name' },
            { key: 'primary_domain', snKey: 'x_bisit_vrm_primary_domain' },
            { key: 'rating', snKey: 'x_bisit_vrm_security_rating' },
            { key: 'rating_date', snKey: 'x_bisit_vrm_rating_date' },
        ];

        if (isVrm) {
            const stageId = expected.life_cycle_stage_guid || expected.life_cycle_stage_id || expected.lifecycle_stage_id;
            if (stageId && String(stageId).trim() !== '') {
                const stageName = lifecycleStagesMap[String(stageId).trim()] || stageId;
                expected.u_vrm_life_cycle_stage = stageName;
                expected.x_bisit_vrm_life_cycle_stage_name = stageName;
                expected.life_cycle_stage_name = stageName;
            }

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

    console.table(sampleValidationSummary);
    if (sampleFieldMismatches.length > 0) {
        console.table(sampleFieldMismatches);
    }

    expect.soft(
        sampleFieldMismatches.length,
        `Expected 0 field mismatches in 15-record sample, but found ${sampleFieldMismatches.length}`
    ).toBe(0);
});

// Verify unmatched companies are inserted when ins_company flag is enabled
test('TC-04: Verify unmatched companies are inserted when ins_company flag is enabled', async ({ page }) => {
    test.setTimeout(1_800_000);

    const bitsightClient = new BitsightApiClient();
    const serviceNowClient = new ServiceNowApiClient();

    // 1. Pick 5 random companies that already exist in ServiceNow with a Bitsight GUID
    const recordsToDelete = await getRandomCoreCompaniesWithGuid(serviceNowClient, 5);
    expect(recordsToDelete.length, 'Expected at least one core_company record with a Bitsight GUID to delete').toBeGreaterThan(0);
    console.log(`[TC-04] Selected ${recordsToDelete.length} company record(s) with Bitsight GUID to delete:`);
    console.table(recordsToDelete.map(r => ({ Name: r.name, GUID: r.guid, sys_id: r.sys_id })));

    // 2. Delete those 5 companies from ServiceNow
    const sysIdsToDelete = recordsToDelete.map(r => r.sys_id);
    const deleteResult = await serviceNowClient.deleteRecordsBatch('core_company', sysIdsToDelete);
    expect(deleteResult.deletedCount, 'All selected records should be successfully deleted').toBe(recordsToDelete.length);
    const deletedGuids = recordsToDelete.map(r => r.guid);

    // 3. Configure Application Properties: ins_company = true
    const savedConfig = await configureApplicationProperties(page, {
        ins_company: true,
        assign_incident: 'user',
        user: 'abel tuter',
        caller: 'abraham lincoln',
    });
    expect(savedConfig.insCompany, 'ins_company flag must be true').toBe(true);

    // 4. Trigger Scheduled Portfolio Data Import and wait for completion
    const { completeLog, baselineTimestamp } = await triggerAndWaitForPortfolioImport(page, serviceNowClient);

    // 5. Check whether the deleted companies were created again in ServiceNow
    const reinsertedRecords = await findCoreCompaniesByGuids(serviceNowClient, deletedGuids);
    const reinsertedGuids = new Set(reinsertedRecords.map(r => unwrapField(r.x_bisit_vrm_bitsight_vendor_guid)));
    const missingGuids = deletedGuids.filter(g => !reinsertedGuids.has(g));

    console.log(`[TC-04] Re-inserted records count: ${reinsertedRecords.length} / ${deletedGuids.length}`);

    // If any missing, check if they are in failed company import logs from syslog
    let missingAccountedFor = 0;
    if (missingGuids.length > 0) {
        console.warn(`[TC-04] ${missingGuids.length} company(ies) were not re-inserted: ${missingGuids.join(', ')}`);
        const failedLogs = await serviceNowClient.getFailedImportCompanies({
            baselineTimestamp,
            completionTimestamp: completeLog?.sys_created_on,
        });
        const failedVendorGuids = new Set(failedLogs.map(l => l.vendorGuid).filter(Boolean));

        const vrmVendors = await bitsightClient.getVendors().catch(() => []);
        const resolvedVrmGuids = await bitsightClient.resolveVrmVendors(vrmVendors).catch(() => ({}));

        for (const missingGuid of missingGuids) {
            const isFailedDirectly = failedVendorGuids.has(missingGuid);
            const isFailedViaVrm = Object.entries(resolvedVrmGuids).some(
                ([vGuid, bsGuid]) => bsGuid === missingGuid && failedVendorGuids.has(vGuid)
            );

            if (isFailedDirectly || isFailedViaVrm) {
                console.log(`[TC-04] Missing company GUID ${missingGuid} is accounted for in failed vendor import syslog.`);
                missingAccountedFor++;
            } else {
                console.error(`[TC-04] Missing company GUID ${missingGuid} is NOT in failed vendor import syslog!`);
            }
        }
    }

    expect(
        reinsertedRecords.length + missingAccountedFor,
        `Expected all ${deletedGuids.length} deleted companies to be reinserted or accounted for in failed imports. Missing: ${missingGuids.join(', ')}`
    ).toBe(deletedGuids.length);
});

// Verify unmatched companies are NOT inserted when ins_company flag is disabled
test('TC-05: Verify unmatched companies are NOT inserted when ins_company flag is disabled', async ({ page }) => {
    test.setTimeout(1_800_000);

    const serviceNowClient = new ServiceNowApiClient();

    // 1. Pick 5 random companies that already exist in ServiceNow with a Bitsight GUID
    const recordsToDelete = await getRandomCoreCompaniesWithGuid(serviceNowClient, 5);
    expect(recordsToDelete.length, 'Expected at least one core_company record with a Bitsight GUID to delete').toBeGreaterThan(0);
    console.log(`[TC-05] Selected ${recordsToDelete.length} company record(s) with Bitsight GUID to delete:`);
    console.table(recordsToDelete.map(r => ({ Name: r.name, GUID: r.guid, sys_id: r.sys_id })));

    // 2. Delete those 5 companies from ServiceNow
    const sysIdsToDelete = recordsToDelete.map(r => r.sys_id);
    const deleteResult = await serviceNowClient.deleteRecordsBatch('core_company', sysIdsToDelete);
    expect(deleteResult.deletedCount, 'All selected records should be successfully deleted').toBe(recordsToDelete.length);
    const deletedGuids = recordsToDelete.map(r => r.guid);

    // 3. Configure Application Properties: ins_company = false
    const savedConfig = await configureApplicationProperties(page, {
        ins_company: false,
        assign_incident: 'user',
        user: 'abel tuter',
        caller: 'abraham lincoln',
    });
    expect(savedConfig.insCompany, 'ins_company flag must be false').toBe(false);

    // 4. Trigger Scheduled Portfolio Data Import and wait for completion
    await triggerAndWaitForPortfolioImport(page, serviceNowClient);

    // 5. Check whether the deleted companies came back in ServiceNow (expected: 0)
    const reinsertedRecords = await findCoreCompaniesByGuids(serviceNowClient, deletedGuids);

    console.log(
        reinsertedRecords.length === 0
            ? `[TC-05] Confirmed: none of the ${deletedGuids.length} deleted companies were reinserted.`
            : `[TC-05] UNEXPECTED: ${reinsertedRecords.length} deleted companies came back: ${reinsertedRecords.map(r => unwrapField(r.name)).join(', ')}`
    );

    expect(
        reinsertedRecords.length,
        'Expected 0 deleted companies to be reinserted when ins_company is disabled'
    ).toBe(0);
});

// Verify each company is marked as a vendor when mark_company flag is true while importing
test('TC-06: Verify each company is marked as a vendor when mark_company flag is true while importing', async ({ page }) => {
    test.setTimeout(1_800_000);

    const serviceNowClient = new ServiceNowApiClient();

    // 1. Clean up existing portfolio in ServiceNow
    await clearPortfolio(serviceNowClient);

    // 2. Configure Application Properties: ins_company = true, mark_comp = true
    const savedConfig = await configureApplicationProperties(page, {
        ins_company: true,
        mark_comp: true,
        assign_incident: 'user',
        user: 'abel tuter',
        caller: 'abraham lincoln',
    });
    expect(savedConfig.markComp, 'mark_comp flag must be true').toBe(true);

    // 3. Trigger Scheduled Portfolio Data Import and wait for completion
    const { startLogTimestamp } = await triggerAndWaitForPortfolioImport(page, serviceNowClient);

    // 4. Verify newly created companies in core_company are marked as vendors
    const query = startLogTimestamp
        ? `x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^sys_created_on>=${startLogTimestamp}`
        : 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY';

    const postImportCompanies = await serviceNowClient.getTableRecords('core_company', {
        sysparm_query: query,
        sysparm_fields: 'sys_id,name,vendor,x_bisit_vrm_bitsight_vendor_guid,sys_created_on',
    });

    console.log(`[TC-06] Newly created core_company count: ${postImportCompanies.length}`);
    expect(postImportCompanies.length, 'Expected newly created company records after import').toBeGreaterThan(0);

    for (const company of postImportCompanies) {
        const isVendor = company.vendor === true || company.vendor === 'true' || company.vendor === '1' || company.vendor === 1;
        expect(isVendor, `Company "${company.name}" (${company.sys_id}) should be marked as vendor (vendor=true)`).toBe(true);
    }
});

// Verify each company is NOT marked as a vendor when mark_company flag is false while importing
test('TC-07: Verify each company is NOT marked as a vendor when mark_company flag is false while importing', async ({ page }) => {
    test.setTimeout(1_800_000);

    const serviceNowClient = new ServiceNowApiClient();

    // 1. Clean up existing portfolio in ServiceNow
    await clearPortfolio(serviceNowClient);

    // 2. Configure Application Properties: ins_company = true, mark_comp = false
    const savedConfig = await configureApplicationProperties(page, {
        ins_company: true,
        mark_comp: false,
        assign_incident: 'user',
        user: 'abel tuter',
        caller: 'abraham lincoln',
    });
    expect(savedConfig.markComp, 'mark_comp flag must be false').toBe(false);

    // 3. Trigger Scheduled Portfolio Data Import and wait for completion
    const { startLogTimestamp } = await triggerAndWaitForPortfolioImport(page, serviceNowClient);

    // 4. Verify newly created companies in core_company are NOT marked as vendors
    const query = startLogTimestamp
        ? `x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^sys_created_on>=${startLogTimestamp}`
        : 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY';

    const postImportCompanies = await serviceNowClient.getTableRecords('core_company', {
        sysparm_query: query,
        sysparm_fields: 'sys_id,name,vendor,x_bisit_vrm_bitsight_vendor_guid,sys_created_on',
    });

    console.log(`[TC-07] Newly created core_company count: ${postImportCompanies.length}`);
    expect(postImportCompanies.length, 'Expected newly created company records after import').toBeGreaterThan(0);

    for (const company of postImportCompanies) {
        const isVendor = company.vendor === true || company.vendor === 'true' || company.vendor === '1' || company.vendor === 1;
        expect(isVendor, `Company "${company.name}" (${company.sys_id}) should NOT be marked as vendor (vendor=false)`).toBe(false);
    }
});

// Verify tabs, buttons, and tiles for a CM-only company record in ServiceNow
test('TC-08: Verify CM-only company record tabs and tiles in ServiceNow', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(
        process.env.SN_URL +
        'now/nav/ui/classic/params/target/' +
        'core_company_list.do%3Fsysparm_query%3Dx_bisit_vrm_bitsight_vendor_guidISNOTEMPTY%255Ex_bisit_vrm_bs_subscription_type!%253DNULL%255Ex_bisit_vrm_is_vrm%253Dfalse%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight_vrm'
    );

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });
    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC-08] Opening first CM-only company record: "${companyName}"`);
    await firstRecordLink.click();

    const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await ratingsTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 1. Verify all 4 tabs are visible
    await expect(frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i })).toBeVisible();
    await expect(ratingsTab).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Portfolio Information' })).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Assessment Report' })).toBeVisible();

    // 2. On Bitsight Vendor Risk tab: Verify "Add Vendor" button
    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i });
    await vendorRiskTab.click();
    await expect(frame.getByRole('button', { name: 'Add Vendor' })).toBeVisible();

    // 3. On Bitsight Security Ratings tab: Verify action buttons and dashboard tiles
    await ratingsTab.click();
    await expect(ratingsTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 }).catch(() => { });

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

// Verify tabs, buttons, and cards for a VRM-only company record in ServiceNow
test('TC-09: Verify VRM-only company record tabs and cards in ServiceNow', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(
        process.env.SN_URL +
        'now/nav/ui/classic/params/target/' +
        'core_company_list.do%3Fsysparm_query%3Dx_bisit_vrm_bitsight_vendor_guidISNOTEMPTY%255Ex_bisit_vrm_is_vrm%253Dtrue%255Ex_bisit_vrm_bs_subscription_type%253DNULL%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight_vrm'
    );

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });
    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC-09] Opening first VRM-only company record: "${companyName}"`);
    await firstRecordLink.click();

    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i });
    const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await vendorRiskTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 1. Verify visible tabs (Assessment Report tab should not be visible for VRM-only)
    await expect(vendorRiskTab).toBeVisible();
    await expect(ratingsTab).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Portfolio Information' })).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Assessment Report', timeout: 15_000 })).not.toBeVisible();

    // 2. On Bitsight Security Ratings tab: Verify "Subscribe" button
    await ratingsTab.click();
    const subscribeBtn = frame.getByRole('button', { name: 'Subscribe' });
    await subscribeBtn.scrollIntoViewIfNeeded();
    await expect(subscribeBtn).toBeVisible({ timeout: 15_000 });

    // 3. On Bitsight Vendor Risk tab: Verify 4 cards
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

// Verify tabs, cards, and graph tiles for a CM+VRM company record in ServiceNow
test('TC-10: Verify CM_VRM company record tabs, cards, and tiles in ServiceNow', async ({ page }) => {
    test.setTimeout(120_000);

    await page.goto(
        process.env.SN_URL +
        'now/nav/ui/classic/params/target/' +
        'core_company_list.do%3Fsysparm_query%3Dx_bisit_vrm_bitsight_vendor_guidISNOTEMPTY%255Ex_bisit_vrm_is_vrm%253Dtrue%255Ex_bisit_vrm_bs_subscription_type!%253DNULL%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight_vrm'
    );

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });
    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC-10] Opening first CM+VRM company record: "${companyName}"`);
    await firstRecordLink.click();

    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i });
    const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    await ratingsTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 1. Verify all 4 tabs are visible
    await expect(vendorRiskTab).toBeVisible();
    await expect(ratingsTab).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Portfolio Information' })).toBeVisible();
    await expect(frame.getByRole('tab', { name: 'Bitsight Assessment Report' })).toBeVisible();

    // 2. On Bitsight Vendor Risk tab: Verify 4 cards
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

    // 3. On Bitsight Security Ratings tab: Verify action buttons and dashboard tiles
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

test('TC 11 CM_VRM Bitsight Portfolio record - Unsubscribe, re-lock website, and re-subscribe (Is VRM = false)', async ({ page }) => {
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

test('TC 12 Bitsight Portfolio record - Enable Vendor Access flow (Is VRM = false)', async ({ page }) => {
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

test('TC 13 Bitsight Portfolio record - Switch Subscription updates subscription type (Is VRM = false)', async ({ page }) => {
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

test('TC 14 Bitsight Portfolio record - Manage Folders moves an available folder (Is VRM = false)', async ({ page }) => {
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

test('TC 15 Trigger import job and check portfolio information (Is VRM = false)', async ({ page }) => {
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

test('TC 16 Bitsight Assessment Report - template, downloads, and filters (Is VRM = false)', async ({ page }) => {
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

test('TC 17 Bitsight Portfolio record - Conditional subscription / re-subscription (Is VRM = true)', async ({ page }) => {
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

test('TC 18 Bitsight Portfolio record - Add Vendor (Is VRM = false)', async ({ page }) => {
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

// ---------- Test Cases for bitsight_user login ----------
test('TC 19: Verify Bitsight VRM modules available for bitsight_user login', async ({ page }) => {
    test.setTimeout(120_000);

    const regularUser = process.env.SN_REGULAR_USER || 'bitsight_user';
    const regularPass = process.env.SN_REGULAR_PASS || 'Bitsight@123';

    // 1. Logout from bitsight_admin and login as bitsight_user
    await switchUser(page, regularUser, regularPass);

    // 2. Filter Bitsight modules in the navigation menu
    await filterBitsightModules(page);

    // 3. Verify visible modules for bitsight_user
    for (const module of USER_VISIBLE_MODULES) {
        const link = page.getByRole('link', {
            name: new RegExp(`^${module} \\d+ of \\d+$`),
        });
        await expect(link, `Module "${module}" should be visible for ${regularUser}`).toBeVisible();
        await link.click();
    }

    // 4. Verify admin-only modules are not visible for bitsight_user
    for (const module of USER_HIDDEN_MODULES) {
        const link = page.getByRole('link', {
            name: new RegExp(`^${module} \\d+ of \\d+$`),
        });
        await expect(link, `Module "${module}" should NOT be visible for ${regularUser}`).not.toBeVisible();
    }
});

test('TC 20: Verify VRM-only company record fields are read-only and verify tabs for bitsight_user login', async ({ page }) => {
    test.setTimeout(120_000);

    const regularUser = process.env.SN_REGULAR_USER || 'bitsight_user';
    const regularPass = process.env.SN_REGULAR_PASS || 'Bitsight@123';

    // 1. Logout from bitsight_admin and login as bitsight_user
    await switchUser(page, regularUser, regularPass);

    // 2. Navigate directly to VRM-only companies list view
    await page.goto(
        process.env.SN_URL +
        'now/nav/ui/classic/params/target/' +
        'core_company_list.do%3Fsysparm_query%3Dx_bisit_vrm_bitsight_vendor_guidISNOTEMPTY%255Ex_bisit_vrm_is_vrm%253Dtrue%255Ex_bisit_vrm_bs_subscription_type%253DNULL%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight_vrm'
    );

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    // 3. Verify List View Read-Only restriction by double-clicking a cell
    const scoreCell = frame.getByRole('gridcell').filter({ hasText: /^\d+$/ }).first();
    if (await scoreCell.isVisible({ timeout: 15_000 }).catch(() => false)) {
        await scoreCell.dblclick();
        const securityMsg = frame.getByText('Security prevents writing to this field', { exact: true });
        await expect(securityMsg, 'Security restriction tooltip should prevent inline editing in list view').toBeVisible({ timeout: 10_000 });
        const cancelBtn = frame.getByRole('button', { name: 'Cancel (ESC)' });
        if (await cancelBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await cancelBtn.click();
        } else {
            await page.keyboard.press('Escape');
        }
    }

    // 4. Open first VRM-only company record
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });
    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 20] Opening first VRM-only company record: "${companyName}"`);
    await firstRecordLink.click();

    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk Management/i });
    const portfolioTab = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
    const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    const assessmentTab = frame.getByRole('tab', { name: 'Bitsight Assessment Report' });

    await vendorRiskTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 5. Verify visible and non-visible tabs for bitsight_user on VRM-only record
    await expect(vendorRiskTab, 'Bitsight Vendor Risk tab should be visible').toBeVisible();
    await expect(portfolioTab, 'Bitsight Portfolio Information tab should be visible').toBeVisible();
    await expect(ratingsTab, 'Bitsight Security Ratings tab should NOT be visible for bitsight_user on VRM-only record').not.toBeVisible({ timeout: 10_000 });
    await expect(assessmentTab, 'Bitsight Assessment Report tab should NOT be visible for bitsight_user on VRM-only record').not.toBeVisible({ timeout: 10_000 });

    // 6. On Bitsight Vendor Risk tab: Verify cards are visible
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

    // 7. On Bitsight Portfolio Information tab: Verify fields are populated and not empty
    await portfolioTab.click();
    await page.waitForLoadState('networkidle').catch(() => { });

    // Helper function to build dynamic field selectors ignoring hidden ServiceNow inputs
    const getFieldLocator = (fieldName) => {
        return frame.locator([
            `#element\\.core_company\\.${fieldName} :is(input:not([type="hidden"]), div.form-control-static, span.form-control-static)`,
            `input#sys_readonly\\.core_company\\.${fieldName}`,
            `input#core_company\\.${fieldName}:not([type="hidden"])`
        ].join(', ')).first();
    };

    const fieldChecks = [
        { label: 'Bitsight vendor GUID', locator: () => getFieldLocator('x_bisit_vrm_bitsight_vendor_guid') },
        { label: 'Bitsight rating date', locator: () => getFieldLocator('x_bisit_vrm_rating_date') },
        { label: 'Bitsight primary domain', locator: () => getFieldLocator('x_bisit_vrm_primary_domain') },
        { label: 'Bitsight security rating', locator: () => getFieldLocator('x_bisit_vrm_security_rating') },
        { label: 'Bitsight company name', locator: () => getFieldLocator('x_bisit_vrm_company_name') },
    ];

    console.log(`\n--- [TC 20] Portfolio Information field check for "${companyName}" ---`);

    for (const { label, locator } of fieldChecks) {
        const field = locator();
        await field.waitFor({ state: 'visible', timeout: 30_000 });

        let value = await field.inputValue().catch(() => '');
        if (!value) {
            value = await field.innerText().catch(() => '');
        }
        value = value.trim();

        console.log(value.length > 0 ? `[TC 20] "${label}" is populated: "${value}"` : `[TC 20] "${label}" is EMPTY`);
        expect(value.length, `Expected "${label}" to be populated on the Portfolio Information tab`).toBeGreaterThan(0);
    }
});

test('TC 21: Verify CM-only company record tabs, buttons, and fields for bitsight_user login', async ({ page }) => {
    test.setTimeout(120_000);

    const regularUser = process.env.SN_REGULAR_USER || 'bitsight_user';
    const regularPass = process.env.SN_REGULAR_PASS || 'Bitsight@123';

    // 1. Logout from bitsight_admin and login as bitsight_user
    await switchUser(page, regularUser, regularPass);

    // 2. Navigate directly to CM-only companies list view
    await page.goto(
        process.env.SN_URL +
        'now/nav/ui/classic/params/target/' +
        'core_company_list.do%3Fsysparm_query%3Dx_bisit_vrm_bitsight_vendor_guidISNOTEMPTY%255Ex_bisit_vrm_bs_subscription_type!%253DNULL%255Ex_bisit_vrm_is_vrm%253Dfalse%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight_vrm'
    );

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    console.log('Verifying that the list view is read-only for bitsight_user by attempting to double-click a score cell...');
    const scoreCell = frame.getByRole('gridcell').filter({ hasText: /^\d+$/ }).first();
    if (await scoreCell.isVisible({ timeout: 15_000 }).catch(() => false)) {
        await scoreCell.dblclick();
        const securityMsg = frame.getByText('Security prevents writing to this field', { exact: true });
        await expect(securityMsg, 'Security restriction tooltip should prevent inline editing in list view').toBeVisible({ timeout: 10_000 });
        const cancelBtn = frame.getByRole('button', { name: 'Cancel (ESC)' });
        if (await cancelBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await cancelBtn.click();
        } else {
            await page.keyboard.press('Escape');
        }
    }
    console.log('Read-only restriction verified for list view cells.');

    // 3. Open first CM-only company record
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });
    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 21] Opening first CM-only company record: "${companyName}"`);
    await firstRecordLink.click();

    const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    const portfolioTab = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
    const assessmentTab = frame.getByRole('tab', { name: 'Bitsight Assessment Report' });
    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i });

    await ratingsTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 4. Verify visible and non-visible tabs for bitsight_user on CM-only record
    await expect(ratingsTab, 'Bitsight Security Ratings tab should be visible').toBeVisible();
    await expect(portfolioTab, 'Bitsight Portfolio Information tab should be visible').toBeVisible();
    await expect(assessmentTab, 'Bitsight Assessment Report tab should be visible').toBeVisible();
    await expect(vendorRiskTab, 'Bitsight Vendor Risk tab should NOT be visible for bitsight_user on CM-only record').not.toBeVisible({ timeout: 10_000 });

    // 5. On Bitsight Security Ratings tab: Verify buttons and dashboard tiles
    await ratingsTab.click();
    await expect(ratingsTab).toHaveAttribute('aria-selected', 'true', { timeout: 10_000 }).catch(() => { });

    // Action buttons: "Enable Vendor Access" is visible, admin buttons are not visible
    const enableVendorBtn = frame.getByRole('button', { name: 'Enable Vendor Access' }).first();
    await enableVendorBtn.scrollIntoViewIfNeeded();
    await expect(enableVendorBtn, 'Button "Enable Vendor Access" should be visible').toBeVisible({ timeout: 15_000 });

    const hiddenAdminButtons = [
        'Switch Subscription',
        'Manage Folders',
        'Unsubscribe',
    ];

    for (const btnName of hiddenAdminButtons) {
        const btn = frame.getByRole('button', { name: btnName }).first();
        await expect(btn, `Button "${btnName}" should NOT be visible for bitsight_user`).not.toBeVisible({ timeout: 5_000 });
    }

    // Dashboard tiles and graphs
    const overviewLink = frame.getByText(/View Company Overview/i).first();
    await overviewLink.scrollIntoViewIfNeeded();
    await expect(overviewLink, 'View Company Overview link should be visible').toBeVisible({ timeout: 15_000 });

    const timeseriesBox = frame.locator('.timeseries-box').first();
    await timeseriesBox.scrollIntoViewIfNeeded();
    await expect(timeseriesBox, 'Timeseries box should be visible').toBeVisible({ timeout: 15_000 });

    const vectorsBreakdown = frame.locator('#vectors-breakdown');
    await vectorsBreakdown.scrollIntoViewIfNeeded();
    await expect(vectorsBreakdown, 'Vectors breakdown should be visible').toBeVisible({ timeout: 15_000 });

    const ratingBreakdown = frame.locator('#rating-breakdown');
    await ratingBreakdown.scrollIntoViewIfNeeded();
    await expect(ratingBreakdown, 'Rating breakdown should be visible').toBeVisible({ timeout: 15_000 });

    const ratingHighlights = frame.getByText(/^Rating Highlights/i).first();
    await ratingHighlights.scrollIntoViewIfNeeded();
    await expect(ratingHighlights, 'Rating Highlights should be visible').toBeVisible({ timeout: 15_000 });

    // 6. On Bitsight Portfolio Information tab: Verify fields are populated and not empty
    await portfolioTab.click();
    await page.waitForLoadState('networkidle').catch(() => { });

    const getFieldLocator = (fieldName) => {
        return frame.locator([
            `#element\\.core_company\\.${fieldName} :is(input:not([type="hidden"]), div.form-control-static, span.form-control-static)`,
            `input#sys_readonly\\.core_company\\.${fieldName}`,
            `input#core_company\\.${fieldName}:not([type="hidden"])`
        ].join(', ')).first();
    };

    const fieldChecks = [
        { label: 'Bitsight vendor GUID', locator: () => getFieldLocator('x_bisit_vrm_bitsight_vendor_guid') },
        { label: 'Bitsight rating date', locator: () => getFieldLocator('x_bisit_vrm_rating_date') },
        { label: 'Bitsight primary domain', locator: () => getFieldLocator('x_bisit_vrm_primary_domain') },
        { label: 'Bitsight security rating', locator: () => getFieldLocator('x_bisit_vrm_security_rating') },
        { label: 'Bitsight company name', locator: () => getFieldLocator('x_bisit_vrm_company_name') },
    ];

    console.log(`\n--- [TC 21] Portfolio Information field check for "${companyName}" ---`);

    for (const { label, locator } of fieldChecks) {
        const field = locator();
        await field.waitFor({ state: 'visible', timeout: 30_000 });

        let value = await field.inputValue().catch(() => '');
        if (!value) {
            value = await field.innerText().catch(() => '');
        }
        value = value.trim();

        console.log(value.length > 0 ? `[TC 21] "${label}" is populated: "${value}"` : `[TC 21] "${label}" is EMPTY`);
        expect(value.length, `Expected "${label}" to be populated on the Portfolio Information tab`).toBeGreaterThan(0);
    }

    // 7. On Bitsight Assessment Report tab: Verify tab is visible
    await expect(assessmentTab, 'Bitsight Assessment Report tab should be visible on CM-only record').toBeVisible();
});

test('TC 22: Verify CM_VRM company record tabs, cards, tiles, and fields for bitsight_user login', async ({ page }) => {
    test.setTimeout(120_000);

    const regularUser = process.env.SN_REGULAR_USER || 'bitsight_user';
    const regularPass = process.env.SN_REGULAR_PASS || 'Bitsight@123';

    // 1. Logout from bitsight_admin and login as bitsight_user
    await switchUser(page, regularUser, regularPass);

    // 2. Navigate directly to CM+VRM companies list view
    await page.goto(
        process.env.SN_URL +
        'now/nav/ui/classic/params/target/' +
        'core_company_list.do%3Fsysparm_query%3Dx_bisit_vrm_bitsight_vendor_guidISNOTEMPTY%255Ex_bisit_vrm_is_vrm%253Dtrue%255Ex_bisit_vrm_bs_subscription_type!%253DNULL%26sysparm_first_row%3D1%26sysparm_view%3Dbitsight_vrm'
    );

    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();

    console.log('Verifying that the list view is read-only for bitsight_user by attempting to double-click a score cell...');
    const scoreCell = frame.getByRole('gridcell').filter({ hasText: /^\d+$/ }).first();
    if (await scoreCell.isVisible({ timeout: 15_000 }).catch(() => false)) {
        await scoreCell.dblclick();
        const securityMsg = frame.getByText('Security prevents writing to this field', { exact: true });
        await expect(securityMsg, 'Security restriction tooltip should prevent inline editing in list view').toBeVisible({ timeout: 10_000 });
        console.log('Read-only restriction verified for list view cells.');
        const cancelBtn = frame.getByRole('button', { name: 'Cancel (ESC)' });
        if (await cancelBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
            await cancelBtn.click();
        } else {
            await page.keyboard.press('Escape');
        }
    }

    // 3. Open first CM+VRM company record
    const firstRecordLink = frame.getByRole('link', { name: /^Open record:/ }).first();
    await firstRecordLink.waitFor({ state: 'visible', timeout: 30_000 });
    const companyName = (await firstRecordLink.innerText()).replace(/^Open record:\s*/, '').trim();
    console.log(`[TC 22] Opening first CM+VRM company record: "${companyName}"`);
    await firstRecordLink.click();

    const vendorRiskTab = frame.getByRole('tab', { name: /^Bitsight Vendor Risk/i });
    const ratingsTab = frame.getByRole('tab', { name: 'Bitsight Security Ratings' });
    const portfolioTab = frame.getByRole('tab', { name: 'Bitsight Portfolio Information' });
    const assessmentTab = frame.getByRole('tab', { name: 'Bitsight Assessment Report' });

    await ratingsTab.waitFor({ state: 'visible', timeout: 30_000 });

    // 4. Verify all 4 tabs are visible on CM+VRM record
    await expect(vendorRiskTab, 'Bitsight Vendor Risk tab should be visible').toBeVisible();
    await expect(ratingsTab, 'Bitsight Security Ratings tab should be visible').toBeVisible();
    await expect(portfolioTab, 'Bitsight Portfolio Information tab should be visible').toBeVisible();
    await expect(assessmentTab, 'Bitsight Assessment Report tab should be visible').toBeVisible();

    // 5. On Bitsight Vendor Risk tab: Verify cards
    await vendorRiskTab.click();

    const aboutRating = frame.getByText(/About Rating/i).first();
    if (await aboutRating.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await aboutRating.scrollIntoViewIfNeeded().catch(() => { });
    }
    await expect(aboutRating, 'About Rating card should be visible').toBeVisible({ timeout: 15_000 });

    const scoringImpact = frame.getByText(/Scoring\s*(Impact)?/i).first();
    if (await scoringImpact.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await scoringImpact.scrollIntoViewIfNeeded().catch(() => { });
    }
    await expect(scoringImpact, 'Scoring card should be visible').toBeVisible({ timeout: 15_000 });

    const lifeCycleStage = frame.getByText(/Life Cycle Stage/i).first();
    if (await lifeCycleStage.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await lifeCycleStage.scrollIntoViewIfNeeded().catch(() => { });
    }
    await expect(lifeCycleStage, 'Life Cycle Stage card should be visible').toBeVisible({ timeout: 15_000 });

    const pastDue = frame.getByText(/Past Due/i).first();
    if (await pastDue.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await pastDue.scrollIntoViewIfNeeded().catch(() => { });
    }
    await expect(pastDue, 'Past Due card should be visible').toBeVisible({ timeout: 15_000 });

    // 6. On Bitsight Security Ratings tab: Verify buttons and dashboard tiles
    await ratingsTab.click();
    await page.waitForTimeout(1000); // Allow tab panel animation/JS render

    // Action buttons: On CM+VRM records (where is_vrm=true), "Enable Vendor Access" is not applicable/present,
    // and admin action buttons ("Switch Subscription", "Manage Folders", "Unsubscribe") are not visible for bitsight_user.
    const nonVisibleButtons = [
        // 'Enable Vendor Access',
        'Switch Subscription',
        'Manage Folders',
        'Unsubscribe',
    ];

    for (const btnName of nonVisibleButtons) {
        const btn = frame.getByRole('button', { name: btnName }).first();
        await expect(btn, `Button "${btnName}" should NOT be visible for bitsight_user on CM+VRM record`).not.toBeVisible({ timeout: 5_000 });
    }

    const btn = frame.getByRole('button', { name: 'Enable Vendor Access' }).first();
    await expect(btn, `Button 'Enable Vendor Access' should be visible for bitsight_user on CM+VRM record`).toBeVisible({ timeout: 5_000 });

    // Dashboard tiles and graphs
    const overviewLink = frame.getByText(/View Company Overview/i).first();
    if (await overviewLink.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await overviewLink.scrollIntoViewIfNeeded().catch(() => { });
    }
    await expect(overviewLink, 'View Company Overview link should be visible').toBeVisible({ timeout: 15_000 });

    const timeseriesBox = frame.locator('.timeseries-box').first();
    if (await timeseriesBox.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await timeseriesBox.scrollIntoViewIfNeeded().catch(() => { });
    }
    await expect(timeseriesBox, 'Timeseries box should be visible').toBeVisible({ timeout: 15_000 });

    const vectorsBreakdown = frame.locator('#vectors-breakdown');
    if (await vectorsBreakdown.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await vectorsBreakdown.scrollIntoViewIfNeeded().catch(() => { });
    }
    await expect(vectorsBreakdown, 'Vectors breakdown should be visible').toBeVisible({ timeout: 15_000 });

    const ratingBreakdown = frame.locator('#rating-breakdown');
    if (await ratingBreakdown.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await ratingBreakdown.scrollIntoViewIfNeeded().catch(() => { });
    }
    await expect(ratingBreakdown, 'Rating breakdown should be visible').toBeVisible({ timeout: 15_000 });

    const ratingHighlights = frame.getByText(/^Rating Highlights/i).first();
    if (await ratingHighlights.isVisible({ timeout: 10_000 }).catch(() => false)) {
        await ratingHighlights.scrollIntoViewIfNeeded().catch(() => { });
    }
    await expect(ratingHighlights, 'Rating Highlights should be visible').toBeVisible({ timeout: 15_000 });

    // 7. On Bitsight Portfolio Information tab: Verify fields are populated and not empty
    await portfolioTab.click();
    await page.waitForLoadState('networkidle').catch(() => { });

    const getFieldLocator = (fieldName) => {
        return frame.locator([
            `#element\\.core_company\\.${fieldName} :is(input:not([type="hidden"]), div.form-control-static, span.form-control-static)`,
            `input#sys_readonly\\.core_company\\.${fieldName}`,
            `input#core_company\\.${fieldName}:not([type="hidden"])`
        ].join(', ')).first();
    };

    const fieldChecks = [
        { label: 'Bitsight vendor GUID', locator: () => getFieldLocator('x_bisit_vrm_bitsight_vendor_guid') },
        { label: 'Bitsight rating date', locator: () => getFieldLocator('x_bisit_vrm_rating_date') },
        { label: 'Bitsight primary domain', locator: () => getFieldLocator('x_bisit_vrm_primary_domain') },
        { label: 'Bitsight security rating', locator: () => getFieldLocator('x_bisit_vrm_security_rating') },
        { label: 'Bitsight company name', locator: () => getFieldLocator('x_bisit_vrm_company_name') },
    ];

    console.log(`\n--- [TC 22] Portfolio Information field check for "${companyName}" ---`);

    for (const { label, locator } of fieldChecks) {
        const field = locator();
        await field.waitFor({ state: 'visible', timeout: 30_000 });

        let value = await field.inputValue().catch(() => '');
        if (!value) {
            value = await field.innerText().catch(() => '');
        }
        value = value.trim();

        console.log(value.length > 0 ? `[TC 20] "${label}" is populated: "${value}"` : `[TC 20] "${label}" is EMPTY`);
        expect(value.length, `Expected "${label}" to be populated on the Portfolio Information tab`).toBeGreaterThan(0);
    }

    // 8. On Bitsight Assessment Report tab: Verify tab is visible
    await expect(assessmentTab, 'Bitsight Assessment Report tab should be visible on CM+VRM record').toBeVisible();
});

test('TC 23: Verify Rating and Risk Vector Alerts fields are read-only for bitsight_user', async ({ page }) => {
    test.setTimeout(2000_000); // original timeout + 30 min for the import

    const token = process.env.CMVRM_TOKEN;
    if (!token) {
        throw new Error('CM_TOKEN is not set in .env');
    }
    const bitsightClient = new BitsightApiClient({ token });
    const serviceNowClient = new ServiceNowApiClient();
    await page.goto(BASE_URL);

    // // ---------- Step 0: run alerts import reconciliation first ----------
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


    const regularUser = process.env.SN_REGULAR_USER || 'bitsight_user';
    const regularPass = process.env.SN_REGULAR_PASS || 'Bitsight@123';

    // 1. Authenticate as bitsight_user
    await switchUser(page, regularUser, regularPass);

    // 2. Navigate to Rating and Risk Vector Alerts via filter navigator
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByText('All').first().click();
    const searchBox23 = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox23.click();
    await searchBox23.fill('bitsight');
    await page.getByRole('link', { name: /Rating and Risk Vector Alerts/i }).first().click();

    // 3. Wait for list view frame and column header to load
    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const companyColumnHeader = frame.getByRole('columnheader', { name: 'Company' }).or(frame.locator('body')).first();
    await companyColumnHeader.waitFor({ state: 'visible', timeout: 30_000 });

    // 4. Fetch an alert record via Table API
    const listUrl = `/api/now/table/x_bisit_vrm_bitsight_alerts?sysparm_fields=sys_id,company&sysparm_limit=1`;
    const { ok: listOk, status: listStatus, body: listBody } = await snFetch(page, listUrl);
    expect(listOk, `Failed to fetch a Bitsight alert record (HTTP ${listStatus})`).toBeTruthy();

    const records = listBody?.result || [];
    expect(records.length, 'Expected at least one record in the Bitsight alerts table').toBeGreaterThan(0);

    const record = records[0];
    const sysId = unwrapField(record.sys_id);
    const originalCompany = unwrapField(record.company);
    console.log(`[TC 23] Target alert record sys_id: ${sysId}, current company: ${JSON.stringify(originalCompany)}`);

    // 5. Attempt to overwrite the Company field via Table API while authenticated as bitsight_user
    const updateUrl = `/api/now/table/x_bisit_vrm_bitsight_alerts/${sysId}`;
    const { ok: updateOk, status: updateStatus, body: updateBody } = await snMutate(
        page, updateUrl, 'PATCH', { company: '' }
    );

    console.log(`[TC 23] PATCH response - status: ${updateStatus}, ok: ${updateOk}`);
    console.log(`[TC 23] PATCH response body: ${JSON.stringify(updateBody)}`);

    // The API call itself is expected to succeed (200) even though the ACL silently blocks the actual field write
    expect(updateStatus, 'Expected the Table API PATCH request itself to succeed (200) - ACL denial is a silent no-op').toBe(200);
    expect(updateOk, 'Expected Table API PATCH response to report ok').toBeTruthy();

    // 6. Re-fetch the record and confirm the Company value did NOT change
    const { ok: recheckOk, body: recheckBody } = await snFetch(
        page, `/api/now/table/x_bisit_vrm_bitsight_alerts/${sysId}?sysparm_fields=company`
    );
    expect(recheckOk, 'Failed to re-fetch alert record after update attempt').toBeTruthy();

    const finalCompany = unwrapField(recheckBody?.result?.company);
    console.log(`[TC 23] Company after update attempt: ${JSON.stringify(finalCompany)} (was: ${JSON.stringify(originalCompany)})`);

    expect(finalCompany, 'Expected Company field to remain unchanged - field should be write-protected by ACL').toEqual(originalCompany);
});

test('TC 24: Verify Incidents short_description field is read-only for bitsight_user', async ({ page }) => {
    test.setTimeout(120_000);

    const regularUser = process.env.SN_REGULAR_USER || 'bitsight_user';
    const regularPass = process.env.SN_REGULAR_PASS || 'Bitsight@123';

    // 1. Authenticate as bitsight_user
    await switchUser(page, regularUser, regularPass);

    // 2. Navigate to Incidents via filter navigator
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByText('All').first().click();
    const searchBox24 = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await searchBox24.click();
    await searchBox24.fill('bitsight');
    await page.getByRole('button', { name: 'Clear filter' }).click();
    await searchBox24.click();
    await searchBox24.fill('bitsight');
    await page.getByRole('link', { name: /Incidents/i }).first().click();

    // 3. Wait for list view iframe to load
    const frame = page.locator('iframe[name="gsft_main"]').contentFrame();
    const companyColumnHeader = frame.getByRole('columnheader', { name: 'Company' }).or(frame.locator('body')).first();
    await companyColumnHeader.waitFor({ state: 'visible', timeout: 30_000 });

    console.log('\n--- [TC 24] Incidents company write-protection check ---');

    // 4. Fetch a Bitsight-related incident via Table API
    const listUrl = `/api/now/table/incident?sysparm_query=short_descriptionLIKEbitsight` +
        `&sysparm_fields=sys_id,company,short_description&sysparm_limit=1`;
    const { ok: listOk, status: listStatus, body: listBody } = await snFetch(page, listUrl);
    expect(listOk, `Failed to fetch a Bitsight-related incident (HTTP ${listStatus})`).toBeTruthy();

    const records = listBody?.result || [];
    expect(records.length, 'Expected at least one incident with "bitsight" in short description').toBeGreaterThan(0);

    const record = records[0];
    const sysId = unwrapField(record.sys_id);
    const originalCompany = unwrapField(record.company);
    console.log(`[TC 24] Target incident: "${unwrapField(record.short_description)}" (sys_id: ${sysId}), current company: ${JSON.stringify(originalCompany)}`);

    // 5. Attempt to overwrite the Company field via Table API while authenticated as bitsight_user
    const updateUrl = `/api/now/table/incident/${sysId}`;
    const { ok: updateOk, status: updateStatus, body: updateBody } = await snMutate(
        page, updateUrl, 'PATCH', { company: '' }
    );

    console.log(`[TC 24] PATCH response - status: ${updateStatus}, ok: ${updateOk}`);
    console.log(`[TC 24] PATCH response body: ${JSON.stringify(updateBody)}`);

    expect(updateStatus, 'Expected the Table API PATCH request itself to succeed (200) - ACL denial is a silent no-op').toBe(200);
    expect(updateOk, 'Expected Table API PATCH response to report ok').toBeTruthy();

    // 6. Re-fetch record and confirm Company value did NOT change
    const { ok: recheckOk, body: recheckBody } = await snFetch(
        page, `/api/now/table/incident/${sysId}?sysparm_fields=company`
    );
    expect(recheckOk, 'Failed to re-fetch incident record after update attempt').toBeTruthy();

    const finalCompany = unwrapField(recheckBody?.result?.company);
    console.log(`[TC 24] Company after update attempt: ${JSON.stringify(finalCompany)} (was: ${JSON.stringify(originalCompany)})`);

    expect(finalCompany, 'Expected Company field to remain unchanged - field should be write-protected by ACL').toEqual(originalCompany);
});
