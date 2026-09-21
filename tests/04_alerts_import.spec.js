import { test, expect } from '@playwright/test';
import { BitsightApiClient } from './utils/bitsight-api-client.js';
import { ServiceNowApiClient, toSnDateTime } from './utils/servicenow-api-client.js';
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

// Centralized navigation helpers using .first() to prevent strict mode violations when modules are favorited
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

    // 1. Set form checkbox / radio / input values
    if (options.ins_company !== undefined) {
        await configFrame.locator(options.ins_company ? '#ins_company_y' : '#ins_company_n').check();
    }
    if (options.mark_comp !== undefined) {
        await configFrame.locator(options.mark_comp ? '#mark_comp_y' : '#mark_comp_n').check();
    }
    if (options.maxpropertyinc !== undefined) {
        await configFrame.locator('#maxpropertyinc').fill(String(options.maxpropertyinc));
    }
    if (options.inc_score !== undefined) {
        await configFrame.locator(options.inc_score ? '#inc_score_y' : '#inc_score_n').check();
    }
    if (options.incscoredrop !== undefined) {
        await configFrame.locator('#incscoredrop').fill(String(options.incscoredrop));
    }
    if (options.critcal_alert_inc !== undefined) {
        await configFrame.locator(options.critcal_alert_inc ? '#critcal_alert_inc_y' : '#critcal_alert_inc_n').check();
    }
    if (options.inc_warn_alert !== undefined) {
        await configFrame.locator(options.inc_warn_alert ? '#inc_warn_alert_y' : '#inc_warn_alert_n').check();
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

    // 2. Save and wait for page reload
    await Promise.all([
        page.waitForLoadState('networkidle'),
        configFrame.locator('#property_save_btn').click(),
    ]);

    // 3. Read back saved configurations
    const savedConfig = {
        insCompany: await configFrame.locator('#ins_company_y').isChecked().catch(() => null),
        markComp: await configFrame.locator('#mark_comp_y').isChecked().catch(() => null),
        maxPropertyInc: await configFrame.locator('#maxpropertyinc').inputValue().catch(() => null),
        incScore: await configFrame.locator('#inc_score_y').isChecked().catch(() => null),
        criticalAlertInc: await configFrame.locator('#critcal_alert_inc_y').isChecked().catch(() => null),
        incWarnAlert: await configFrame.locator('#inc_warn_alert_y').isChecked().catch(() => null),
        userDisplay: await configFrame.locator('[id="sys_display.user"]').inputValue().catch(() => null),
        callerDisplay: await configFrame.locator('[id="sys_display.caller"]').inputValue().catch(() => null),
    };

    console.log('Saved Application Configurations:');
    console.table(savedConfig);

    return savedConfig;
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

test.describe.serial('Token CM - Alerts Import and Incident Tests', () => {
    test('Bitsight CM token validation', async ({ page }) => {
        test.setTimeout(500_000); // 5 minutes

        const token = process.env.CM_TOKEN;
        if (!token) {
            throw new Error('CM_TOKEN is not set in .env');
        }

        await navigateToApplicationConfiguration(page);

        const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');
        const tokenInput = gsftFrame.locator('#token');
        const clearTokenButton = gsftFrame.getByRole('button', { name: 'Clear Token' });
        const okButton = gsftFrame.getByRole('button', { name: 'OK', exact: true });
        const validateButton = gsftFrame.getByRole('button', { name: 'Validate Token' });

        await tokenInput.click();

        // Clear existing token if present
        const existingValue = await tokenInput.inputValue();
        if (existingValue.trim() !== '') {
            await clearTokenButton.click();
            await okButton.click();
            await expect(tokenInput).toHaveValue('', { timeout: 30_000 });
        }

        // Fill token and validate
        await tokenInput.fill(token);
        await validateButton.click();

        const successDialog = gsftFrame.getByRole('dialog', { name: /Success/i });
        const successText = gsftFrame.getByText(/API token validated/i);
        await expect(successText).toBeVisible({ timeout: 200_000 });

        const modalOkButton = successDialog.getByRole('button', { name: 'OK', exact: true })
            .or(gsftFrame.locator('.modal-dialog, [role="dialog"]').getByRole('button', { name: 'OK', exact: true }))
            .first();

        await modalOkButton.waitFor({ state: 'visible', timeout: 10_000 });
        await modalOkButton.click();

        await expect(successText).not.toBeVisible({ timeout: 10_000 });
        await expect(tokenInput).toHaveValue(token);
    });

    test('TC-01 Type 1: Bitsight Alerts Import Reconciliation', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const token = process.env.CM_TOKEN;
        if (!token) {
            throw new Error('CM_TOKEN is not set in .env');
        }
        const bitsightClient = new BitsightApiClient({ token });
        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties
        console.log('\n=== Step 2: Configuring Application Properties ===');
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

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient);

        // Step 4: Fetch Bitsight Alerts Ground Truth Count (filtered against ServiceNow portfolio)
        console.log('\n=== Step 4: Fetching Bitsight Alerts Ground Truth Count ===');
        const snCompanyGuids = await serviceNowClient.getBitsightVendorGuids();
        console.log(`Found ${snCompanyGuids.length} active Bitsight companies in ServiceNow core_company.`);
        const alertsGroundTruth = await bitsightClient.getAlertsCount({
            portfolioGuids: snCompanyGuids.map(c => c.guid),
        });
        const totalAlertsCount = typeof alertsGroundTruth === 'number' ? alertsGroundTruth : (alertsGroundTruth.count ?? alertsGroundTruth);
        console.log(`Bitsight Alerts Ground Truth Count (matching ServiceNow portfolio): ${totalAlertsCount}`);

        // Step 5: Fetch ServiceNow Custom Alerts Table Count
        console.log('\n=== Step 5: Fetching ServiceNow Alerts Table Count ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            sysparm_limit: 10000,
            fields: 'sys_id',
        });
        const snAlertsCount = snAlertsList.length;
        console.log(`ServiceNow alerts table record count: ${snAlertsCount}`);

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

    test('TC-02 Type 1: Bitsight Alert Import Job for Delta Data', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // Step 1: Query existing alert records sorted in descending order of alert_date
        console.log('\n=== Step 1: Fetching existing alert records (sorted by alert_date DESC) ===');
        let existingAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            sysparm_query: 'ORDERBYDESCalert_date^ORORDERBYDESCsys_created_on',
            sysparm_fields: 'sys_id,alert_date,u_alert_date,sys_created_on,description,severity',
            fetchAll: true,
        });

        console.log(`Initial alert records found in x_bisit_vrm_bitsight_alerts: ${existingAlerts.length}`);

        // Precondition Check: If table has fewer than 6 records, perform an initial full import
        if (existingAlerts.length < 6) {
            console.log('[DeltaTest] Insufficient existing alert records (< 6). Triggering an initial Alerts Import...');
            await triggerAndWaitForAlertsImport(page, serviceNowClient);

            existingAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
                sysparm_query: 'ORDERBYDESCalert_date^ORORDERBYDESCsys_created_on',
                sysparm_fields: 'sys_id,alert_date,u_alert_date,sys_created_on,description,severity',
                fetchAll: true,
            });
            console.log(`Alert records found after initial import: ${existingAlerts.length}`);
        }

        expect(
            existingAlerts.length,
            `Precondition failed: Expected at least 6 existing alert records to perform delta test, but found ${existingAlerts.length}`
        ).toBeGreaterThanOrEqual(6);

        // Step 2: Delete Top 5 Records & Capture 6th Record's alert_date as Reference Date
        console.log('\n=== Step 2: Deleting Top 5 Newest Records & Identifying Reference Date ===');
        const recordsToDelete = existingAlerts.slice(0, 5);
        const referenceRecord = existingAlerts[5];
        const referenceAlertDate = (referenceRecord.alert_date || referenceRecord.u_alert_date || '').toString().trim();
        const referenceAlertDateOnly = referenceAlertDate.split(' ')[0].split('T')[0];

        console.log(`Top 5 Alert Records to Delete:`);
        console.table(recordsToDelete.map((r, i) => ({
            Index: i + 1,
            SysId: r.sys_id,
            AlertDate: r.alert_date || r.u_alert_date,
            Description: (r.description || '').substring(0, 40)
        })));
        console.log(`6th Record (Reference Date / High-Water Mark): ${referenceAlertDate}`);

        const sysIdsToDelete = recordsToDelete.map(r => r.sys_id);
        const deleteResult = await serviceNowClient.deleteRecordsBatch('x_bisit_vrm_bitsight_alerts', sysIdsToDelete);
        expect(deleteResult.deletedCount, 'All 5 top records should be successfully deleted').toBe(5);

        // Verify remaining top record in table
        const remainingTopAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            sysparm_query: 'ORDERBYDESCalert_date^ORORDERBYDESCsys_created_on',
            sysparm_fields: 'sys_id,alert_date,u_alert_date',
            sysparm_limit: 1,
        });
        const currentTopDate = (remainingTopAlerts[0]?.alert_date || remainingTopAlerts[0]?.u_alert_date || '').toString().trim();
        expect(currentTopDate, 'Top alert_date after deletion should match 6th record reference date').toBe(referenceAlertDate);

        // Step 3: Trigger "Bitsight Alerts Import" Scheduled Job
        console.log('\n=== Step 3: Triggering Scheduled Bitsight Alerts Import for Delta Data ===');
        const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);
        const baselineTriggerIso = new Date().toISOString();

        await triggerAndWaitForAlertsImport(page, serviceNowClient, { baselineTimestamp: baselineSyslogTimestamp });

        // Step 4: Fetch Newly Imported Records & Verify Delta Assertions
        console.log('\n=== Step 4: Verifying Delta Import Records & Alert Dates ===');
        const allCurrentAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            sysparm_query: 'ORDERBYDESCalert_date^ORORDERBYDESCsys_created_on',
            sysparm_fields: 'sys_id,alert_date,u_alert_date,sys_created_on,description,severity',
            fetchAll: true,
        });
        console.log(`Total alert records in ServiceNow after delta import: ${allCurrentAlerts.length}`);

        const remainingSysIds = new Set(existingAlerts.slice(5).map(r => r.sys_id));
        const createdSnTime = toSnDateTime(baselineTriggerIso);
        const newlyImportedAlerts = allCurrentAlerts.filter(record => {
            const createdOn = record.sys_created_on || '';
            return createdOn >= createdSnTime || !remainingSysIds.has(record.sys_id);
        });

        console.log(`Newly imported alert records count: ${newlyImportedAlerts.length}`);

        expect(
            newlyImportedAlerts.length,
            `Expected at least 5 alert records to be created by delta import, but found ${newlyImportedAlerts.length}`
        ).toBeGreaterThanOrEqual(5);

        const invalidDateRecords = [];
        for (const record of newlyImportedAlerts) {
            const rawDate = (record.alert_date || record.u_alert_date || '').toString().trim();
            const recordDateOnly = rawDate.split(' ')[0].split('T')[0];
            if (recordDateOnly && recordDateOnly < referenceAlertDateOnly) {
                invalidDateRecords.push({
                    sys_id: record.sys_id,
                    alert_date: rawDate,
                    reference_date: referenceAlertDate
                });
            }
        }

        console.log('\n================================================================');
        console.log('       DELTA ALERTS IMPORT RECONCILIATION SUMMARY               ');
        console.log('================================================================');
        console.table({
            'Reference Alert Date (6th Record)': referenceAlertDate,
            'Deleted Top Records Count': recordsToDelete.length,
            'Newly Imported Records Count': newlyImportedAlerts.length,
            'Total Alerts in ServiceNow After Import': allCurrentAlerts.length,
            'Invalid Date Records Count': invalidDateRecords.length,
        });

        expect(
            invalidDateRecords.length,
            `Expected 0 records with alert_date older than reference date (${referenceAlertDate}), but found ${invalidDateRecords.length}`
        ).toBe(0);
    });

    test('TC-03 Type 1: Incident Creation for Public Disclosure alerts', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties
        console.log('\n=== Step 2: Configuring Application Properties ===');
        await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: true,
            inc_warn_alert: true,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Fetch Imported Public Disclosure Alerts from ServiceNow
        console.log('\n=== Step 4: Fetching Public Disclosure Alerts in ServiceNow ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'type=PUBLIC_DISCLOSURE' });
        const expectedIncidentCount = snAlertsList.length;
        console.log(`Public Disclosure Alerts retrieved from ServiceNow table: ${expectedIncidentCount}`);

        // Step 5: Verify Corresponding ServiceNow Incident Creation
        console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
        const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^x_bisit_vrm_bitsight_alert.alert_displaySTARTSWITHPublic Disclosure');
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching Public Disclosure.`);

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

    test('TC-04 Type 1: Incident Creation for Critical Severity alerts based on Application Configuration', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties
        console.log('\n=== Step 2: Configuring Application Properties ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 25,
            inc_score: false,
            critcal_alert_inc: true,
            inc_warn_alert: false,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 10;
        console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Fetch Imported Alerts from ServiceNow and Filter by Critical Severity & Age Threshold
        console.log('\n=== Step 4: Fetching and Filtering Critical Alerts in ServiceNow ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=CRITICAL' });
        console.log(`Total imported CRITICAL alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

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

        // Step 5: Verify Corresponding ServiceNow Incident Creation
        console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
        const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKECritical');
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching Critical.`);

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

    test('TC-05 Type 1: No Incident Created for Critical Severity alerts when critical_alert_inc flag is disabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKECritical';

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties - Disable Critical flag
        console.log('\n=== Step 2: Configuring Application Properties (Disabling Critical Alert Trigger) ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: false,
            inc_warn_alert: false,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.criticalAlertInc, 'Critical alert incident creation should be disabled (false)').toBe(false);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Confirm Critical Severity Alerts Were Actually Imported
        console.log('\n=== Step 4: Confirming Critical Severity Alerts Were Imported ===');
        const snCriticalAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=CRITICAL' });
        console.log(`Total imported CRITICAL alerts retrieved from ServiceNow table: ${snCriticalAlerts.length}`);

        expect(
            snCriticalAlerts.length,
            'Test precondition failed: no CRITICAL severity alerts were imported'
        ).toBeGreaterThan(0);

        // Step 5: Verify No Critical Incidents Were Created
        console.log('\n=== Step 5: Checking No Incidents Were Created for Critical Alerts ===');
        const incidents = await serviceNowClient.getBitsightIncidents(INCIDENT_QUERY);
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching "${INCIDENT_QUERY}".`);

        expect(
            actualIncidentCount,
            `Expected 0 incidents to be created for Critical alerts while the flag is disabled, but found ${actualIncidentCount}`
        ).toBe(0);
    });

    test('TC-06 Type 1: Incident Creation for Warn Severity alerts based on Application Configuration', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties
        console.log('\n=== Step 2: Configuring Application Properties ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: false,
            inc_warn_alert: true,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 7;
        console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Fetch Imported Warn Severity Alerts from ServiceNow and Filter by Age Threshold
        console.log('\n=== Step 4: Fetching and Filtering Warn Alerts in ServiceNow ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=WARN^ORseverity=WARNING' });
        console.log(`Total imported WARN alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

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

        // Step 5: Verify Corresponding ServiceNow Incident Creation
        console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
        const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKEWarning');
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching Warning.`);

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

    test('TC-07 Type 1: No Incident Created for Warn Severity alerts when inc_warn_alert flag is disabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKEWarning';

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties - Disable Warn flag
        console.log('\n=== Step 2: Configuring Application Properties (Disabling Warn Alert Trigger) ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: false,
            inc_warn_alert: false,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.incWarnAlert, 'Warn alert incident creation should be disabled (false)').toBe(false);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Confirm Warn Severity Alerts Were Actually Imported
        console.log('\n=== Step 4: Confirming Warn Severity Alerts Were Imported ===');
        const snWarnAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=WARN^ORseverity=WARNING' });
        console.log(`Total imported WARN alerts retrieved from ServiceNow table: ${snWarnAlerts.length}`);

        expect(
            snWarnAlerts.length,
            'Test precondition failed: no WARN severity alerts were imported'
        ).toBeGreaterThan(0);

        // Step 5: Verify No Warn Incidents Were Created
        console.log('\n=== Step 5: Checking No Incidents Were Created for Warn Alerts ===');
        const incidents = await serviceNowClient.getBitsightIncidents(INCIDENT_QUERY);
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching "${INCIDENT_QUERY}".`);

        expect(
            actualIncidentCount,
            `Expected 0 incidents to be created for Warn alerts while the flag is disabled, but found ${actualIncidentCount}`
        ).toBe(0);
    });

    test('TC-08 Type 1: Incident Creation when both Critical and Warn Severity alert triggers are enabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties (Both Flags = True)
        console.log('\n=== Step 2: Configuring Application Properties (Both Flags = True) ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 15,
            inc_score: false,
            critcal_alert_inc: true,
            inc_warn_alert: true,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.criticalAlertInc, 'Critical alert incident creation should be enabled (true)').toBe(true);
        expect(savedConfig.incWarnAlert, 'Warn alert incident creation should be enabled (true)').toBe(true);

        const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 15;
        console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Fetch Imported Alerts from ServiceNow and Filter by Critical & Warn Severity & Age Threshold
        console.log('\n=== Step 4: Fetching and Filtering Critical & Warn Alerts in ServiceNow ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            query: 'severity=CRITICAL^ORseverity=WARN^ORseverity=WARNING',
        });
        console.log(`Total imported CRITICAL and WARN alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

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

        // Step 5: Verify Corresponding ServiceNow Incident Creation (Critical + Warn only)
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
            `Expected ${totalExpectedIncidentCount} total Critical and Warn alert incident(s), but found ${actualTotalCount}`
        ).toBe(totalExpectedIncidentCount);
    });

    test('TC-09 Type 1: No Incident Created when both Critical and Warn Severity alert triggers are disabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKECritical^ORshort_descriptionLIKEbitsight^descriptionLIKEWarning';

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties (Disabling Both Alert Triggers)
        console.log('\n=== Step 2: Configuring Application Properties (Disabling Both Alert Triggers) ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: false,
            inc_warn_alert: false,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.criticalAlertInc, 'Critical alert incident creation should be disabled (false)').toBe(false);
        expect(savedConfig.incWarnAlert, 'Warn alert incident creation should be disabled (false)').toBe(false);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Confirm Critical and Warn Alerts Were Actually Imported
        console.log('\n=== Step 4: Confirming Critical and Warn Alerts Were Imported ===');
        const snAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            query: 'severity=CRITICAL^ORseverity=WARN^ORseverity=WARNING',
        });
        console.log(`Total imported Critical and Warn alerts retrieved from ServiceNow table: ${snAlerts.length}`);

        expect(
            snAlerts.length,
            'Test precondition failed: no Critical or Warn severity alerts were imported'
        ).toBeGreaterThan(0);

        // Step 5: Verify No Critical or Warn Incidents Were Created
        console.log('\n=== Step 5: Checking No Incidents Were Created ===');
        const incidents = await serviceNowClient.getBitsightIncidents(INCIDENT_QUERY);
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching "${INCIDENT_QUERY}".`);

        expect(
            actualIncidentCount,
            `Expected 0 incidents to be created while both flags are disabled, but found ${actualIncidentCount}`
        ).toBe(0);
    });

    test('TC-10 Type 1: Incident Creation on Bitsight Security Rating Score Drop', async ({ page }) => {
        test.setTimeout(180_000); // 3 minutes

        const serviceNowClient = new ServiceNowApiClient();
        const TARGET_SCORE_DROP = '5';
        const DROP_POINTS = 10;
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKEScore Change Trigger';

        // Step 1: Configure Application Properties
        console.log('\n=== Step 1: Configuring Application Properties ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            inc_score: true,
            incscoredrop: TARGET_SCORE_DROP,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.incScore, 'Score drop incident trigger should be enabled').toBeTruthy();

        // Step 2: Fetch Target Company Record from core_company
        console.log('\n=== Step 2: Fetching Target Company Record ===');
        const companies = await serviceNowClient.getTableRecords('core_company', {
            sysparm_query: 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^x_bisit_vrm_security_ratingISNOTEMPTY',
            sysparm_fields: 'sys_id,name,x_bisit_vrm_security_rating',
            sysparm_limit: 1,
        });

        expect(companies.length, 'At least one company with a valid rating must exist').toBeGreaterThan(0);

        const targetCompany = companies[0];
        const companySysId = targetCompany.sys_id;
        const originalRating = parseInt(targetCompany.x_bisit_vrm_security_rating, 10);
        const droppedRating = originalRating - DROP_POINTS;

        console.log(`Target Company: ${targetCompany.name} (${companySysId})`);
        console.log(`Original Rating: ${originalRating} | Dropping to: ${droppedRating}`);

        // Step 3: Capture Baseline Incident Count
        console.log('\n=== Step 3: Capturing Baseline Incident Count ===');
        const baselineIncidents = await serviceNowClient.getTableRecords('incident', {
            sysparm_query: INCIDENT_QUERY,
            sysparm_fields: 'sys_id',
            sysparm_limit: 10000,
        });
        const baselineIncidentCount = baselineIncidents.length;
        console.log(`Baseline Incident Count: ${baselineIncidentCount}`);

        try {
            // Step 4: Drop Rating via PATCH API
            console.log('\n=== Step 4: Updating Security Rating via PATCH API ===');
            await serviceNowClient.updateRecord('core_company', companySysId, {
                x_bisit_vrm_security_rating: droppedRating,
            });

            // Step 5: Poll for Incident Creation
            console.log('\n=== Step 5: Polling for Incident Creation ===');
            let finalIncidentCount = baselineIncidentCount;

            await expect.poll(async () => {
                const currentIncidents = await serviceNowClient.getTableRecords('incident', {
                    sysparm_query: INCIDENT_QUERY,
                    sysparm_fields: 'sys_id',
                    sysparm_limit: 10000,
                });
                finalIncidentCount = currentIncidents.length;
                return finalIncidentCount;
            }, {
                message: 'Expected incident count to increase following the rating drop',
                timeout: 60_000,
                intervals: [3_000, 5_000, 10_000],
            }).toBe(baselineIncidentCount + 1);

            console.log(`Incident verified. New Count: ${finalIncidentCount}`);

        } finally {
            // Step 6: Revert Company Security Rating
            console.log('\n=== Step 6: Reverting Company Security Rating ===');
            try {
                await serviceNowClient.updateRecord('core_company', companySysId, {
                    x_bisit_vrm_security_rating: originalRating,
                });
                console.log(`Successfully reverted rating back to ${originalRating}.`);
            } catch (cleanupError) {
                console.error('Failed to revert company rating during cleanup:', cleanupError);
            }
        }
    });

    test('TC-11 Type 1: No Incident Created on Score Drop when inc_score flag is disabled', async ({ page }) => {
        test.setTimeout(180_000); // 3 minutes

        const serviceNowClient = new ServiceNowApiClient();
        const TARGET_SCORE_DROP = '5';
        const DROP_POINTS = 10;
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKEScore Change Trigger';

        // Step 1: Configure Application Properties - Disable inc_score flag
        console.log('\n=== Step 1: Configuring Application Properties (Disabling inc_score) ===');
        const savedConfig = await configureApplicationProperties(page, {
            inc_score: false,
            incscoredrop: TARGET_SCORE_DROP,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.incScore, 'Score drop incident trigger should be disabled').toBeFalsy();

        // Step 2: Fetch Target Company Record from core_company
        console.log('\n=== Step 2: Fetching Target Company Record ===');
        const companies = await serviceNowClient.getTableRecords('core_company', {
            sysparm_query: 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^x_bisit_vrm_security_ratingISNOTEMPTY',
            sysparm_fields: 'sys_id,name,x_bisit_vrm_security_rating',
            sysparm_limit: 1,
        });
        expect(companies.length, 'At least one company with a valid rating must exist').toBeGreaterThan(0);

        const targetCompany = companies[0];
        const companySysId = targetCompany.sys_id;
        const originalRating = parseInt(targetCompany.x_bisit_vrm_security_rating, 10);
        const droppedRating = originalRating - DROP_POINTS;

        console.log(`Target Company: ${targetCompany.name} (${companySysId})`);
        console.log(`Original Rating: ${originalRating} | Dropping to: ${droppedRating}`);

        // Step 3: Capture Baseline Incident Count
        console.log('\n=== Step 3: Capturing Baseline Incident Count ===');
        const baselineIncidents = await serviceNowClient.getTableRecords('incident', {
            sysparm_query: INCIDENT_QUERY,
            sysparm_fields: 'sys_id',
            sysparm_limit: 10000,
        });
        const baselineIncidentCount = baselineIncidents.length;
        console.log(`Baseline Incident Count: ${baselineIncidentCount}`);

        try {
            // Step 4: Drop Rating via PATCH API
            console.log('\n=== Step 4: Dropping Security Rating via PATCH API ===');
            await serviceNowClient.updateRecord('core_company', companySysId, {
                x_bisit_vrm_security_rating: droppedRating,
            });

            // Step 5: Assert Incident Count Remains Unchanged
            console.log('\n=== Step 5: Verifying No Incident is Created ===');
            await page.waitForTimeout(15_000);

            const currentIncidents = await serviceNowClient.getTableRecords('incident', {
                sysparm_query: INCIDENT_QUERY,
                sysparm_fields: 'sys_id',
                sysparm_limit: 10000,
            });
            const currentIncidentCount = currentIncidents.length;
            console.log(`Current Incident Count: ${currentIncidentCount}`);

            expect(
                currentIncidentCount,
                'Incident count should remain identical to baseline when flag is disabled'
            ).toBe(baselineIncidentCount);

        } finally {
            // Step 6: Revert Company Security Rating
            console.log('\n=== Step 6: Reverting Company Security Rating ===');
            try {
                await serviceNowClient.updateRecord('core_company', companySysId, {
                    x_bisit_vrm_security_rating: originalRating,
                });
                console.log(`Successfully reverted rating back to ${originalRating}.`);
            } catch (cleanupError) {
                console.error('Failed to revert company rating during cleanup:', cleanupError);
            }
        }
    });
});

test.describe.serial('Type 3 Token CM_VRM - Alerts Import and Incident Tests', () => {
    test('Bitsight CM_VRM token validation', async ({ page }) => {
        test.setTimeout(500_000); // 5 minutes

        const token = process.env.CMVRM_TOKEN;
        if (!token) {
            throw new Error('CMVRM_TOKEN is not set in .env');
        }

        await navigateToApplicationConfiguration(page);

        const gsftFrame = page.frameLocator('iframe[name="gsft_main"]');
        const tokenInput = gsftFrame.locator('#token');
        const clearTokenButton = gsftFrame.getByRole('button', { name: 'Clear Token' });
        const okButton = gsftFrame.getByRole('button', { name: 'OK', exact: true });
        const validateButton = gsftFrame.getByRole('button', { name: 'Validate Token' });

        await tokenInput.click();

        // Clear existing token if present
        const existingValue = await tokenInput.inputValue();
        if (existingValue.trim() !== '') {
            await clearTokenButton.click();
            await okButton.click();
            await expect(tokenInput).toHaveValue('', { timeout: 50_000 });
        }

        await tokenInput.fill(token);
        await validateButton.click();

        const successDialog = gsftFrame.getByRole('dialog', { name: 'Success' });
        const successMessage = gsftFrame.getByText('API token validated successfully.');

        await expect(successDialog.or(successMessage).first()).toBeVisible({
            timeout: 500_000,
        });

        const successOkButton = successDialog.getByRole('button', { name: 'OK', exact: true });
        if (await successOkButton.isVisible()) {
            await successOkButton.click();
        }

        await expect(tokenInput).toHaveValue(token);
    });

    test('TC-01 Type 3: Bitsight Alerts Import Reconciliation', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const token = process.env.CMVRM_TOKEN;
        if (!token) {
            throw new Error('CMVRM_TOKEN is not set in .env');
        }
        const bitsightClient = new BitsightApiClient({ token });
        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties
        console.log('\n=== Step 2: Configuring Application Properties ===');
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

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient);

        // Step 4: Fetch Bitsight Alerts Ground Truth Count (filtered against ServiceNow portfolio)
        console.log('\n=== Step 4: Fetching Bitsight Alerts Ground Truth Count ===');
        const snCompanyGuids = await serviceNowClient.getBitsightVendorGuids();
        console.log(`Found ${snCompanyGuids.length} active Bitsight companies in ServiceNow core_company.`);
        const alertsGroundTruth = await bitsightClient.getAlertsCount({
            portfolioGuids: snCompanyGuids.map(c => c.guid),
        });
        const totalAlertsCount = typeof alertsGroundTruth === 'number' ? alertsGroundTruth : (alertsGroundTruth.count ?? alertsGroundTruth);
        console.log(`Bitsight Alerts Ground Truth Count (matching ServiceNow portfolio): ${totalAlertsCount}`);

        // Step 5: Fetch ServiceNow Custom Alerts Table Count
        console.log('\n=== Step 5: Fetching ServiceNow Alerts Table Count ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            sysparm_limit: 10000,
            fields: 'sys_id',
        });
        const snAlertsCount = snAlertsList.length;
        console.log(`ServiceNow alerts table record count: ${snAlertsCount}`);

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

    test('TC-02 Type 3: Bitsight Alert Import Job for Delta Data', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();
        const COMPLETION_LOG_MESSAGE = 'Bitsight Alerts Import Complete.';

        // Step 1: Query existing alert records sorted in descending order of alert_date
        console.log('\n=== Step 1: Fetching existing alert records (sorted by alert_date DESC) ===');
        let existingAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            sysparm_query: 'ORDERBYDESCalert_date^ORORDERBYDESCsys_created_on',
            sysparm_fields: 'sys_id,alert_date,u_alert_date,sys_created_on,description,severity',
            fetchAll: true,
        });

        console.log(`Initial alert records found in x_bisit_vrm_bitsight_alerts: ${existingAlerts.length}`);

        // Precondition Check: If table has fewer than 6 records, perform an initial full import
        if (existingAlerts.length < 6) {
            console.log('[DeltaTest] Insufficient existing alert records (< 6). Triggering an initial Alerts Import...');
            await triggerAndWaitForAlertsImport(page, serviceNowClient);

            existingAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
                sysparm_query: 'ORDERBYDESCalert_date^ORORDERBYDESCsys_created_on',
                sysparm_fields: 'sys_id,alert_date,u_alert_date,sys_created_on,description,severity',
                fetchAll: true,
            });
            console.log(`Alert records found after initial import: ${existingAlerts.length}`);
        }

        expect(
            existingAlerts.length,
            `Precondition failed: Expected at least 6 existing alert records to perform delta test, but found ${existingAlerts.length}`
        ).toBeGreaterThanOrEqual(6);

        // Step 2: Delete Top 5 Records & Capture 6th Record's alert_date as Reference Date
        console.log('\n=== Step 2: Deleting Top 5 Newest Records & Identifying Reference Date ===');
        const recordsToDelete = existingAlerts.slice(0, 5);
        const referenceRecord = existingAlerts[5];
        const referenceAlertDate = (referenceRecord.alert_date || referenceRecord.u_alert_date || '').toString().trim();
        const referenceAlertDateOnly = referenceAlertDate.split(' ')[0].split('T')[0];

        console.log(`Top 5 Alert Records to Delete:`);
        console.table(recordsToDelete.map((r, i) => ({
            Index: i + 1,
            SysId: r.sys_id,
            AlertDate: r.alert_date || r.u_alert_date,
            Description: (r.description || '').substring(0, 40)
        })));
        console.log(`6th Record (Reference Date / High-Water Mark): ${referenceAlertDate}`);

        const sysIdsToDelete = recordsToDelete.map(r => r.sys_id);
        const deleteResult = await serviceNowClient.deleteRecordsBatch('x_bisit_vrm_bitsight_alerts', sysIdsToDelete);
        expect(deleteResult.deletedCount, 'All 5 top records should be successfully deleted').toBe(5);

        // Verify remaining top record in table
        const remainingTopAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            sysparm_query: 'ORDERBYDESCalert_date^ORORDERBYDESCsys_created_on',
            sysparm_fields: 'sys_id,alert_date,u_alert_date',
            sysparm_limit: 1,
        });
        const currentTopDate = (remainingTopAlerts[0]?.alert_date || remainingTopAlerts[0]?.u_alert_date || '').toString().trim();
        expect(currentTopDate, 'Top alert_date after deletion should match 6th record reference date').toBe(referenceAlertDate);

        // Step 3: Trigger "Bitsight Alerts Import" Scheduled Job
        console.log('\n=== Step 3: Triggering Scheduled Bitsight Alerts Import for Delta Data ===');
        const baselineSyslogTimestamp = await serviceNowClient.getLatestLogByMessage(page, COMPLETION_LOG_MESSAGE);
        const baselineTriggerIso = new Date().toISOString();

        await triggerAndWaitForAlertsImport(page, serviceNowClient, { baselineTimestamp: baselineSyslogTimestamp });

        // Step 4: Fetch Newly Imported Records & Verify Delta Assertions
        console.log('\n=== Step 4: Verifying Delta Import Records & Alert Dates ===');
        const allCurrentAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            sysparm_query: 'ORDERBYDESCalert_date^ORORDERBYDESCsys_created_on',
            sysparm_fields: 'sys_id,alert_date,u_alert_date,sys_created_on,description,severity',
            fetchAll: true,
        });
        console.log(`Total alert records in ServiceNow after delta import: ${allCurrentAlerts.length}`);

        const remainingSysIds = new Set(existingAlerts.slice(5).map(r => r.sys_id));
        const createdSnTime = toSnDateTime(baselineTriggerIso);
        const newlyImportedAlerts = allCurrentAlerts.filter(record => {
            const createdOn = record.sys_created_on || '';
            return createdOn >= createdSnTime || !remainingSysIds.has(record.sys_id);
        });

        console.log(`Newly imported alert records count: ${newlyImportedAlerts.length}`);

        expect(
            newlyImportedAlerts.length,
            `Expected at least 5 alert records to be created by delta import, but found ${newlyImportedAlerts.length}`
        ).toBeGreaterThanOrEqual(5);

        const invalidDateRecords = [];
        for (const record of newlyImportedAlerts) {
            const rawDate = (record.alert_date || record.u_alert_date || '').toString().trim();
            const recordDateOnly = rawDate.split(' ')[0].split('T')[0];
            if (recordDateOnly && recordDateOnly < referenceAlertDateOnly) {
                invalidDateRecords.push({
                    sys_id: record.sys_id,
                    alert_date: rawDate,
                    reference_date: referenceAlertDate
                });
            }
        }

        console.log('\n================================================================');
        console.log('       DELTA ALERTS IMPORT RECONCILIATION SUMMARY               ');
        console.log('================================================================');
        console.table({
            'Reference Alert Date (6th Record)': referenceAlertDate,
            'Deleted Top Records Count': recordsToDelete.length,
            'Newly Imported Records Count': newlyImportedAlerts.length,
            'Total Alerts in ServiceNow After Import': allCurrentAlerts.length,
            'Invalid Date Records Count': invalidDateRecords.length,
        });

        if (invalidDateRecords.length > 0) {
            console.error('Found newly imported records with alert_date older than reference date:', invalidDateRecords);
        }

        expect(
            invalidDateRecords.length,
            `Expected 0 records with alert_date older than reference date (${referenceAlertDate}), but found ${invalidDateRecords.length}`
        ).toBe(0);
    });

    test('TC-03 Type 3: Incident Creation for Public Disclosure alerts', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties
        console.log('\n=== Step 2: Configuring Application Properties ===');
        await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: true,
            inc_warn_alert: true,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Fetch Imported Public Disclosure Alerts from ServiceNow
        console.log('\n=== Step 4: Fetching Public Disclosure Alerts in ServiceNow ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'type=PUBLIC_DISCLOSURE' });
        const expectedIncidentCount = snAlertsList.length;
        console.log(`Public Disclosure Alerts retrieved from ServiceNow table: ${expectedIncidentCount}`);

        // Step 5: Verify Corresponding ServiceNow Incident Creation
        console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
        const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^x_bisit_vrm_bitsight_alert.alert_displaySTARTSWITHPublic Disclosure');
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching Public Disclosure.`);

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

    test('TC-04 Type 3: Incident Creation for Critical Severity alerts based on Application Configuration', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties
        console.log('\n=== Step 2: Configuring Application Properties ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 25,
            inc_score: false,
            critcal_alert_inc: true,
            inc_warn_alert: false,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 10;
        console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Fetch Imported Alerts from ServiceNow and Filter by Critical Severity & Age Threshold
        console.log('\n=== Step 4: Fetching and Filtering Critical Alerts in ServiceNow ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=CRITICAL' });
        console.log(`Total imported CRITICAL alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

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

        // Step 5: Verify Corresponding ServiceNow Incident Creation
        console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
        const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKECritical');
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching Critical.`);

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

    test('TC-05 Type 3: No Incident Created for Critical Severity alerts when critical_alert_inc flag is disabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKECritical';

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties - Disable Critical flag
        console.log('\n=== Step 2: Configuring Application Properties (Disabling Critical Alert Trigger) ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: false,
            inc_warn_alert: false,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.criticalAlertInc, 'Critical alert incident creation should be disabled (false)').toBe(false);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Confirm Critical Severity Alerts Were Actually Imported
        console.log('\n=== Step 4: Confirming Critical Severity Alerts Were Imported ===');
        const snCriticalAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=CRITICAL' });
        console.log(`Total imported CRITICAL alerts retrieved from ServiceNow table: ${snCriticalAlerts.length}`);

        expect(
            snCriticalAlerts.length,
            'Test precondition failed: no CRITICAL severity alerts were imported'
        ).toBeGreaterThan(0);

        // Step 5: Verify No Critical Incidents Were Created
        console.log('\n=== Step 5: Checking No Incidents Were Created for Critical Alerts ===');
        const incidents = await serviceNowClient.getBitsightIncidents(INCIDENT_QUERY);
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching "${INCIDENT_QUERY}".`);

        expect(
            actualIncidentCount,
            `Expected 0 incidents to be created for Critical alerts while the flag is disabled, but found ${actualIncidentCount}`
        ).toBe(0);
    });

    test('TC-06 Type 3: Incident Creation for Warn Severity alerts based on Application Configuration', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties
        console.log('\n=== Step 2: Configuring Application Properties ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: false,
            inc_warn_alert: true,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 7;
        console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Fetch Imported Warn Severity Alerts from ServiceNow and Filter by Age Threshold
        console.log('\n=== Step 4: Fetching and Filtering Warn Alerts in ServiceNow ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=WARN^ORseverity=WARNING' });
        console.log(`Total imported WARN alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

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

        // Step 5: Verify Corresponding ServiceNow Incident Creation
        console.log('\n=== Step 5: Checking Created Incidents in ServiceNow ===');
        const incidents = await serviceNowClient.getBitsightIncidents('short_descriptionLIKEbitsight^descriptionLIKEWarning');
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching Warning.`);

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

    test('TC-07 Type 3: No Incident Created for Warn Severity alerts when inc_warn_alert flag is disabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKEWarning';

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties - Disable Warn flag
        console.log('\n=== Step 2: Configuring Application Properties (Disabling Warn Alert Trigger) ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: false,
            inc_warn_alert: false,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.incWarnAlert, 'Warn alert incident creation should be disabled (false)').toBe(false);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Confirm Warn Severity Alerts Were Actually Imported
        console.log('\n=== Step 4: Confirming Warn Severity Alerts Were Imported ===');
        const snWarnAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', { query: 'severity=WARN^ORseverity=WARNING' });
        console.log(`Total imported WARN alerts retrieved from ServiceNow table: ${snWarnAlerts.length}`);

        expect(
            snWarnAlerts.length,
            'Test precondition failed: no WARN severity alerts were imported'
        ).toBeGreaterThan(0);

        // Step 5: Verify No Warn Incidents Were Created
        console.log('\n=== Step 5: Checking No Incidents Were Created for Warn Alerts ===');
        const incidents = await serviceNowClient.getBitsightIncidents(INCIDENT_QUERY);
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching "${INCIDENT_QUERY}".`);

        expect(
            actualIncidentCount,
            `Expected 0 incidents to be created for Warn alerts while the flag is disabled, but found ${actualIncidentCount}`
        ).toBe(0);
    });

    test('TC-08 Type 3: Incident Creation when both Critical and Warn Severity alert triggers are enabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties (Both Flags = True)
        console.log('\n=== Step 2: Configuring Application Properties (Both Flags = True) ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 15,
            inc_score: false,
            critcal_alert_inc: true,
            inc_warn_alert: true,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.criticalAlertInc, 'Critical alert incident creation should be enabled (true)').toBe(true);
        expect(savedConfig.incWarnAlert, 'Warn alert incident creation should be enabled (true)').toBe(true);

        const maxDays = parseInt(savedConfig.maxPropertyInc, 10) || 15;
        console.log(`Dynamic Max Age for Alert Incident Creation: ${maxDays} days`);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Fetch Imported Alerts from ServiceNow and Filter by Critical & Warn Severity & Age Threshold
        console.log('\n=== Step 4: Fetching and Filtering Critical & Warn Alerts in ServiceNow ===');
        const snAlertsList = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            query: 'severity=CRITICAL^ORseverity=WARN^ORseverity=WARNING',
        });
        console.log(`Total imported CRITICAL and WARN alerts retrieved from ServiceNow table: ${snAlertsList.length}`);

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

        // Step 5: Verify Corresponding ServiceNow Incident Creation (Critical + Warn only)
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
            `Expected ${totalExpectedIncidentCount} total Critical and Warn alert incident(s), but found ${actualTotalCount}`
        ).toBe(totalExpectedIncidentCount);
    });

    test('TC-09 Type 3: No Incident Created when both Critical and Warn Severity alert triggers are disabled', async ({ page }) => {
        test.setTimeout(1_800_000); // 30 minutes for full import + reconciliation

        const serviceNowClient = new ServiceNowApiClient();
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKECritical^ORshort_descriptionLIKEbitsight^descriptionLIKEWarning';

        // Step 1: Clean Up Existing Alerts & Incidents in ServiceNow
        console.log('\n=== Step 1: Cleaning Up Existing Alerts & Incidents ===');
        await clearAlerts(serviceNowClient);
        await clearIncidents(serviceNowClient);

        // Step 2: Configure Application Properties (Disabling Both Alert Triggers)
        console.log('\n=== Step 2: Configuring Application Properties (Disabling Both Alert Triggers) ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            maxpropertyinc: 10,
            inc_score: false,
            critcal_alert_inc: false,
            inc_warn_alert: false,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.criticalAlertInc, 'Critical alert incident creation should be disabled (false)').toBe(false);
        expect(savedConfig.incWarnAlert, 'Warn alert incident creation should be disabled (false)').toBe(false);

        // Step 3: Trigger Scheduled Import & Wait for Completion
        await triggerAndWaitForAlertsImport(page, serviceNowClient, { postWaitMs: 30_000 });

        // Step 4: Confirm Critical and Warn Alerts Were Actually Imported
        console.log('\n=== Step 4: Confirming Critical and Warn Alerts Were Imported ===');
        const snAlerts = await serviceNowClient.getTableRecords('x_bisit_vrm_bitsight_alerts', {
            query: 'severity=CRITICAL^ORseverity=WARN^ORseverity=WARNING',
        });
        console.log(`Total imported Critical and Warn alerts retrieved from ServiceNow table: ${snAlerts.length}`);

        expect(
            snAlerts.length,
            'Test precondition failed: no Critical or Warn severity alerts were imported'
        ).toBeGreaterThan(0);

        // Step 5: Verify No Critical or Warn Incidents Were Created
        console.log('\n=== Step 5: Checking No Incidents Were Created ===');
        const incidents = await serviceNowClient.getBitsightIncidents(INCIDENT_QUERY);
        const actualIncidentCount = incidents.length;
        console.log(`Found ${actualIncidentCount} incident(s) matching "${INCIDENT_QUERY}".`);

        expect(
            actualIncidentCount,
            `Expected 0 incidents to be created while both flags are disabled, but found ${actualIncidentCount}`
        ).toBe(0);
    });

    test('TC-10 Type 3: Incident Creation on Bitsight Security Rating Score Drop', async ({ page }) => {
        test.setTimeout(180_000); // 3 minutes

        const serviceNowClient = new ServiceNowApiClient();
        const TARGET_SCORE_DROP = '5';
        const DROP_POINTS = 10;
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKEScore Change Trigger';

        // Step 1: Configure Application Properties
        console.log('\n=== Step 1: Configuring Application Properties ===');
        const savedConfig = await configureApplicationProperties(page, {
            ins_company: true,
            mark_comp: true,
            inc_score: true,
            incscoredrop: TARGET_SCORE_DROP,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.incScore, 'Score drop incident trigger should be enabled').toBeTruthy();

        // Step 2: Fetch Target Company Record from core_company
        console.log('\n=== Step 2: Fetching Target Company Record ===');
        const companies = await serviceNowClient.getTableRecords('core_company', {
            sysparm_query: 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^x_bisit_vrm_security_ratingISNOTEMPTY',
            sysparm_fields: 'sys_id,name,x_bisit_vrm_security_rating',
            sysparm_limit: 1,
        });

        expect(companies.length, 'At least one company with a valid rating must exist').toBeGreaterThan(0);

        const targetCompany = companies[0];
        const companySysId = targetCompany.sys_id;
        const originalRating = parseInt(targetCompany.x_bisit_vrm_security_rating, 10);
        const droppedRating = originalRating - DROP_POINTS;

        console.log(`Target Company: ${targetCompany.name} (${companySysId})`);
        console.log(`Original Rating: ${originalRating} | Dropping to: ${droppedRating}`);

        // Step 3: Capture Baseline Incident Count
        console.log('\n=== Step 3: Capturing Baseline Incident Count ===');
        const baselineIncidents = await serviceNowClient.getTableRecords('incident', {
            sysparm_query: INCIDENT_QUERY,
            sysparm_fields: 'sys_id',
            sysparm_limit: 10000,
        });
        const baselineIncidentCount = baselineIncidents.length;
        console.log(`Baseline Incident Count: ${baselineIncidentCount}`);

        try {
            // Step 4: Drop Rating via PATCH API
            console.log('\n=== Step 4: Updating Security Rating via PATCH API ===');
            await serviceNowClient.updateRecord('core_company', companySysId, {
                x_bisit_vrm_security_rating: droppedRating,
            });

            // Step 5: Poll for Incident Creation
            console.log('\n=== Step 5: Polling for Incident Creation ===');
            let finalIncidentCount = baselineIncidentCount;

            await expect.poll(async () => {
                const currentIncidents = await serviceNowClient.getTableRecords('incident', {
                    sysparm_query: INCIDENT_QUERY,
                    sysparm_fields: 'sys_id',
                    sysparm_limit: 10000,
                });
                finalIncidentCount = currentIncidents.length;
                return finalIncidentCount;
            }, {
                message: 'Expected incident count to increase following the rating drop',
                timeout: 60_000,
                intervals: [3_000, 5_000, 10_000],
            }).toBe(baselineIncidentCount + 1);

            console.log(`Incident verified. New Count: ${finalIncidentCount}`);

        } finally {
            // Step 6: Revert Company Security Rating
            console.log('\n=== Step 6: Reverting Company Security Rating ===');
            try {
                await serviceNowClient.updateRecord('core_company', companySysId, {
                    x_bisit_vrm_security_rating: originalRating,
                });
                console.log(`Successfully reverted rating back to ${originalRating}.`);
            } catch (cleanupError) {
                console.error('Failed to revert company rating during cleanup:', cleanupError);
            }
        }
    });

    test('TC-11 Type 3: No Incident Created on Score Drop when inc_score flag is disabled', async ({ page }) => {
        test.setTimeout(180_000); // 3 minutes

        const serviceNowClient = new ServiceNowApiClient();
        const TARGET_SCORE_DROP = '5';
        const DROP_POINTS = 10;
        const INCIDENT_QUERY = 'short_descriptionLIKEbitsight^descriptionLIKEScore Change Trigger';

        // Step 1: Configure Application Properties - Disable inc_score flag
        console.log('\n=== Step 1: Configuring Application Properties (Disabling inc_score) ===');
        const savedConfig = await configureApplicationProperties(page, {
            inc_score: false,
            incscoredrop: TARGET_SCORE_DROP,
            assign_incident: 'user',
            user: 'abel tuter',
            caller: 'abraham lincoln',
        });

        expect(savedConfig.incScore, 'Score drop incident trigger should be disabled').toBeFalsy();

        // Step 2: Fetch Target Company Record from core_company
        console.log('\n=== Step 2: Fetching Target Company Record ===');
        const companies = await serviceNowClient.getTableRecords('core_company', {
            sysparm_query: 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY^x_bisit_vrm_security_ratingISNOTEMPTY',
            sysparm_fields: 'sys_id,name,x_bisit_vrm_security_rating',
            sysparm_limit: 1,
        });
        expect(companies.length, 'At least one company with a valid rating must exist').toBeGreaterThan(0);

        const targetCompany = companies[0];
        const companySysId = targetCompany.sys_id;
        const originalRating = parseInt(targetCompany.x_bisit_vrm_security_rating, 10);
        const droppedRating = originalRating - DROP_POINTS;

        console.log(`Target Company: ${targetCompany.name} (${companySysId})`);
        console.log(`Original Rating: ${originalRating} | Dropping to: ${droppedRating}`);

        // Step 3: Capture Baseline Incident Count
        console.log('\n=== Step 3: Capturing Baseline Incident Count ===');
        const baselineIncidents = await serviceNowClient.getTableRecords('incident', {
            sysparm_query: INCIDENT_QUERY,
            sysparm_fields: 'sys_id',
            sysparm_limit: 10000,
        });
        const baselineIncidentCount = baselineIncidents.length;
        console.log(`Baseline Incident Count: ${baselineIncidentCount}`);

        try {
            // Step 4: Drop Rating via PATCH API
            console.log('\n=== Step 4: Dropping Security Rating via PATCH API ===');
            await serviceNowClient.updateRecord('core_company', companySysId, {
                x_bisit_vrm_security_rating: droppedRating,
            });

            // Step 5: Assert Incident Count Remains Unchanged
            console.log('\n=== Step 5: Verifying No Incident is Created ===');
            await page.waitForTimeout(15_000);

            const currentIncidents = await serviceNowClient.getTableRecords('incident', {
                sysparm_query: INCIDENT_QUERY,
                sysparm_fields: 'sys_id',
                sysparm_limit: 10000,
            });
            const currentIncidentCount = currentIncidents.length;
            console.log(`Current Incident Count: ${currentIncidentCount}`);

            expect(
                currentIncidentCount,
                'Incident count should remain identical to baseline when flag is disabled'
            ).toBe(baselineIncidentCount);

        } finally {
            // Step 6: Revert Company Security Rating
            console.log('\n=== Step 6: Reverting Company Security Rating ===');
            try {
                await serviceNowClient.updateRecord('core_company', companySysId, {
                    x_bisit_vrm_security_rating: originalRating,
                });
                console.log(`Successfully reverted rating back to ${originalRating}.`);
            } catch (cleanupError) {
                console.error('Failed to revert company rating during cleanup:', cleanupError);
            }
        }
    });
});