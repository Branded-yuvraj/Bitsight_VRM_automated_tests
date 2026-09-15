import { test, expect } from '@playwright/test';
import { BitsightApiClient } from './utils/bitsight-api-client.js';
import { ServiceNowApiClient } from './utils/servicenow-api-client.js';
import { clearAlerts, clearIncidents } from './utils/cleanup-utils.js';

// Shared navigation: search for "bitsight" in the nav filter so module links are visible
async function filterBitsightModules(page) {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.getByText('All').first().click();

    await page.mouse.move(100, 100);
    await page.mouse.move(200, 200);

    const filter = page.getByRole('textbox', { name: 'Enter search term to filter' });
    await filter.click();
    await filter.fill('bitsight');
    await filter.press('Enter');
}

test.describe('Type 1 Token (CM) - Alerts Import & Incident Tests', () => {
    test('Bitsight Type 1 token (CM) validation', async ({ page }) => {
        test.setTimeout(300_000); // 5 minutes

        const token = process.env.CM_TOKEN;
        if (!token) {
            throw new Error('CM_TOKEN is not set in .env');
        }

    await filterBitsightModules(page);
    await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');

    const tokenInput = gsftFrame.locator('#token');
    const clearTokenButton = gsftFrame.getByRole('button', { name: 'Clear Token' });
    const okButton = gsftFrame.getByRole('button', { name: 'OK', exact: true });
    const validateButton = gsftFrame.getByRole('button', { name: 'Validate Token' });

    await tokenInput.click();

    // If a token is already present, clear it first
    const existingValue = await tokenInput.inputValue();
    if (existingValue.trim() !== '') {
        await clearTokenButton.click();
        await okButton.click();

        // Wait for the field to actually become empty
        await expect(tokenInput).toHaveValue('', { timeout: 30_000 });
    }

    // Fill the new token and trigger validation
    await tokenInput.fill(token);
    await validateButton.click();

    // Wait for the Success Dialog / Message to appear
    const successDialog = gsftFrame.getByRole('dialog', { name: /Success/i });
    const successText = gsftFrame.getByText(/API token validated/i);

    // Assert that the success message is displayed
    await expect(successText).toBeVisible({ timeout: 200_000 });

    // Click OK on the modal dialog to dismiss it
    const modalOkButton = successDialog.getByRole('button', { name: 'OK', exact: true })
        .or(gsftFrame.locator('.modal-dialog, [role="dialog"]').getByRole('button', { name: 'OK', exact: true }))
        .first();

    await modalOkButton.waitFor({ state: 'visible', timeout: 10_000 });
    await modalOkButton.click();

    // Ensure the modal has closed
    await expect(successText).not.toBeVisible({ timeout: 10_000 });

    // Verify the token input retains the token
    await expect(tokenInput).toHaveValue(token);
});

    test('TC-01 [Type 1]: Bitsight Alerts Import Reconciliation', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const token = process.env.CM_TOKEN;
        if (!token) {
            throw new Error('CM_TOKEN is not set in .env');
        }
        const bitsightClient = new BitsightApiClient({ token });
        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Pre-Step 2: Configure Application Properties
        console.log('\n=== Pre-Step 2: Configuring Application Properties ===');
        await filterBitsightModules(page);
        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('10');
    await configFrame.locator('#inc_score_y').check();
    await configFrame.locator('#incscoredrop').fill('5');
    
    // Note: check your DOM to verify if it is #critcal_alert_inc_y or #critical_alert_inc_y
    await configFrame.locator('#critcal_alert_inc_y').check();
    await configFrame.locator('#inc_warn_alert_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');

    // Set reference fields and press Enter so ServiceNow commits the sys_id
    const userInput = configFrame.locator('[id="sys_display.user"]');
    await userInput.fill('abel tuter');
    await userInput.press('Enter');

    const callerInput = configFrame.locator('[id="sys_display.caller"]');
    await callerInput.fill('abraham lincoln');
    await callerInput.press('Enter');

    // 2. Save and wait for page reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // Step 1: Capture Baseline Timestamps
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);
    const baselineTriggerTimestamp = new Date().toISOString();

    // Step 2: Trigger Scheduled Import
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await filterBitsightModules(page); // Ensure module list is visible
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');
    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` }).first();
    await importLink.waitFor({ state: 'visible', timeout: 30_000 });
    await importLink.click();

    const executeBtn = gsftFrame.getByRole('button', { name: 'Execute Now' });
    await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await executeBtn.click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // Step 3: Wait for Import Completion
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();
    const completionTimestamp = completeLog.sys_created_on;

    // Step 4: Fetch Bitsight Alerts Ground Truth Count
    console.log('\n=== Step 4: Fetching Bitsight Alerts Ground Truth Count ===');
    const alertsGroundTruth = await bitsightClient.getAlertsCount();
    const totalAlertsCount = typeof alertsGroundTruth === 'number' ? alertsGroundTruth : (alertsGroundTruth.count ?? alertsGroundTruth);
    console.log(`Bitsight Alerts Ground Truth Count: ${totalAlertsCount}`);

    // Step 5: Fetch ServiceNow Custom Alerts Table Count (Handling limits)
    console.log('\n=== Step 5: Fetching ServiceNow Alerts Table Count ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
        sysparm_limit: 10000, // Explicitly override default 250 limit
        fields: 'sys_id',
    });
    const snAlertsCount = snAlertsList.length;
    console.log(`ServiceNow alerts table record count: ${snAlertsCount}`);

    // Reconciliation Summary
    console.log('\n================================================================');
    console.log('       ALERTS IMPORT RECONCILIATION SUMMARY                     ');
    console.log('================================================================');
    console.table({
        'Bitsight Alerts Ground Truth Count': totalAlertsCount,
        'Actual ServiceNow Alerts Table Count': snAlertsCount,
        'Difference': Math.abs(snAlertsCount - totalAlertsCount),
    });

    expect(
        snAlertsCount,
        `Expected ServiceNow alerts table count (${snAlertsCount}) to match Bitsight Alerts ground truth count (${totalAlertsCount})`
    ).toBe(totalAlertsCount);
});

    test('TC-02 [Type 1]: Incident Creation for Public Disclosure alerts', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // -------------------------------------------------------------------------
        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // -------------------------------------------------------------------------
        // Pre-Step 2: Configure Application Properties and Read Saved Values
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 2: Configuring Application Properties ===');
        await filterBitsightModules(page);

        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('10');
    await configFrame.locator('#inc_score_n').check();
    await configFrame.locator('#critcal_alert_inc_y').check();
    await configFrame.locator('#inc_warn_alert_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await configFrame.getByText('Rules for Automation of Incident creation based on Bitsight AlertsMaximum').click();
    await page.waitForTimeout(10_000);

    // 2. Save and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // 3. Read back saved values
    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked(),
        markComp: await configFrame.locator('#mark_comp_y').isChecked(),
        maxPropertyInc: await configFrame.locator('#maxpropertyinc').inputValue(),
        incScore: await configFrame.locator('#inc_score_y').isChecked(),
        criticalAlertInc: await configFrame.locator('#critcal_alert_inc_y').isChecked(),
        incWarnAlert: await configFrame.locator('#inc_warn_alert_y').isChecked(),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue(),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue(),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Syslog Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import — selected by NAME, not position
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` });
    await importLink.first().click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion & Post-Script Execution
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();

    console.log('Waiting 30 seconds for post-import transform scripts to generate incidents...');
    await page.waitForTimeout(30_000);

    // -------------------------------------------------------------------------
    // Step 4: Fetch Imported Public Disclosure Alerts from ServiceNow
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching Public Disclosure Alerts in ServiceNow ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'type=PUBLIC_DISCLOSURE' });
    const expectedIncidentCount = snAlertsList.length;
    console.log(`Public Disclosure Alerts retrieved from ServiceNow table (type=PUBLIC_DISCLOSURE): ${expectedIncidentCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Verify Corresponding ServiceNow Incident Creation
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
    const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^x_bisit_vrm_bitsight_alert.alert_displaySTARTSWITHPublic Disclosure');
    const actualIncidentCount = incidents.length;
    console.log(`Found ${actualIncidentCount} incident(s) matching "short_descriptionLIKEbitsight^x_bisit_vrm_bitsight_alert.alert_displaySTARTSWITHPublic Disclosure".`);

    console.log('\n================================================================');
    console.log('   PUBLIC DISCLOSURE ALERTS INCIDENT CREATION RECONCILIATION SUMMARY ');
    console.log('================================================================');
    console.table({
        'Total Imported Public Disclosure Alerts in ServiceNow': expectedIncidentCount,
        'Actual Incidents Created in ServiceNow': actualIncidentCount,
        'Difference': Math.abs(actualIncidentCount - expectedIncidentCount),
    });

    expect(
        actualIncidentCount,
        `Expected ${expectedIncidentCount} incident(s) to be created for Public Disclosure alerts, but found ${actualIncidentCount}`
    ).toBe(expectedIncidentCount);
});

    test('TC-03 [Type 1]: Incident Creation for Critical Severity alerts based on Application Configuration', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // -------------------------------------------------------------------------
        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // -------------------------------------------------------------------------
        // Pre-Step 2: Configure Application Properties and Read Saved Values
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 2: Configuring Application Properties ===');
        await filterBitsightModules(page);

        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values: Enable Critical alert trigger, disable score drop and warning triggers
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('25');
    await configFrame.locator('#inc_score_n').check();
    await configFrame.locator('#critcal_alert_inc_y').check();
    await configFrame.locator('#inc_warn_alert_n').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await configFrame.getByText('Rules for Automation of Incident creation based on Bitsight AlertsMaximum').click();
    await page.waitForTimeout(10_000);

    // 2. Save and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // 3. Read back saved configurations dynamically
    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked(),
        markComp: await configFrame.locator('#mark_comp_y').isChecked(),
        maxPropertyInc: await configFrame.locator('#maxpropertyinc').inputValue(),
        incScore: await configFrame.locator('#inc_score_y').isChecked(),
        criticalAlertInc: await configFrame.locator('#critcal_alert_inc_y').isChecked(),
        incWarnAlert: await configFrame.locator('#inc_warn_alert_y').isChecked(),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue(),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue(),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 10;
    console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Syslog Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import — selected by NAME, not position
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` });
    await importLink.first().click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion & Post-Script Execution
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();

    console.log('Waiting 30 seconds for post-import transform scripts to generate incidents...');
    await page.waitForTimeout(30_000);

    // -------------------------------------------------------------------------
    // Step 4: Fetch Imported Alerts from ServiceNow and Filter by Critical Severity & Age Threshold
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching and Filtering Critical Alerts in ServiceNow ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=CRITICAL' });
    console.log(`Total imported CRITICAL alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

    // Dynamic cutoff date based on saved maxPropertyInc days
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);
    const cutoffDateStr = cutoffTime.toISOString().split('T')[0];
    console.log(`Alert Date Cutoff Threshold: >= ${cutoffDateStr} (within last ${maxDays} days)`);

    const eligibleCriticalAlerts = snAlertsList.filter((record) => {
        const severity = (record.severity || record.u_severity || '').toString().toUpperCase();
        const isCritical = severity === 'CRITICAL';

        const alertDateRaw = (record.alert_date || record.u_alert_date || '').toString();
        const alertDateStr = alertDateRaw.split(' ')[0].split('T')[0];
        const isWithinAge = alertDateStr && alertDateStr >= cutoffDateStr;

        return isCritical && isWithinAge;
    });

    const expectedIncidentCount = eligibleCriticalAlerts.length;
    console.log(`Eligible Critical Alerts (severity=CRITICAL AND alert_date >= ${cutoffDateStr}): ${expectedIncidentCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Verify Corresponding ServiceNow Incident Creation
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
    const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKECritical');
    const actualIncidentCount = incidents.length;
    console.log(`Found ${actualIncidentCount} incident(s) matching "short_descriptionLIKEbitsight^descriptionLIKECritical".`);

    console.log('\n================================================================');
    console.log('   CRITICAL ALERTS INCIDENT CREATION RECONCILIATION SUMMARY     ');
    console.log('================================================================');
    console.table({
        'Configured Max Age (Days)': maxDays,
        'Alert Date Cutoff Threshold': cutoffDateStr,
        'Total Imported CRITICAL Alerts in ServiceNow': snAlertsList.length,
        'Eligible Critical Alerts (Expected Incidents)': expectedIncidentCount,
        'Actual Incidents Created in ServiceNow': actualIncidentCount,
        'Difference': Math.abs(actualIncidentCount - expectedIncidentCount),
    });

    expect(
        actualIncidentCount,
        `Expected ${expectedIncidentCount} incident(s) to be created for Critical alerts within ${maxDays} days, but found ${actualIncidentCount}`
    ).toBe(expectedIncidentCount);
});

    test('TC-04 [Type 1]: Incident Creation for Warn Severity alerts based on Application Configuration', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // -------------------------------------------------------------------------
        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // -------------------------------------------------------------------------
        // Pre-Step 2: Configure Application Properties and Read Saved Values
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 2: Configuring Application Properties ===');
        await filterBitsightModules(page);

        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values: Enable Warn alert trigger, disable score drop and critical triggers
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('10');
    await configFrame.locator('#inc_score_n').check();
    await configFrame.locator('#critcal_alert_inc_n').check();
    await configFrame.locator('#inc_warn_alert_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await configFrame.getByText('Rules for Automation of Incident creation based on Bitsight AlertsMaximum').click();
    await page.waitForTimeout(10_000);

    // 2. Save and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // 3. Read back saved configurations dynamically
    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked(),
        markComp: await configFrame.locator('#mark_comp_y').isChecked(),
        maxPropertyInc: await configFrame.locator('#maxpropertyinc').inputValue(),
        incScore: await configFrame.locator('#inc_score_y').isChecked(),
        criticalAlertInc: await configFrame.locator('#critcal_alert_inc_y').isChecked(),
        incWarnAlert: await configFrame.locator('#inc_warn_alert_y').isChecked(),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue(),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue(),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 7;
    console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Syslog Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import — selected by NAME, not position
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` });
    await importLink.first().click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion & Post-Script Execution
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();

    console.log('Waiting 30 seconds for post-import transform scripts to generate incidents...');
    await page.waitForTimeout(30_000);

    // -------------------------------------------------------------------------
    // Step 4: Fetch Imported Warn Severity Alerts from ServiceNow and Filter by Age Threshold
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching and Filtering Warn Alerts in ServiceNow ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=WARN' });
    console.log(`Total imported WARN alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

    // Dynamic cutoff date based on saved maxPropertyInc days
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);
    const cutoffDateStr = cutoffTime.toISOString().split('T')[0];
    console.log(`Alert Date Cutoff Threshold: >= ${cutoffDateStr} (within last ${maxDays} days)`);

    const eligibleWarnAlerts = snAlertsList.filter((record) => {
        const severity = (record.severity || record.u_severity || '').toString().toUpperCase();
        const isWarn = severity === 'WARN' || severity === 'WARNING';

        const alertDateRaw = (record.alert_date || record.u_alert_date || '').toString();
        const alertDateStr = alertDateRaw.split(' ')[0].split('T')[0];
        const isWithinAge = alertDateStr && alertDateStr >= cutoffDateStr;

        return isWarn && isWithinAge;
    });

    const expectedIncidentCount = eligibleWarnAlerts.length;
    console.log(`Eligible Warn Alerts (severity=WARN AND alert_date >= ${cutoffDateStr}): ${expectedIncidentCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Verify Corresponding ServiceNow Incident Creation
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
    const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKEWarning');
    const actualIncidentCount = incidents.length;
    console.log(`Found ${actualIncidentCount} incident(s) matching "short_descriptionLIKEbitsight^descriptionLIKEWarning".`);

    console.log('\n================================================================');
    console.log('      WARN ALERTS INCIDENT CREATION RECONCILIATION SUMMARY      ');
    console.log('================================================================');
    console.table({
        'Configured Max Age (Days)': maxDays,
        'Alert Date Cutoff Threshold': cutoffDateStr,
        'Total Imported WARN Alerts in ServiceNow': snAlertsList.length,
        'Eligible Warn Alerts (Expected Incidents)': expectedIncidentCount,
        'Actual Incidents Created in ServiceNow': actualIncidentCount,
        'Difference': Math.abs(actualIncidentCount - expectedIncidentCount),
    });

    expect(
        actualIncidentCount,
        `Expected ${expectedIncidentCount} incident(s) to be created for Warn alerts within ${maxDays} days, but found ${actualIncidentCount}`
    ).toBe(expectedIncidentCount);
});

    test('TC-05 [Type 1]: Incident Creation when both Critical and Warn Severity alert triggers are enabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // -------------------------------------------------------------------------
        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // -------------------------------------------------------------------------
        // Pre-Step 2: Configure Application Properties and Read Saved Values
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 2: Configuring Application Properties (Both Flags = True) ===');
        await filterBitsightModules(page);

        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values: Enable BOTH Critical and Warn alert triggers, disable score drop trigger
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('15');
    await configFrame.locator('#inc_score_n').check();
    await configFrame.locator('#critcal_alert_inc_y').check();
    await configFrame.locator('#inc_warn_alert_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await page.waitForTimeout(10_000);

    // 2. Save and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // 3. Read back saved configurations dynamically
    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked(),
        markComp: await configFrame.locator('#mark_comp_y').isChecked(),
        maxPropertyInc: await configFrame.locator('#maxpropertyinc').inputValue(),
        incScore: await configFrame.locator('#inc_score_y').isChecked(),
        criticalAlertInc: await configFrame.locator('#critcal_alert_inc_y').isChecked(),
        incWarnAlert: await configFrame.locator('#inc_warn_alert_y').isChecked(),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue(),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue(),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    expect(savedConfig.criticalAlertInc, 'Critical alert incident creation should be enabled (true)').toBe(true);
    expect(savedConfig.incWarnAlert, 'Warn alert incident creation should be enabled (true)').toBe(true);

    const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 15;
    console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Syslog Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import — selected by NAME, not position
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` });
    await importLink.first().click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion & Post-Script Execution
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 10_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();

    console.log('Waiting 30 seconds for post-import transform scripts to generate incidents...');
    await page.waitForTimeout(30_000);

    // -------------------------------------------------------------------------
    // Step 4: Fetch Imported Alerts from ServiceNow and Filter by Critical & Warn Severity & Age Threshold
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching and Filtering Critical & Warn Alerts in ServiceNow ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
        query: 'severity=CRITICAL^ORseverity=WARN^ORseverity=WARNING',
    });
    console.log(`Total imported CRITICAL and WARN alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

    // Dynamic cutoff date based on saved maxPropertyInc days
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);
    const cutoffDateStr = cutoffTime.toISOString().split('T')[0];
    console.log(`Alert Date Cutoff Threshold: >= ${cutoffDateStr} (within last ${maxDays} days)`);

    const eligibleCriticalAlerts = snAlertsList.filter((record) => {
        const severity = (record.severity || record.u_severity || '').toString().toUpperCase();
        const isCritical = severity === 'CRITICAL';

        const alertDateRaw = (record.alert_date || record.u_alert_date || '').toString();
        const alertDateStr = alertDateRaw.split(' ')[0].split('T')[0];
        const isWithinAge = alertDateStr && alertDateStr >= cutoffDateStr;

        return isCritical && isWithinAge;
    });

    const eligibleWarnAlerts = snAlertsList.filter((record) => {
        const severity = (record.severity || record.u_severity || '').toString().toUpperCase();
        const isWarn = severity === 'WARN' || severity === 'WARNING';

        const alertDateRaw = (record.alert_date || record.u_alert_date || '').toString();
        const alertDateStr = alertDateRaw.split(' ')[0].split('T')[0];
        const isWithinAge = alertDateStr && alertDateStr >= cutoffDateStr;

        return isWarn && isWithinAge;
    });

    const expectedCriticalCount = eligibleCriticalAlerts.length;
    const expectedWarnCount = eligibleWarnAlerts.length;
    const totalExpectedIncidentCount = expectedCriticalCount + expectedWarnCount;

    console.log(`Eligible Critical Alerts (severity=CRITICAL AND alert_date >= ${cutoffDateStr}): ${expectedCriticalCount}`);
    console.log(`Eligible Warn Alerts (severity=WARN AND alert_date >= ${cutoffDateStr}): ${expectedWarnCount}`);
    console.log(`Total Expected Incidents (Critical + Warn): ${totalExpectedIncidentCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Verify Corresponding ServiceNow Incident Creation (Critical + Warn only)
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
    const criticalIncidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKECritical');
    const warnIncidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKEWarning');
    const totalAlertIncidents = criticalIncidents.concat(warnIncidents);

    const actualCriticalCount = criticalIncidents.length;
    const actualWarnCount = warnIncidents.length;
    const actualTotalCount = totalAlertIncidents.length;

    console.log(`Found ${actualCriticalCount} Critical incident(s).`);
    console.log(`Found ${actualWarnCount} Warn incident(s).`);
    console.log(`Found ${actualTotalCount} Total Critical + Warn incident(s).`);

    console.log('\n================================================================');
    console.log('   CRITICAL + WARN ALERTS INCIDENT CREATION RECONCILIATION SUMMARY  ');
    console.log('================================================================');
    console.table({
        'Configured Max Age (Days)': maxDays,
        'Alert Date Cutoff Threshold': cutoffDateStr,
        'Total Imported Critical & Warn Alerts in ServiceNow': snAlertsList.length,
        'Eligible Critical Alerts (Expected)': expectedCriticalCount,
        'Actual Critical Incidents Created': actualCriticalCount,
        'Eligible Warn Alerts (Expected)': expectedWarnCount,
        'Actual Warn Incidents Created': actualWarnCount,
        'Total Expected Incidents (Critical + Warn)': totalExpectedIncidentCount,
        'Total Actual Incidents (Critical + Warn)': actualTotalCount,
        'Total Difference': Math.abs(actualTotalCount - totalExpectedIncidentCount),
    });

    expect(
        actualCriticalCount,
        `Expected ${expectedCriticalCount} Critical alert incident(s), but found ${actualCriticalCount}`
    ).toBe(expectedCriticalCount);

    expect(
        actualWarnCount,
        `Expected ${expectedWarnCount} Warn alert incident(s), but found ${actualWarnCount}`
    ).toBe(expectedWarnCount);

        expect(
            actualTotalCount,
            `Expected ${totalExpectedIncidentCount} total (Critical + Warn) alert incident(s), but found ${actualTotalCount}`
        ).toBe(totalExpectedIncidentCount);
    });
});

test.describe('Type 3 Token (CM + VRM) - Alerts Import & Incident Tests', () => {
    test('Bitsight Type 3 token (CM + VRM) validation', async ({ page }) => {
        test.setTimeout(300_000); // 5 minutes

        const token = process.env.CMVRM_TOKEN;
        if (!token) {
            throw new Error('CMVRM_TOKEN is not set in .env');
        }

        await filterBitsightModules(page);
        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');

    const tokenInput = gsftFrame.locator('#token');
    const clearTokenButton = gsftFrame.getByRole('button', { name: 'Clear Token' });
    const okButton = gsftFrame.getByRole('button', { name: 'OK', exact: true });
    const validateButton = gsftFrame.getByRole('button', { name: 'Validate Token' });

    await tokenInput.click();

    // If a token is already present, clear it first
    const existingValue = await tokenInput.inputValue();
    if (existingValue.trim() !== '') {
        await clearTokenButton.click();
        await okButton.click();

        // Wait for the field to actually become empty
        await expect(tokenInput).toHaveValue('', { timeout: 30_000 });
    }

    await tokenInput.fill(token);
    await validateButton.click();

    // Validation can take a while — wait for success dialog
    const successDialog = gsftFrame.getByRole('dialog', { name: 'Success' });
    await expect(successDialog.or(gsftFrame.getByText('Token validated successfully'))).toBeVisible({
        timeout: 200_000,
    });

    const successOkButton = successDialog.getByRole('button', { name: 'OK', exact: true });
    if (await successOkButton.isVisible()) {
        await successOkButton.click();
    }

    await expect(tokenInput).toHaveValue(token);
});

    test('TC-01 [Type 3]: Bitsight Alerts Import Reconciliation', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const token = process.env.CMVRM_TOKEN;
        if (!token) {
            throw new Error('CMVRM_TOKEN is not set in .env');
        }
        const bitsightClient = new BitsightApiClient({ token });
        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Pre-Step 2: Configure Application Properties
        console.log('\n=== Pre-Step 2: Configuring Application Properties ===');
        await filterBitsightModules(page);
        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('10');
    await configFrame.locator('#inc_score_y').check();
    await configFrame.locator('#incscoredrop').fill('5');
    
    // Note: check your DOM to verify if it is #critcal_alert_inc_y or #critical_alert_inc_y
    await configFrame.locator('#critcal_alert_inc_y').check();
    await configFrame.locator('#inc_warn_alert_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');

    // Set reference fields and press Enter so ServiceNow commits the sys_id
    const userInput = configFrame.locator('[id="sys_display.user"]');
    await userInput.fill('abel tuter');
    await userInput.press('Enter');

    const callerInput = configFrame.locator('[id="sys_display.caller"]');
    await callerInput.fill('abraham lincoln');
    await callerInput.press('Enter');

    // 2. Save and wait for page reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // Step 1: Capture Baseline Timestamps
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);
    const baselineTriggerTimestamp = new Date().toISOString();

    // Step 2: Trigger Scheduled Import
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await filterBitsightModules(page); // Ensure module list is visible
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');
    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` }).first();
    await importLink.waitFor({ state: 'visible', timeout: 30_000 });
    await importLink.click();

    const executeBtn = gsftFrame.getByRole('button', { name: 'Execute Now' });
    await executeBtn.waitFor({ state: 'visible', timeout: 30_000 });
    await executeBtn.click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // Step 3: Wait for Import Completion
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();
    const completionTimestamp = completeLog.sys_created_on;

    // Step 4: Fetch Bitsight Alerts Ground Truth Count
    console.log('\n=== Step 4: Fetching Bitsight Alerts Ground Truth Count ===');
    const alertsGroundTruth = await bitsightClient.getAlertsCount();
    const totalAlertsCount = typeof alertsGroundTruth === 'number' ? alertsGroundTruth : (alertsGroundTruth.count ?? alertsGroundTruth);
    console.log(`Bitsight Alerts Ground Truth Count: ${totalAlertsCount}`);

    // Step 5: Fetch ServiceNow Custom Alerts Table Count (Handling limits)
    console.log('\n=== Step 5: Fetching ServiceNow Alerts Table Count ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
        sysparm_limit: 10000, // Explicitly override default 250 limit
        fields: 'sys_id',
    });
    const snAlertsCount = snAlertsList.length;
    console.log(`ServiceNow alerts table record count: ${snAlertsCount}`);

    // Reconciliation Summary
    console.log('\n================================================================');
    console.log('       ALERTS IMPORT RECONCILIATION SUMMARY                     ');
    console.log('================================================================');
    console.table({
        'Bitsight Alerts Ground Truth Count': totalAlertsCount,
        'Actual ServiceNow Alerts Table Count': snAlertsCount,
        'Difference': Math.abs(snAlertsCount - totalAlertsCount),
    });

    expect(
        snAlertsCount,
        `Expected ServiceNow alerts table count (${snAlertsCount}) to match Bitsight Alerts ground truth count (${totalAlertsCount})`
    ).toBe(totalAlertsCount);
});

    test('TC-02 [Type 3]: Incident Creation for Public Disclosure alerts', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // -------------------------------------------------------------------------
        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // -------------------------------------------------------------------------
        // Pre-Step 2: Configure Application Properties and Read Saved Values
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 2: Configuring Application Properties ===');
        await filterBitsightModules(page);

        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('10');
    await configFrame.locator('#inc_score_n').check();
    await configFrame.locator('#critcal_alert_inc_y').check();
    await configFrame.locator('#inc_warn_alert_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await configFrame.getByText('Rules for Automation of Incident creation based on Bitsight AlertsMaximum').click();
    await page.waitForTimeout(10_000);

    // 2. Save and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // 3. Read back saved values
    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked(),
        markComp: await configFrame.locator('#mark_comp_y').isChecked(),
        maxPropertyInc: await configFrame.locator('#maxpropertyinc').inputValue(),
        incScore: await configFrame.locator('#inc_score_y').isChecked(),
        criticalAlertInc: await configFrame.locator('#critcal_alert_inc_y').isChecked(),
        incWarnAlert: await configFrame.locator('#inc_warn_alert_y').isChecked(),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue(),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue(),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Syslog Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import — selected by NAME, not position
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` });
    await importLink.first().click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion & Post-Script Execution
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();

    console.log('Waiting 30 seconds for post-import transform scripts to generate incidents...');
    await page.waitForTimeout(30_000);

    // -------------------------------------------------------------------------
    // Step 4: Fetch Imported Public Disclosure Alerts from ServiceNow
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching Public Disclosure Alerts in ServiceNow ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'type=PUBLIC_DISCLOSURE' });
    const expectedIncidentCount = snAlertsList.length;
    console.log(`Public Disclosure Alerts retrieved from ServiceNow table (type=PUBLIC_DISCLOSURE): ${expectedIncidentCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Verify Corresponding ServiceNow Incident Creation
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
    const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^x_bisit_vrm_bitsight_alert.alert_displaySTARTSWITHPublic Disclosure');
    const actualIncidentCount = incidents.length;
    console.log(`Found ${actualIncidentCount} incident(s) matching "short_descriptionLIKEbitsight^x_bisit_vrm_bitsight_alert.alert_displaySTARTSWITHPublic Disclosure".`);

    console.log('\n================================================================');
    console.log('   PUBLIC DISCLOSURE ALERTS INCIDENT CREATION RECONCILIATION SUMMARY ');
    console.log('================================================================');
    console.table({
        'Total Imported Public Disclosure Alerts in ServiceNow': expectedIncidentCount,
        'Actual Incidents Created in ServiceNow': actualIncidentCount,
        'Difference': Math.abs(actualIncidentCount - expectedIncidentCount),
    });

    expect(
        actualIncidentCount,
        `Expected ${expectedIncidentCount} incident(s) to be created for Public Disclosure alerts, but found ${actualIncidentCount}`
    ).toBe(expectedIncidentCount);
});

    test('TC-03 [Type 3]: Incident Creation for Critical Severity alerts based on Application Configuration', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // -------------------------------------------------------------------------
        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // -------------------------------------------------------------------------
        // Pre-Step 2: Configure Application Properties and Read Saved Values
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 2: Configuring Application Properties ===');
        await filterBitsightModules(page);

        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values: Enable Critical alert trigger, disable score drop and warning triggers
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('25');
    await configFrame.locator('#inc_score_n').check();
    await configFrame.locator('#critcal_alert_inc_y').check();
    await configFrame.locator('#inc_warn_alert_n').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await configFrame.getByText('Rules for Automation of Incident creation based on Bitsight AlertsMaximum').click();
    await page.waitForTimeout(10_000);

    // 2. Save and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // 3. Read back saved configurations dynamically
    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked(),
        markComp: await configFrame.locator('#mark_comp_y').isChecked(),
        maxPropertyInc: await configFrame.locator('#maxpropertyinc').inputValue(),
        incScore: await configFrame.locator('#inc_score_y').isChecked(),
        criticalAlertInc: await configFrame.locator('#critcal_alert_inc_y').isChecked(),
        incWarnAlert: await configFrame.locator('#inc_warn_alert_y').isChecked(),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue(),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue(),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 10;
    console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Syslog Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import — selected by NAME, not position
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` });
    await importLink.first().click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion & Post-Script Execution
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();

    console.log('Waiting 30 seconds for post-import transform scripts to generate incidents...');
    await page.waitForTimeout(30_000);

    // -------------------------------------------------------------------------
    // Step 4: Fetch Imported Alerts from ServiceNow and Filter by Critical Severity & Age Threshold
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching and Filtering Critical Alerts in ServiceNow ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=CRITICAL' });
    console.log(`Total imported CRITICAL alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

    // Dynamic cutoff date based on saved maxPropertyInc days
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);
    const cutoffDateStr = cutoffTime.toISOString().split('T')[0];
    console.log(`Alert Date Cutoff Threshold: >= ${cutoffDateStr} (within last ${maxDays} days)`);

    const eligibleCriticalAlerts = snAlertsList.filter((record) => {
        const severity = (record.severity || record.u_severity || '').toString().toUpperCase();
        const isCritical = severity === 'CRITICAL';

        const alertDateRaw = (record.alert_date || record.u_alert_date || '').toString();
        const alertDateStr = alertDateRaw.split(' ')[0].split('T')[0];
        const isWithinAge = alertDateStr && alertDateStr >= cutoffDateStr;

        return isCritical && isWithinAge;
    });

    const expectedIncidentCount = eligibleCriticalAlerts.length;
    console.log(`Eligible Critical Alerts (severity=CRITICAL AND alert_date >= ${cutoffDateStr}): ${expectedIncidentCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Verify Corresponding ServiceNow Incident Creation
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
    const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKECritical');
    const actualIncidentCount = incidents.length;
    console.log(`Found ${actualIncidentCount} incident(s) matching "short_descriptionLIKEbitsight^descriptionLIKECritical".`);

    console.log('\n================================================================');
    console.log('   CRITICAL ALERTS INCIDENT CREATION RECONCILIATION SUMMARY     ');
    console.log('================================================================');
    console.table({
        'Configured Max Age (Days)': maxDays,
        'Alert Date Cutoff Threshold': cutoffDateStr,
        'Total Imported CRITICAL Alerts in ServiceNow': snAlertsList.length,
        'Eligible Critical Alerts (Expected Incidents)': expectedIncidentCount,
        'Actual Incidents Created in ServiceNow': actualIncidentCount,
        'Difference': Math.abs(actualIncidentCount - expectedIncidentCount),
    });

    expect(
        actualIncidentCount,
        `Expected ${expectedIncidentCount} incident(s) to be created for Critical alerts within ${maxDays} days, but found ${actualIncidentCount}`
    ).toBe(expectedIncidentCount);
});

    test('TC-04 [Type 3]: Incident Creation for Warn Severity alerts based on Application Configuration', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // -------------------------------------------------------------------------
        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // -------------------------------------------------------------------------
        // Pre-Step 2: Configure Application Properties and Read Saved Values
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 2: Configuring Application Properties ===');
        await filterBitsightModules(page);

        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values: Enable Warn alert trigger, disable score drop and critical triggers
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('10');
    await configFrame.locator('#inc_score_n').check();
    await configFrame.locator('#critcal_alert_inc_n').check();
    await configFrame.locator('#inc_warn_alert_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await configFrame.getByText('Rules for Automation of Incident creation based on Bitsight AlertsMaximum').click();
    await page.waitForTimeout(10_000);

    // 2. Save and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // 3. Read back saved configurations dynamically
    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked(),
        markComp: await configFrame.locator('#mark_comp_y').isChecked(),
        maxPropertyInc: await configFrame.locator('#maxpropertyinc').inputValue(),
        incScore: await configFrame.locator('#inc_score_y').isChecked(),
        criticalAlertInc: await configFrame.locator('#critcal_alert_inc_y').isChecked(),
        incWarnAlert: await configFrame.locator('#inc_warn_alert_y').isChecked(),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue(),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue(),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 7;
    console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Syslog Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import — selected by NAME, not position
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` });
    await importLink.first().click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion & Post-Script Execution
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 15_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();

    console.log('Waiting 30 seconds for post-import transform scripts to generate incidents...');
    await page.waitForTimeout(30_000);

    // -------------------------------------------------------------------------
    // Step 4: Fetch Imported Warn Severity Alerts from ServiceNow and Filter by Age Threshold
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching and Filtering Warn Alerts in ServiceNow ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=WARN' });
    console.log(`Total imported WARN alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

    // Dynamic cutoff date based on saved maxPropertyInc days
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);
    const cutoffDateStr = cutoffTime.toISOString().split('T')[0];
    console.log(`Alert Date Cutoff Threshold: >= ${cutoffDateStr} (within last ${maxDays} days)`);

    const eligibleWarnAlerts = snAlertsList.filter((record) => {
        const severity = (record.severity || record.u_severity || '').toString().toUpperCase();
        const isWarn = severity === 'WARN' || severity === 'WARNING';

        const alertDateRaw = (record.alert_date || record.u_alert_date || '').toString();
        const alertDateStr = alertDateRaw.split(' ')[0].split('T')[0];
        const isWithinAge = alertDateStr && alertDateStr >= cutoffDateStr;

        return isWarn && isWithinAge;
    });

    const expectedIncidentCount = eligibleWarnAlerts.length;
    console.log(`Eligible Warn Alerts (severity=WARN AND alert_date >= ${cutoffDateStr}): ${expectedIncidentCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Verify Corresponding ServiceNow Incident Creation
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
    const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKEWarning');
    const actualIncidentCount = incidents.length;
    console.log(`Found ${actualIncidentCount} incident(s) matching "short_descriptionLIKEbitsight^descriptionLIKEWarning".`);

    console.log('\n================================================================');
    console.log('      WARN ALERTS INCIDENT CREATION RECONCILIATION SUMMARY      ');
    console.log('================================================================');
    console.table({
        'Configured Max Age (Days)': maxDays,
        'Alert Date Cutoff Threshold': cutoffDateStr,
        'Total Imported WARN Alerts in ServiceNow': snAlertsList.length,
        'Eligible Warn Alerts (Expected Incidents)': expectedIncidentCount,
        'Actual Incidents Created in ServiceNow': actualIncidentCount,
        'Difference': Math.abs(actualIncidentCount - expectedIncidentCount),
    });

    expect(
        actualIncidentCount,
        `Expected ${expectedIncidentCount} incident(s) to be created for Warn alerts within ${maxDays} days, but found ${actualIncidentCount}`
    ).toBe(expectedIncidentCount);
});

    test('TC-05 [Type 3]: Incident Creation when both Critical and Warn Severity alert triggers are enabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        const IMPORT_JOB_NAME = 'Bitsight Alerts Import';
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // -------------------------------------------------------------------------
        // Pre-Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // -------------------------------------------------------------------------
        // Pre-Step 2: Configure Application Properties and Read Saved Values
        // -------------------------------------------------------------------------
        console.log('\n=== Pre-Step 2: Configuring Application Properties (Both Flags = True) ===');
        await filterBitsightModules(page);

        await page.getByRole('link', { name: /^Application Configuration \d+ of \d+$/ }).click();

    const configFrame = page.frameLocator('iframe[name="gsft_main"]');

    // 1. Set form values: Enable BOTH Critical and Warn alert triggers, disable score drop trigger
    await configFrame.locator('#ins_company_y').check();
    await configFrame.locator('#mark_comp_y').check();
    await configFrame.locator('#maxpropertyinc').fill('15');
    await configFrame.locator('#inc_score_n').check();
    await configFrame.locator('#critcal_alert_inc_y').check();
    await configFrame.locator('#inc_warn_alert_y').check();
    await configFrame.locator('#assign-incident').selectOption('user');
    await configFrame.locator('[id="sys_display.user"]').click();
    await configFrame.locator('[id="sys_display.user"]').fill('');
    await configFrame.locator('[id="sys_display.user"]').fill('abel tuter');
    await configFrame.locator('[id="sys_display.caller"]').click();
    await configFrame.locator('[id="sys_display.caller"]').fill('');
    await configFrame.locator('[id="sys_display.caller"]').fill('abraham lincoln');
    await page.waitForTimeout(10_000);

    // 2. Save and wait for reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // 3. Read back saved configurations dynamically
    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked(),
        markComp: await configFrame.locator('#mark_comp_y').isChecked(),
        maxPropertyInc: await configFrame.locator('#maxpropertyinc').inputValue(),
        incScore: await configFrame.locator('#inc_score_y').isChecked(),
        criticalAlertInc: await configFrame.locator('#critcal_alert_inc_y').isChecked(),
        incWarnAlert: await configFrame.locator('#inc_warn_alert_y').isChecked(),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue(),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue(),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    expect(savedConfig.criticalAlertInc, 'Critical alert incident creation should be enabled (true)').toBe(true);
    expect(savedConfig.incWarnAlert, 'Warn alert incident creation should be enabled (true)').toBe(true);

    const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 15;
    console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

    // -------------------------------------------------------------------------
    // Step 1: Capture Baseline Syslog Timestamp
    // -------------------------------------------------------------------------
    console.log('\n=== Step 1: Capturing Baseline Timestamps ===');
    const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);

    // -------------------------------------------------------------------------
    // Step 2: Trigger Scheduled Import — selected by NAME, not position
    // -------------------------------------------------------------------------
    console.log('\n=== Step 2: Triggering Scheduled Bitsight Alerts Import ===');
    await page.getByRole('link', { name: /^Scheduled Data Imports \d+ of \d+$/ }).click();

    const gsftFrame = page.locator('iframe[name="gsft_main"]').contentFrame();

    const importLink = gsftFrame.getByRole('link', { name: `Open record: ${IMPORT_JOB_NAME}` });
    await importLink.first().click();
    await gsftFrame.getByRole('button', { name: 'Execute Now' }).click();
    console.log(`Triggered "Execute Now" for ${IMPORT_JOB_NAME}.`);

    // -------------------------------------------------------------------------
    // Step 3: Wait for Import Completion & Post-Script Execution
    // -------------------------------------------------------------------------
    console.log('\n=== Step 3: Waiting for Alerts Import Completion in syslog ===');
    const completeLog = await serviceNowClient.waitForImportCompletion(page, {
        baselineTimestamp: baselineSyslogTimestamp,
        logMessage: COMPLETION_LOG_MESSAGE,
        timeoutMs: 1_500_000,
        pollIntervalMs: 10_000,
    });
    expect(completeLog, 'Alerts import completion log should be found').toBeTruthy();

    console.log('Waiting 30 seconds for post-import transform scripts to generate incidents...');
    await page.waitForTimeout(30_000);

    // -------------------------------------------------------------------------
    // Step 4: Fetch Imported Alerts from ServiceNow and Filter by Critical & Warn Severity & Age Threshold
    // -------------------------------------------------------------------------
    console.log('\n=== Step 4: Fetching and Filtering Critical & Warn Alerts in ServiceNow ===');
    const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
        query: 'severity=CRITICAL^ORseverity=WARN^ORseverity=WARNING',
    });
    console.log(`Total imported CRITICAL and WARN alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

    // Dynamic cutoff date based on saved maxPropertyInc days
    const now = new Date();
    const cutoffTime = new Date(now.getTime() - maxDays * 24 * 60 * 60 * 1000);
    const cutoffDateStr = cutoffTime.toISOString().split('T')[0];
    console.log(`Alert Date Cutoff Threshold: >= ${cutoffDateStr} (within last ${maxDays} days)`);

    const eligibleCriticalAlerts = snAlertsList.filter((record) => {
        const severity = (record.severity || record.u_severity || '').toString().toUpperCase();
        const isCritical = severity === 'CRITICAL';

        const alertDateRaw = (record.alert_date || record.u_alert_date || '').toString();
        const alertDateStr = alertDateRaw.split(' ')[0].split('T')[0];
        const isWithinAge = alertDateStr && alertDateStr >= cutoffDateStr;

        return isCritical && isWithinAge;
    });

    const eligibleWarnAlerts = snAlertsList.filter((record) => {
        const severity = (record.severity || record.u_severity || '').toString().toUpperCase();
        const isWarn = severity === 'WARN' || severity === 'WARNING';

        const alertDateRaw = (record.alert_date || record.u_alert_date || '').toString();
        const alertDateStr = alertDateRaw.split(' ')[0].split('T')[0];
        const isWithinAge = alertDateStr && alertDateStr >= cutoffDateStr;

        return isWarn && isWithinAge;
    });

    const expectedCriticalCount = eligibleCriticalAlerts.length;
    const expectedWarnCount = eligibleWarnAlerts.length;
    const totalExpectedIncidentCount = expectedCriticalCount + expectedWarnCount;

    console.log(`Eligible Critical Alerts (severity=CRITICAL AND alert_date >= ${cutoffDateStr}): ${expectedCriticalCount}`);
    console.log(`Eligible Warn Alerts (severity=WARN AND alert_date >= ${cutoffDateStr}): ${expectedWarnCount}`);
    console.log(`Total Expected Incidents (Critical + Warn): ${totalExpectedIncidentCount}`);

    // -------------------------------------------------------------------------
    // Step 5: Verify Corresponding ServiceNow Incident Creation (Critical + Warn only)
    // -------------------------------------------------------------------------
    console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
    const criticalIncidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKECritical');
    const warnIncidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKEWarning');
    const totalAlertIncidents = await serviceNowClient.getBitsightIncidents(
        'short_descriptionLIKEbitsight^descriptionLIKECritical^ORshort_descriptionLIKEbitsight^descriptionLIKEWarning'
    );

    const actualCriticalCount = criticalIncidents.length;
    const actualWarnCount = warnIncidents.length;
    const actualTotalCount = totalAlertIncidents.length;

    console.log(`Found ${actualCriticalCount} Critical incident(s).`);
    console.log(`Found ${actualWarnCount} Warn incident(s).`);
    console.log(`Found ${actualTotalCount} Total Critical + Warn incident(s).`);

    console.log('\n================================================================');
    console.log('   CRITICAL + WARN ALERTS INCIDENT CREATION RECONCILIATION SUMMARY  ');
    console.log('================================================================');
    console.table({
        'Configured Max Age (Days)': maxDays,
        'Alert Date Cutoff Threshold': cutoffDateStr,
        'Total Imported Critical & Warn Alerts in ServiceNow': snAlertsList.length,
        'Eligible Critical Alerts (Expected)': expectedCriticalCount,
        'Actual Critical Incidents Created': actualCriticalCount,
        'Eligible Warn Alerts (Expected)': expectedWarnCount,
        'Actual Warn Incidents Created': actualWarnCount,
        'Total Expected Incidents (Critical + Warn)': totalExpectedIncidentCount,
        'Total Actual Incidents (Critical + Warn)': actualTotalCount,
        'Total Difference': Math.abs(actualTotalCount - totalExpectedIncidentCount),
    });

    expect(
        actualCriticalCount,
        `Expected ${expectedCriticalCount} Critical alert incident(s), but found ${actualCriticalCount}`
    ).toBe(expectedCriticalCount);

    expect(
        actualWarnCount,
        `Expected ${expectedWarnCount} Warn alert incident(s), but found ${actualWarnCount}`
    ).toBe(expectedWarnCount);

        expect(
            actualTotalCount,
            `Expected ${totalExpectedIncidentCount} total (Critical + Warn) alert incident(s), but found ${actualTotalCount}`
        ).toBe(totalExpectedIncidentCount);
    });
});