const { ServiceNowApiClient } = require('./servicenow-api-client.js');

/**
 * Utility to clear all Bitsight incidents from ServiceNow incident table.
 * Fetches all incidents matching Bitsight query, extracts their sys_ids,
 * and deletes each record one by one.
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

    let deletedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < incidents.length; i++) {
        const item = incidents[i];
        const sysId = item.sys_id?.value || item.sys_id;

        if (!sysId) {
            console.warn(`[CleanupUtils] (Incident ${i + 1}/${totalFound}) Missing sys_id, skipping.`);
            failedCount++;
            continue;
        }

        try {
            await client.deleteIncident(sysId);
            deletedCount++;
            console.log(`[CleanupUtils] (${i + 1}/${totalFound}) Deleted incident sys_id: ${sysId}`);
        } catch (err) {
            failedCount++;
            console.error(`[CleanupUtils] (${i + 1}/${totalFound}) Failed to delete incident ${sysId}: ${err.message}`);
        }
    }

    console.log(`[CleanupUtils] Incident cleanup complete: ${deletedCount} deleted, ${failedCount} failed of ${totalFound} total.`);
    return { totalFound, deletedCount, failedCount };
}

/**
 * Utility to clear all Bitsight alerts from table x_bisit_vrm_bitsight_alerts.
 * Fetches all alert records, extracts their sys_ids, and deletes each record one by one.
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

    let deletedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < alerts.length; i++) {
        const item = alerts[i];
        const sysId = item.sys_id?.value || item.sys_id;

        if (!sysId) {
            console.warn(`[CleanupUtils] (Alert ${i + 1}/${totalFound}) Missing sys_id, skipping.`);
            failedCount++;
            continue;
        }

        try {
            await client.deleteAlert(sysId);
            deletedCount++;
            console.log(`[CleanupUtils] (${i + 1}/${totalFound}) Deleted alert sys_id: ${sysId}`);
        } catch (err) {
            failedCount++;
            console.error(`[CleanupUtils] (${i + 1}/${totalFound}) Failed to delete alert ${sysId}: ${err.message}`);
        }
    }

    console.log(`[CleanupUtils] Alerts cleanup complete: ${deletedCount} deleted, ${failedCount} failed of ${totalFound} total.`);
    return { totalFound, deletedCount, failedCount };
}

/**
 * Utility to clear all Bitsight portfolio records from core_company table.
 * Fetches all core_company records where x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY,
 * extracts their sys_ids, and deletes each record one by one.
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

    let deletedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < companies.length; i++) {
        const item = companies[i];
        const sysId = item.sys_id?.value || item.sys_id;

        if (!sysId) {
            console.warn(`[CleanupUtils] (Company ${i + 1}/${totalFound}) Missing sys_id, skipping.`);
            failedCount++;
            continue;
        }

        try {
            await client.deleteCoreCompany(sysId);
            deletedCount++;
            console.log(`[CleanupUtils] (${i + 1}/${totalFound}) Deleted core_company sys_id: ${sysId}`);
        } catch (err) {
            failedCount++;
            console.error(`[CleanupUtils] (${i + 1}/${totalFound}) Failed to delete core_company ${sysId}: ${err.message}`);
        }
    }

    console.log(`[CleanupUtils] Portfolio cleanup complete: ${deletedCount} deleted, ${failedCount} failed of ${totalFound} total.`);
    return { totalFound, deletedCount, failedCount };
}

module.exports = {
    clearIncidents,
    clearAlerts,
    clearPortfolio,
    clearCoreCompanies: clearPortfolio,
};
