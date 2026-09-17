const { ServiceNowApiClient } = require('./servicenow-api-client.js');

/**
 * Utility to clear all Bitsight incidents from ServiceNow incident table.
 * Fetches all incidents matching Bitsight query, extracts their sys_ids,
 * and deletes records in bulk using the ServiceNow REST Batch API.
 *
 * @param {ServiceNowApiClient} serviceNowClient - Instance of ServiceNowApiClient
 * @param {Object} options - Optional query/filtering options
 * @returns {Promise<{totalFound: number, deletedCount: number, failedCount: number}>}
 */
async function clearIncidents(serviceNowClient, options = {}) {
    const client = serviceNowClient || new ServiceNowApiClient();

    console.log('\n[CleanupUtils] Fetching Bitsight incidents to clear...');
    const incidents = await client.getBitsightIncidents(options);
    const totalFound = incidents.length;

    console.log(`[CleanupUtils] Found ${totalFound} Bitsight incident(s) to delete.`);
    if (totalFound === 0) {
        return { totalFound: 0, deletedCount: 0, failedCount: 0 };
    }

    const sysIds = incidents
        .map(item => item.sys_id?.value || item.sys_id)
        .filter(Boolean);

    const result = await client.deleteRecordsBatch('incident', sysIds);
    console.log(`[CleanupUtils] Incident cleanup complete: ${result.deletedCount} deleted, ${result.failedCount} failed of ${totalFound} total.`);
    return result;
}

/**
 * Utility to clear all Bitsight alerts from table x_bisit_vrm_bitsight_alerts.
 * Fetches all alert records, extracts their sys_ids, and deletes records
 * in bulk using the ServiceNow REST Batch API.
 *
 * @param {ServiceNowApiClient} serviceNowClient - Instance of ServiceNowApiClient
 * @param {Object} options - Optional query/filtering options
 * @returns {Promise<{totalFound: number, deletedCount: number, failedCount: number}>}
 */
async function clearAlerts(serviceNowClient, options = {}) {
    const client = serviceNowClient || new ServiceNowApiClient();

    console.log('\n[CleanupUtils] Fetching Bitsight alerts to clear...');
    const alerts = await client.getAlertsRecords(options);
    const totalFound = alerts.length;

    console.log(`[CleanupUtils] Found ${totalFound} Bitsight alert(s) to delete.`);
    if (totalFound === 0) {
        return { totalFound: 0, deletedCount: 0, failedCount: 0 };
    }

    const sysIds = alerts
        .map(item => item.sys_id?.value || item.sys_id)
        .filter(Boolean);

    const result = await client.deleteRecordsBatch('x_bisit_vrm_bitsight_alerts', sysIds);
    console.log(`[CleanupUtils] Alerts cleanup complete: ${result.deletedCount} deleted, ${result.failedCount} failed of ${totalFound} total.`);
    return result;
}

/**
 * Utility to clear all Bitsight portfolio records from core_company table.
 * Fetches all core_company records where x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY,
 * extracts their sys_ids, and deletes records in bulk using the ServiceNow REST Batch API.
 *
 * @param {ServiceNowApiClient} serviceNowClient - Instance of ServiceNowApiClient
 * @param {Object} options - Optional query/filtering options
 * @returns {Promise<{totalFound: number, deletedCount: number, failedCount: number}>}
 */
async function clearPortfolio(serviceNowClient, options = {}) {
    const client = serviceNowClient || new ServiceNowApiClient();

    console.log('\n[CleanupUtils] Fetching Bitsight core_company portfolio records to clear...');
    const companies = await client.getBitsightCoreCompanies(options);
    const totalFound = companies.length;

    console.log(`[CleanupUtils] Found ${totalFound} Bitsight portfolio record(s) in core_company to delete.`);
    if (totalFound === 0) {
        return { totalFound: 0, deletedCount: 0, failedCount: 0 };
    }

    const sysIds = companies
        .map(item => item.sys_id?.value || item.sys_id)
        .filter(Boolean);

    const result = await client.deleteRecordsBatch('core_company', sysIds);
    console.log(`[CleanupUtils] Portfolio cleanup complete: ${result.deletedCount} deleted, ${result.failedCount} failed of ${totalFound} total.`);
    return result;
}

module.exports = {
    clearIncidents,
    clearAlerts,
    clearPortfolio,
    clearCoreCompanies: clearPortfolio,
};
