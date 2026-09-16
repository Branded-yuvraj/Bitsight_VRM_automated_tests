/**
 * ServiceNow API Client
 * Queries ServiceNow REST APIs (core_company, syslog, sys_import_set, staging tables, sys_properties)
 * directly via Node.js fetch using HTTP Basic Authentication (SN_USER + SN_PASS).
 */

// Helper to convert ServiceNow "yyyy-MM-dd HH:mm:ss" UTC timestamp to epoch
function toEpoch(snDateTime) {
    if (!snDateTime) return null;
    return new Date(snDateTime.replace(' ', 'T') + 'Z').getTime();
}

function toSnDateTime(isoOrDateStr) {
    if (!isoOrDateStr) return '';
    return isoOrDateStr.replace('T', ' ').split('.')[0];
}

const BITSIGHT_IMPORT_COMPLETE_MESSAGE = "Bitsight Portfolios Import Complete";
const BITSIGHT_IMPORT_START_MESSAGE = "Bitsight Portfolios Import Begin";

class ServiceNowApiClient {
    constructor(options = {}) {
        this.baseUrl = (options.baseUrl || process.env.SN_URL || '').replace(/\/$/, '');
        this.username = options.username || process.env.SN_USER || '';
        this.password = options.password || process.env.SN_PASS || '';
        this.importCompleteMessage = options.importCompleteMessage ||
            BITSIGHT_IMPORT_COMPLETE_MESSAGE ||
            'Bitsight Portfolios Import Complete';
        this.importStartMessage = options.importStartMessage ||
            BITSIGHT_IMPORT_START_MESSAGE ||
            'Bitsight Portfolios Import Begin';
    }

    /**
     * Standard HTTP Basic Auth headers for ServiceNow REST API
     */
    _getHeaders() {
        const auth = Buffer.from(`${this.username}:${this.password}`).toString('base64');
        return {
            'Authorization': `Basic ${auth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
        };
    }

    /**
     * Direct REST fetch against ServiceNow using Basic Authentication
     */
    async _fetch(endpointPath, options = {}) {
        const url = endpointPath.startsWith('http')
            ? endpointPath
            : `${this.baseUrl}${endpointPath.startsWith('/') ? '' : '/'}${endpointPath}`;

        try {
            const res = await fetch(encodeURI(url), {
                ...options,
                method: options.method || 'GET',
                headers: {
                    ...this._getHeaders(),
                    ...(options.headers || {}),
                },
            });

            const status = res.status;
            let body = null;
            try {
                body = await res.json();
            } catch {
                body = null;
            }

            return { ok: res.ok, status, body };
        } catch (err) {
            console.error(`[ServiceNowAPI] Fetch error for ${url}: ${err.message}`);
            return { ok: false, status: 0, body: null, error: err.message };
        }
    }

    /**
     * Helper to query syslog table directly using Basic Auth
     */
    async _queryLogs(pageOrQuery, queryParam, fieldsParam, limitParam) {
        // Support both (page, queryString, fields, limit) and (queryString, fields, limit)
        const queryString = typeof pageOrQuery === 'string' ? pageOrQuery : queryParam;
        const fields = (typeof pageOrQuery === 'string' ? queryParam : fieldsParam) || 'message,sys_created_on,level';
        const limit = (typeof pageOrQuery === 'string' ? fieldsParam : limitParam) || 20;

        const syslogUrl = `/api/now/table/syslog?sysparm_query=${queryString}&sysparm_fields=${fields}&sysparm_limit=${limit}`;
        return await this._fetch(syslogUrl);
    }

    /**
     * Authoritative Precondition Check:
     * Query the user_subscription_type system property to verify it equals '3'
     */
    // async getSubscriptionTypeProperty() {
    //     try {
    //         const url = `/api/now/table/sys_properties?sysparm_query=name=x_bisit_vrm.user_subscription_type^ORname=user_subscription_type` +
    //             `&sysparm_fields=name,value&sysparm_limit=5`;

    //         const { ok, body } = await this._fetch(url);
    //         if (ok && body?.result?.length > 0) {
    //             const prop = body.result.find(p => p.name === 'x_bisit_vrm.user_subscription_type') || body.result[0];
    //             return prop?.value ? String(prop.value).trim() : null;
    //         }
    //     } catch (err) {
    //         console.warn(`[ServiceNowAPI] Note: sys_properties REST query not accessible: ${err.message}`);
    //     }

    //     return null;
    // }

    /**
     * Retrieve the latest log timestamp from syslog matching a specific message.
     * Supports:
     * - getLatestLogByMessage(message)
     * - getLatestLogByMessage(page, message)
     * - getLatestLogByMessage({ message, ... })
     */
    async getLatestLogByMessage(pageOrMessageOrOptions, maybeMessage) {
        let message = '';
        if (typeof pageOrMessageOrOptions === 'string') {
            message = pageOrMessageOrOptions;
        } else if (typeof maybeMessage === 'string') {
            message = maybeMessage;
        } else if (pageOrMessageOrOptions && typeof pageOrMessageOrOptions === 'object') {
            message = pageOrMessageOrOptions.message || pageOrMessageOrOptions.logMessage || pageOrMessageOrOptions.completeMessage || '';
        }

        if (!message) {
            message = this.importCompleteMessage;
        }

        const query = `sourceSTARTSWITHx_bisit^messageLIKE${message}^ORDERBYDESCsys_created_on`;
        const { ok, body } = await this._queryLogs(query, 'message,sys_created_on', 1);

        if (!ok || !body?.result?.length) {
            console.log(`[ServiceNowAPI] No prior log found in syslog for message "${message}" — baseline timestamp is null.`);
            return null;
        }

        const entry = body.result[0];
        console.log(`[ServiceNowAPI] Baseline log found for "${message}": at ${entry.sys_created_on}`);
        return entry.sys_created_on;
    }

    /**
     * Alias for backward compatibility with portfolio import tests
     */
    async getLatestImportCompleteLog(pageOrMessageOrOptions, maybeMessage) {
        return await this.getLatestLogByMessage(pageOrMessageOrOptions, maybeMessage);
    }

    /**
     * Poll syslog until a new import completion log appears strictly after the baseline.
     * Supports checking custom completion messages passed via options.logMessage / options.completeMessage / options.message.
     */
    async waitForImportCompletion(pageOrOptions, maybeOptions = {}) {
        const options = (pageOrOptions && typeof pageOrOptions === 'object' && !pageOrOptions.goto)
            ? pageOrOptions
            : maybeOptions;

        const baselineTimestamp = options.baselineTimestamp;
        const timeoutMs = options.timeoutMs || 300_000;
        const pollMs = options.pollIntervalMs || 15_000;
        const completeMsg = options.logMessage || options.completeMessage || options.message || this.importCompleteMessage;

        const deadline = Date.now() + timeoutMs;
        const baselineEpoch = toEpoch(baselineTimestamp);
        let attempt = 0;

        const query = `sourceSTARTSWITHx_bisit^messageLIKE${completeMsg}^ORDERBYDESCsys_created_on`;

        console.log(`[ServiceNowAPI] Polling syslog for completion log "${completeMsg}" newer than baseline (${baselineTimestamp || 'none'})...`);

        while (Date.now() < deadline) {
            attempt++;
            const { ok, status, body } = await this._queryLogs(query, 'message,sys_created_on', 5);

            if (ok && body?.result?.length > 0) {
                for (const entry of body.result) {
                    const entryEpoch = toEpoch(entry.sys_created_on);
                    if (baselineEpoch === null || entryEpoch > baselineEpoch) {
                        console.log(`[ServiceNowAPI] Import complete log confirmed: "${entry.message}" at ${entry.sys_created_on}`);
                        return entry;
                    }
                }
                console.log(`[ServiceNowAPI] (Attempt ${attempt}) Latest log (${body.result[0].sys_created_on}) is not newer than baseline (${baselineTimestamp || 'none'}). Waiting...`);
            } else if (ok) {
                console.log(`[ServiceNowAPI] (Attempt ${attempt}) No completion log found yet in syslog for "${completeMsg}". Waiting...`);
            } else {
                console.warn(`[ServiceNowAPI] syslog query returned HTTP ${status}`);
            }

            await new Promise((r) => setTimeout(r, pollMs));
        }

        throw new Error(`Timed out after ${timeoutMs}ms waiting for Bitsight import completion log "${completeMsg}".`);
    }

    /**
     * Tier 1 Completeness Query:
     * Fast, lightweight query retrieving ONLY sys_id and x_bisit_vrm_bitsight_vendor_guid across the entire table.
     */
    async getBitsightVendorGuids() {
        const allGuids = [];
        const limit = 200;
        let offset = 0;
        let hasMore = true;

        console.log('[ServiceNowAPI] Fetching full-population Bitsight GUIDs from core_company (Basic Auth)...');

        while (hasMore) {
            const url = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY` +
                `^ORDERBYDESCsys_updated_on` +
                `&sysparm_fields=sys_id,x_bisit_vrm_bitsight_vendor_guid` +
                `&sysparm_limit=${limit}&sysparm_offset=${offset}`;

            const { ok, status, body } = await this._fetch(url);

            if (!ok) {
                throw new Error(`Failed to query core_company GUIDs (HTTP ${status}): ${JSON.stringify(body)}`);
            }

            const results = body?.result || [];
            if (!results.length) {
                hasMore = false;
                break;
            }

            for (const row of results) {
                const guid = row.x_bisit_vrm_bitsight_vendor_guid?.value || row.x_bisit_vrm_bitsight_vendor_guid || '';
                const sysId = row.sys_id?.value || row.sys_id || '';
                if (guid) {
                    allGuids.push({ sys_id: sysId, guid: String(guid).trim() });
                }
            }

            if (results.length < limit) {
                hasMore = false;
            } else {
                offset += limit;
            }
        }

        console.log(`[ServiceNowAPI] Retrieved ${allGuids.length} total Bitsight GUIDs from core_company.`);
        return allGuids;
    }

    /**
     * Tier 2 Sample Query:
     * Full-field query limited strictly to the 15 sampled GUIDs.
     */
    async getCoreCompaniesByGuids(pageOrGuids, maybeGuids = []) {
        const guids = Array.isArray(pageOrGuids) ? pageOrGuids : maybeGuids;
        if (!guids.length) return [];

        console.log(`[ServiceNowAPI] Fetching full fields for ${guids.length} sampled GUIDs from core_company (Basic Auth)...`);
        const url = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidIN${guids.join(',')}`;

        const { ok, status, body } = await this._fetch(url);
        if (!ok) {
            throw new Error(`Failed to query core_company for sample GUIDs (HTTP ${status}): ${JSON.stringify(body)}`);
        }

        const results = body?.result || [];
        return results.map(row => this._normalizeCoreCompanyRecord(row));
    }

    /**
     * Tier 2 Sample Query:
     * Fetch random N records from recently updated core_company records with strictly the requested fields.
     */
    async getRandomRecentlyUpdatedCoreCompanies(sampleSize = 15, poolLimit = 50) {
        console.log(`[ServiceNowAPI] Fetching pool of up to ${poolLimit} recently updated core_company records...`);

        const fields = [
            'x_bisit_vrm_risk_score',
            'x_bisit_vrm_due_date',
            'x_bisit_vrm_is_managed',
            'x_bisit_vrm_company_name',
            'x_bisit_vrm_is_vrm',
            'x_bisit_vrm_primary_domain',
            'x_bisit_vrm_bitsight_rating_category',
            'x_bisit_vrm_bitsight_vendor_guid',
            'x_bisit_vrm_life_cycle_stage_name',
            'x_bisit_vrm_security_rating',
            'x_bisit_vrm_impact_score',
            'x_bisit_vrm_trust_score',
            'x_bisit_vrm_vendor_guid',
            'x_bisit_vrm_rating_date',
            'sys_id',
        ].join(',');

        const url = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY` +
            `^ORDERBYDESCsys_updated_on` +
            `&sysparm_fields=${fields}` +
            `&sysparm_limit=${poolLimit}`;

        const { ok, status, body } = await this._fetch(url);
        if (!ok) {
            throw new Error(`Failed to query recently updated core_company records (HTTP ${status}): ${JSON.stringify(body)}`);
        }

        const results = body?.result || [];
        console.log(`[ServiceNowAPI] Retrieved pool of ${results.length} recently updated core_company records.`);

        if (!results.length) return [];

        // Shuffle pool
        const shuffled = [...results].sort(() => 0.5 - Math.random());
        const selected = shuffled.slice(0, Math.min(sampleSize, shuffled.length));

        console.log(`[ServiceNowAPI] Randomly selected ${selected.length} records for Tier 2 field validation.`);
        return selected.map(row => this._normalizeCoreCompanyRecord(row));
    }

    /**
     * Extracts the failed portfolios count from syslog message matching 'There were {N} failed portfolios.'
     */
    async getFailedPortfoliosCount(options = {}) {
        const { baselineTimestamp, completionTimestamp } = options;
        const baselineSnDate = toSnDateTime(baselineTimestamp);
        const completionSnDate = toSnDateTime(completionTimestamp);

        let query = `sourceSTARTSWITHx_bisit^messageLIKEfailed portfolios`;
        if (baselineSnDate) {
            query += `^sys_created_on>=${baselineSnDate}`;
        }
        if (completionSnDate) {
            query += `^sys_created_on<=${completionSnDate}`;
        }
        query += `^ORDERBYDESCsys_created_on`;

        const { ok, body } = await this._queryLogs(query, 'message,sys_created_on', 50);
        if (ok && body?.result?.length) {
            for (const entry of body.result) {
                const match = String(entry.message || '').match(/There were\s+(\d+)\s+failed portfolios/i);
                if (match) {
                    const count = parseInt(match[1], 10);
                    console.log(`[ServiceNowAPI] Found syslog failure summary: "${entry.message}" -> failedCount = ${count}`);
                    return count;
                }
            }
        }

        // Fallback: check general script level failures
        const scriptFailures = await this.getScriptLevelFailures(options);
        return scriptFailures.scriptLevelFailedCount || 0;
    }

    /**
     * Script-Level Failure Tracking:
     * Queries syslog between baselineTimestamp and completionTimestamp
     */
    async getScriptLevelFailures(pageOrOptions, maybeOptions = {}) {
        const options = (pageOrOptions && typeof pageOrOptions === 'object' && !pageOrOptions.goto)
            ? pageOrOptions
            : maybeOptions;

        const { baselineTimestamp, completionTimestamp } = options;
        const baselineSnDate = toSnDateTime(baselineTimestamp);
        const completionSnDate = toSnDateTime(completionTimestamp);

        let query = `sourceSTARTSWITHx_bisit`;
        if (baselineSnDate) {
            query += `^sys_created_on>=${baselineSnDate}`;
        }
        if (completionSnDate) {
            query += `^sys_created_on<=${completionSnDate}`;
        }
        query += `^ORDERBYDESCsys_created_on`;

        const { ok, body } = await this._queryLogs(query, 'message,sys_created_on,level', 200);

        let scriptLevelFailedCount = 0;
        const scriptLevelFailedGuids = [];
        let summaryFound = false;

        if (ok && body?.result) {
            for (const entry of body.result) {
                const msg = entry.message || '';

                // Check for summary: "There were {N} failed portfolios."
                const summaryMatch = msg.match(/There were\s+(\d+)\s+failed portfolios/i);
                if (summaryMatch) {
                    scriptLevelFailedCount = parseInt(summaryMatch[1], 10);
                    summaryFound = true;
                }

                // Check for per-vendor error: "Failed to import company: ... (Vendor GUID: {guid}) - Error: ..."
                const guidMatch = msg.match(/Vendor GUID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ||
                    msg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

                if (msg.toLowerCase().includes('failed to import') && guidMatch) {
                    if (!scriptLevelFailedGuids.includes(guidMatch[1] || guidMatch[0])) {
                        scriptLevelFailedGuids.push(guidMatch[1] || guidMatch[0]);
                    }
                }
            }
        }

        if (!summaryFound && scriptLevelFailedGuids.length > 0) {
            scriptLevelFailedCount = scriptLevelFailedGuids.length;
        }

        const discrepancy = summaryFound && (scriptLevelFailedGuids.length !== scriptLevelFailedCount);
        if (discrepancy) {
            console.warn(
                `[ServiceNowAPI] WARNING: Discrepancy in script-level failure logs: Summary count is ${scriptLevelFailedCount}, but found ${scriptLevelFailedGuids.length} individual failed GUID entries.`
            );
        }

        console.log(`[ServiceNowAPI] Script-level failures: count=${scriptLevelFailedCount}, parsedGUIDs=${scriptLevelFailedGuids.length}`);

        return {
            scriptLevelFailedCount,
            scriptLevelFailedGuids,
            discrepancyWarning: discrepancy,
        };
    }

    /**
     * Extracts individual failed company records from syslog using the scoped failure query.
     * Supports timestamp scoping via baselineTimestamp/sinceTimestamp and completionTimestamp.
     */
    async getFailedImportCompanies(options = {}) {
        let query = options.query || options.sysparm_query;

        if (!query) {
            const { baselineTimestamp, sinceTimestamp, completionTimestamp } = options;
            const startTimestamp = sinceTimestamp || baselineTimestamp;
            const startSnDate = startTimestamp ? toSnDateTime(startTimestamp) : null;
            const endSnDate = completionTimestamp ? toSnDateTime(completionTimestamp) : null;

            const baseFilter = 'sys_scope=39896b4c3bf21290f74c563a85e45a88^messageSTARTSWITHFailed to import company:';

            if (startSnDate) {
                query = `sys_created_on>=${startSnDate}^` + baseFilter;
            } else {
                query = 'sys_created_onONToday@javascript:gs.beginningOfToday()@javascript:gs.endOfToday()^' + baseFilter;
            }

            if (endSnDate) {
                query += `^sys_created_on<=${endSnDate}`;
            }

            query += '^ORDERBYDESCsys_created_on';
        }

        const fields = options.fields || 'message,sys_created_on,level,sys_id';
        const limit = options.limit || 200;

        console.log(`[ServiceNowAPI] Fetching failed import company logs from syslog with query: ${query}`);
        const { ok, status, body } = await this._queryLogs(query, fields, limit);

        if (!ok) {
            console.warn(`[ServiceNowAPI] Failed to fetch failed company logs (HTTP ${status})`);
            return [];
        }

        const results = body?.result || [];
        const failedCompanies = [];

        for (const entry of results) {
            const msg = entry.message || '';
            // Example: Failed to import company: Zoom Video Communications (Vendor GUID: 6fdcbcaf-06cf-46d9-a1cd-29e089fd86a6) - Error: Lifecycle stage not found.
            const companyMatch = msg.match(/Failed to import company:\s*(.*?)\s*\(Vendor GUID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)(?:\s*-\s*Error:\s*(.*))?/i);
            if (companyMatch) {
                const companyName = companyMatch[1]?.trim();
                const vendorGuid = companyMatch[2]?.trim();
                const error = companyMatch[3]?.trim() || '';
                failedCompanies.push({
                    companyName,
                    vendorGuid,
                    error,
                    message: msg,
                    sys_created_on: entry.sys_created_on,
                });
            } else {
                const guidMatch = msg.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
                if (guidMatch) {
                    failedCompanies.push({
                        companyName: '',
                        vendorGuid: guidMatch[0].trim(),
                        error: msg,
                        message: msg,
                        sys_created_on: entry.sys_created_on,
                    });
                }
            }
        }

        console.log(`[ServiceNowAPI] Parsed ${failedCompanies.length} failed company log entries from syslog.`);
        return failedCompanies;
    }

    /**
     * Transform-Level Failure Tracking:
     * 1. Identifies import set batch created after baselineTriggerTimestamp.
     * 2. Queries staging table (x_bisit_vrm_portfolio_import) for sys_import_state.
     * 3. Aggregates counts for inserted, updated, ignored, error.
     */
    async getTransformLevelFailures(pageOrOptions, maybeOptions = {}) {
        const options = (pageOrOptions && typeof pageOrOptions === 'object' && !pageOrOptions.goto)
            ? pageOrOptions
            : maybeOptions;

        const { baselineTriggerTimestamp } = options;
        const baselineSnDate = toSnDateTime(baselineTriggerTimestamp);

        // 1. Query sys_import_set for the batch
        let setQuery = `ORDERBYDESCsys_created_on`;
        if (baselineSnDate) {
            setQuery = `sys_created_on>=${baselineSnDate}^` + setQuery;
        }

        const setUrl = `/api/now/table/sys_import_set?sysparm_query=${setQuery}&sysparm_limit=5`;
        const { ok: setOk, body: setBody } = await this._fetch(setUrl);

        let batchSysId = null;
        if (setOk && setBody?.result?.length > 0) {
            batchSysId = setBody.result[0].sys_id;
            console.log(`[ServiceNowAPI] Identified Import Set Batch sys_id: ${batchSysId}`);
        }

        if (!batchSysId) {
            console.log('[ServiceNowAPI] No matching sys_import_set batch found for this run. Transform-level failed count = 0.');
            return {
                batchSysId: null,
                insertedCount: 0,
                updatedCount: 0,
                ignoredCount: 0,
                errorCount: 0,
                transformLevelFailedCount: 0,
                transformFailedGuids: [],
            };
        }

        // 2. Query staging table x_bisit_vrm_portfolio_import for this batch
        const stagingUrl = `/api/now/table/x_bisit_vrm_portfolio_import?sysparm_query=sys_import_set=${batchSysId}` +
            `&sysparm_fields=sys_import_state,sys_id,u_bitsight_vendor_guid,x_bisit_vrm_bitsight_vendor_guid&sysparm_limit=500`;

        const { ok: stgOk, body: stgBody } = await this._fetch(stagingUrl);

        let insertedCount = 0;
        let updatedCount = 0;
        let ignoredCount = 0;
        let errorCount = 0;
        const transformFailedGuids = [];

        if (stgOk && stgBody?.result) {
            for (const row of stgBody.result) {
                const state = String(row.sys_import_state || '').toLowerCase();
                const guid = row.x_bisit_vrm_bitsight_vendor_guid || row.u_bitsight_vendor_guid || '';

                if (state.includes('insert')) {
                    insertedCount++;
                } else if (state.includes('update')) {
                    updatedCount++;
                } else if (state.includes('ignore')) {
                    ignoredCount++;
                    if (guid) transformFailedGuids.push(guid);
                } else if (state.includes('error')) {
                    errorCount++;
                    if (guid) transformFailedGuids.push(guid);
                }
            }
        }

        const transformLevelFailedCount = errorCount + ignoredCount;
        console.log(`[ServiceNowAPI] Transform-level staging stats: inserted=${insertedCount}, updated=${updatedCount}, ignored=${ignoredCount}, error=${errorCount} (failed=${transformLevelFailedCount})`);

        return {
            batchSysId,
            insertedCount,
            updatedCount,
            ignoredCount,
            errorCount,
            transformLevelFailedCount,
            transformFailedGuids,
        };
    }

    /**
     * Normalize ServiceNow core_company record fields
     */
    /**
     * Normalize ServiceNow core_company record fields
     */
    _normalizeCoreCompanyRecord(raw) {
        const unwrap = (val) => (val && typeof val === 'object' && val.value !== undefined ? val.value : val);

        const guid = unwrap(raw.x_bisit_vrm_bitsight_vendor_guid) || '';
        const name = unwrap(raw.x_bisit_vrm_company_name) || unwrap(raw.name) || unwrap(raw.u_name) || '';
        const primaryDomain = unwrap(raw.x_bisit_vrm_primary_domain) || unwrap(raw.u_primary_domain) || unwrap(raw.website) || '';
        const logo = unwrap(raw.u_logo) || '';

        // Rating as number
        const rawRating = unwrap(raw.x_bisit_vrm_security_rating) || unwrap(raw.u_rating) || unwrap(raw.x_bisit_vrm_rating) || unwrap(raw.u_bitsight_security_rating);
        const rating = (rawRating !== null && rawRating !== undefined && rawRating !== '') ? Number(rawRating) : null;

        let ratingDate = unwrap(raw.x_bisit_vrm_rating_date) || unwrap(raw.u_rating_date) || unwrap(raw.x_bisit_vrm_rating_date) || '';
        if (ratingDate && typeof ratingDate === 'string') {
            ratingDate = ratingDate.split(' ')[0].split('T')[0];
        }

        const ratingCategory = unwrap(raw.x_bisit_vrm_bitsight_rating_category) || '';

        const href = unwrap(raw.u_href) || unwrap(raw.x_bisit_vrm_href) || '';
        const displayUrl = unwrap(raw.u_display_url) || unwrap(raw.x_bisit_vrm_display_url) || '';
        const industry = unwrap(raw.u_industry) || unwrap(raw.x_bisit_vrm_industry) || '';
        const subscriptionType = unwrap(raw.u_subscription_type) || unwrap(raw.x_bisit_vrm_subscription_type) || '';

        const impactScore = unwrap(raw.x_bisit_vrm_impact_score) || unwrap(raw.u_vrm_impact_score) || null;
        const riskScore = unwrap(raw.x_bisit_vrm_risk_score) || unwrap(raw.u_vrm_risk_score) || null;
        const trustScore = unwrap(raw.x_bisit_vrm_trust_score) || unwrap(raw.u_vrm_trust_score) || null;

        let dueDate = unwrap(raw.x_bisit_vrm_due_date) || unwrap(raw.u_vrm_due_date) || '';
        if (dueDate && typeof dueDate === 'string') {
            dueDate = dueDate.split(' ')[0].split('T')[0];
        }

        const vrmVendorGuid = unwrap(raw.x_bisit_vrm_vendor_guid) || unwrap(raw.u_vrm_vendor_guid) || unwrap(raw.x_bisit_vrm_vrm_vendor_guid) || '';

        const rawIsManaged = unwrap(raw.x_bisit_vrm_is_managed) || unwrap(raw.u_is_managed);
        const isManaged = rawIsManaged === true || rawIsManaged === 'true' || rawIsManaged === '1' || rawIsManaged === 1;

        const lifeCycleStage = unwrap(raw.x_bisit_vrm_life_cycle_stage_name) || unwrap(raw.u_vrm_life_cycle_stage) || unwrap(raw.x_bisit_vrm_life_cycle_stage) || '';

        const rawIsVrm = unwrap(raw.x_bisit_vrm_is_vrm) || unwrap(raw.u_is_vrm);
        const isVrm = rawIsVrm === true || rawIsVrm === 'true' || rawIsVrm === '1' || rawIsVrm === 1;

        return {
            sys_id: unwrap(raw.sys_id),
            x_bisit_vrm_bitsight_vendor_guid: guid,
            x_bisit_vrm_company_name: name,
            x_bisit_vrm_primary_domain: primaryDomain,
            x_bisit_vrm_security_rating: rating,
            x_bisit_vrm_rating_date: ratingDate,
            x_bisit_vrm_bitsight_rating_category: ratingCategory,
            x_bisit_vrm_impact_score: impactScore,
            x_bisit_vrm_risk_score: riskScore,
            x_bisit_vrm_trust_score: trustScore,
            x_bisit_vrm_due_date: dueDate,
            x_bisit_vrm_vendor_guid: vrmVendorGuid,
            x_bisit_vrm_is_managed: isManaged,
            x_bisit_vrm_life_cycle_stage_name: lifeCycleStage,
            x_bisit_vrm_is_vrm: isVrm,
            // Generic aliases
            u_name: name,
            u_primary_domain: primaryDomain,
            u_logo: logo,
            u_rating: rating,
            u_rating_date: ratingDate,
            u_href: href,
            u_display_url: displayUrl,
            u_industry: industry,
            u_subscription_type: subscriptionType,
            u_vrm_impact_score: impactScore,
            u_vrm_risk_score: riskScore,
            u_vrm_trust_score: trustScore,
            u_vrm_due_date: dueDate,
            u_vrm_vendor_guid: vrmVendorGuid,
            u_is_managed: isManaged,
            u_vrm_life_cycle_stage: lifeCycleStage,
            u_is_vrm: isVrm,
            raw,
        };
    }

    /**
     * Generic query for any ServiceNow table records
     * GET /api/now/table/{tableName}
     * Supports options as object or string query: getTableRecords('incident', 'short_descriptionLIKEbitsight')
     */
    async getTableRecords(tableName, optionsOrQuery = {}) {
        const options = typeof optionsOrQuery === 'string' ? { query: optionsOrQuery } : (optionsOrQuery || {});
        const allRecords = [];
        const limit = options.limit || 200;
        let offset = options.offset || 0;
        const query = options.query || options.sysparm_query || '';
        const fields = options.fields || options.sysparm_fields || '';
        let hasMore = true;

        console.log(`[ServiceNowAPI] Fetching records from table "${tableName}"${query ? ` with query "${query}"` : ''}...`);

        while (hasMore) {
            const queryParts = [];
            if (query) queryParts.push(`sysparm_query=${query}`);
            if (fields) queryParts.push(`sysparm_fields=${fields}`);
            queryParts.push(`sysparm_limit=${limit}`);
            queryParts.push(`sysparm_offset=${offset}`);

            const url = `/api/now/table/${tableName}?${queryParts.join('&')}`;
            const { ok, status, body } = await this._fetch(url);

            if (!ok) {
                throw new Error(`Failed to query table ${tableName} (HTTP ${status}): ${JSON.stringify(body)}`);
            }

            const records = body?.result || [];
            allRecords.push(...records);

            if (records.length < limit || (options.limit && options.fetchAll !== true)) {
                hasMore = false;
            } else {
                offset += limit;
            }
        }

        console.log(`[ServiceNowAPI] Retrieved ${allRecords.length} records from table "${tableName}".`);
        return allRecords;
    }

    /**
     * Fetch ServiceNow alerts records from table x_bisit_vrm_bitsight_alerts
     * GET /api/now/table/x_bisit_vrm_bitsight_alerts?sysparm_fields=sys_id,bitsight_vendor_guid,description,x_bisit_vrm_bitsight_alert_guid,severity,trigger,type
     */
    async getAlertsRecords(options = {}) {
        const tableName = options.tableName || 'x_bisit_vrm_bitsight_alerts';
        const defaultFields = 'sys_id,bitsight_vendor_guid,description,x_bisit_vrm_bitsight_alert_guid,severity,trigger,type';
        const fields = options.fields || options.sysparm_fields || defaultFields;
        return await this.getTableRecords(tableName, { ...options, fields });
    }

    /**
     * Fetch Bitsight Incidents from incident table
     * GET /api/now/table/incident?sysparm_query=short_descriptionLIKEbitsight&sysparm_fields=description,sys_id,x_bisit_vrm_bitsight_alert_guid
     */
    async getBitsightIncidents(optionsOrQuery = {}) {
        const options = typeof optionsOrQuery === 'string' ? { query: optionsOrQuery } : (optionsOrQuery || {});
        const defaultQuery = 'short_descriptionLIKEbitsight';
        const defaultFields = 'description,sys_id,x_bisit_vrm_bitsight_alert_guid';
        const query = options.query || options.sysparm_query || defaultQuery;
        const fields = options.fields || options.sysparm_fields || defaultFields;
        return await this.getTableRecords('incident', { ...options, query, fields });
    }

    /**
     * Generic delete record from any ServiceNow table by sys_id
     * DELETE /api/now/table/{tableName}/{sys_id}
     */
    async deleteTableRecord(tableName, sysId) {
        if (!sysId || typeof sysId !== 'string') {
            throw new Error(`deleteTableRecord requires a valid sys_id for table "${tableName}"`);
        }
        const url = `/api/now/table/${tableName}/${encodeURIComponent(sysId.trim())}`;
        const { ok, status, body } = await this._fetch(url, { method: 'DELETE' });

        if (!ok && status !== 204 && status !== 200) {
            throw new Error(`Failed to delete record ${sysId} from table ${tableName} (HTTP ${status}): ${JSON.stringify(body)}`);
        }

        return { ok: true, status, sysId };
    }

    /**
     * Delete an incident by sys_id
     * DELETE /api/now/table/incident/{sys_id}
     */
    async deleteIncident(sysId) {
        return await this.deleteTableRecord('incident', sysId);
    }

    /**
     * Delete a Bitsight alert by sys_id
     * DELETE /api/now/table/x_bisit_vrm_bitsight_alerts/{sys_id}
     */
    async deleteAlert(sysId) {
        return await this.deleteTableRecord('x_bisit_vrm_bitsight_alerts', sysId);
    }

    /**
     * Fetch Bitsight core_company records from core_company table
     * GET /api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY
     */
    async getBitsightCoreCompanies(options = {}) {
        const defaultQuery = 'x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY';
        const defaultFields = [
            'sys_id',
            'x_bisit_vrm_bitsight_vendor_guid',
            'x_bisit_vrm_primary_domain',
            'x_bisit_vrm_is_vrm',
            'u_is_vrm',
            'x_bisit_vrm_vendor_guid',
            'x_bisit_vrm_company_name',
            'name',
        ].join(',');
        const query = options.query || options.sysparm_query || defaultQuery;
        const fields = options.fields || options.sysparm_fields || defaultFields;
        const records = await this.getTableRecords('core_company', { ...options, query, fields });
        return records.map(r => this._normalizeCoreCompanyRecord(r));
    }

    /**
     * Delete a core_company record by sys_id
     * DELETE /api/now/table/core_company/{sys_id}
     */
    async deleteCoreCompany(sysId) {
        return await this.deleteTableRecord('core_company', sysId);
    }

    /**
     * Update a record in any ServiceNow table by sys_id using PATCH
     * PATCH /api/now/table/{tableName}/{sys_id}
     */
    async updateRecord(tableName, sysId, payload = {}) {
        if (!sysId || typeof sysId !== 'string') {
            throw new Error(`updateRecord requires a valid sys_id for table "${tableName}"`);
        }
        const url = `/api/now/table/${tableName}/${encodeURIComponent(sysId.trim())}`;
        const { ok, status, body } = await this._fetch(url, {
            method: 'PATCH',
            body: JSON.stringify(payload),
        });

        if (!ok && status !== 200) {
            throw new Error(`Failed to update ${tableName}/${sysId} (HTTP ${status}): ${JSON.stringify(body)}`);
        }

        return body?.result || body;
    }
}

module.exports = {
    ServiceNowApiClient,
    toEpoch,
    toSnDateTime,
};
