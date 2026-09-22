// tests/05_cleanup_spec.js
import { test } from '@playwright/test';
import { ServiceNowApiClient } from './utils/servicenow-api-client';
import { clearPortfolio, clearAlerts, clearIncidents } from './utils/cleanup-utils.js';

test('Cleanup - remove all Bitsight test data', async () => {
    test.setTimeout(300_000);

    const serviceNowClient = new ServiceNowApiClient();

    console.log('=== Clearing Portfolio ===');
    await clearPortfolio(serviceNowClient);

    console.log('=== Clearing Alerts ===');
    await clearAlerts(serviceNowClient);

    console.log('=== Clearing Incidents ===');
    await clearIncidents(serviceNowClient);

    console.log('Cleanup complete.');
});