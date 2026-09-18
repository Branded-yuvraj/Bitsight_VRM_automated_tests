import { expect } from '@playwright/test';
const BASE_URL = process.env.SN_URL;
const COMPLETE_MESSAGE = 'Bitsight Portfolios Import Complete';

async function getAllCoreCompaniesWithGuid(page) {
    const fields = 'sys_id,name,x_bisit_vrm_bitsight_vendor_guid';
    const limit = 200;
    let offset = 0;
    let hasMore = true;
    const allRecords = [];

    while (hasMore) {
        const url = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY` +
            `&sysparm_fields=${fields}&sysparm_limit=${limit}&sysparm_offset=${offset}`;
        const { ok, status, body } = await snFetch(page, url);
        if (!ok) {
            throw new Error(`Failed to query core_company with guid (HTTP ${status}): ${JSON.stringify(body)}`);
        }

        const results = body?.result || [];
        if (!results.length) {
            hasMore = false;
            break;
        }

        for (const row of results) {
            allRecords.push({
                sys_id: unwrapField(row.sys_id) || '',
                name: unwrapField(row.name) || '',
                guid: unwrapField(row.x_bisit_vrm_bitsight_vendor_guid) || '',
            });
        }

        if (results.length < limit) {
            hasMore = false;
        } else {
            offset += limit;
        }
    }

    return allRecords;
}

// Fetches core_company records that have a Bitsight vendor GUID, along with
// their current "vendor" flag - the field this configuration toggle drives.
async function getCoreCompanyVendorFlags(page) {
    const url = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY` +
        `&sysparm_fields=sys_id,name,vendor,x_bisit_vrm_bitsight_vendor_guid&sysparm_limit=1000`;
    const { ok, status, body } = await snFetch(page, url);
    if (!ok) {
        throw new Error(`Failed to query core_company vendor flags (HTTP ${status}): ${JSON.stringify(body)}`);
    }

    return (body?.result || []).map(row => ({
        sys_id: unwrapField(row.sys_id) || '',
        name: unwrapField(row.name) || '',
        vendor: unwrapField(row.vendor),
        guid: unwrapField(row.x_bisit_vrm_bitsight_vendor_guid) || '',
    }));
}

// ServiceNow booleans come back through the Table API as the strings
// "true"/"false" - normalize to an actual boolean.
function isVendorTrue(value) {
    return value === true || value === 'true';
}


// ---- Session-authenticated fetch helper (runs inside the browser context) ----

async function snFetch(page, url) {
    return await page.evaluate(async (url) => {
        const token = window.g_ck || (window.top && window.top.g_ck) || '';
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-UserToken': token,
        };
        const res = await fetch(url, { method: 'GET', credentials: 'include', headers });
        const status = res.status;
        let body = null;
        try {
            body = await res.json();
        } catch {
            body = null;
        }
        return { ok: res.ok, status, body };
    }, url);
}

// ServiceNow returns sys_created_on / sys_updated_on as "yyyy-MM-dd HH:mm:ss"
// in UTC with no offset suffix. Normalize to a real epoch before comparing.
function toEpoch(snDateTime) {
    if (!snDateTime) return null;
    return new Date(snDateTime.replace(' ', 'T') + 'Z').getTime();
}

function toSnDateTime(isoString) {
    return isoString.replace('T', ' ').split('.')[0];
}

// ---- Step: grab the latest "Import Complete" log BEFORE triggering the job ----
// If none exists for today, that's fine — baseline is just null, and any
// completion log found afterward counts as fresh.
async function getLatestImportCompleteLog(page) {
    const url = `/api/now/table/syslog?sysparm_query=` +
        `sourceSTARTSWITHx_bisit^sys_created_onONToday@javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(0)^messageLIKE${encodeURIComponent(COMPLETE_MESSAGE)}` +
        `^ORDERBYDESCsys_created_on` +
        `&sysparm_fields=message,sys_created_on&sysparm_limit=1`;

    const { ok, body } = await snFetch(page, url);
    if (!ok || !body?.result?.length) {
        console.log('[getLatestImportCompleteLog] No prior completion log found for today — baseline is null.');
        return null;
    }

    const entry = body.result[0];
    console.log(`[getLatestImportCompleteLog] Baseline completion log found: "${entry.message}" at ${entry.sys_created_on}`);
    return entry.sys_created_on;
}

// ---- Step: poll for a NEW completion log strictly after the baseline ----
async function waitForNewImportLog(page, baselineTimestamp, timeoutMs = 700_000, pollMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    const baselineEpoch = toEpoch(baselineTimestamp);
    let attempt = 0;

    const url = `/api/now/table/syslog?sysparm_query=` +
        `sourceSTARTSWITHx_bisit^sys_created_onONToday@javascript:gs.daysAgoStart(0)@javascript:gs.daysAgoEnd(0)^messageLIKE${encodeURIComponent(COMPLETE_MESSAGE)}` +
        `^ORDERBYDESCsys_created_on` +
        `&sysparm_fields=message,sys_created_on&sysparm_limit=1`;

    while (Date.now() < deadline) {
        attempt++;
        console.log(`[waitForNewImportLog] Attempt ${attempt}: checking syslog for a new completion entry...`);

        const { ok, status, body } = await snFetch(page, url);

        if (ok && body?.result?.length > 0) {
            const entry = body.result[0];
            const entryEpoch = toEpoch(entry.sys_created_on);

            if (baselineEpoch === null || entryEpoch > baselineEpoch) {
                console.log(`[waitForNewImportLog] Found NEW completion log: "${entry.message}" at ${entry.sys_created_on}`);
                return true;
            } else {
                console.log(`[waitForNewImportLog] Latest log (${entry.sys_created_on}) is not newer than baseline (${baselineTimestamp}) yet.`);
            }
        } else if (ok) {
            console.log('[waitForNewImportLog] No matching log entry found yet.');
        } else {
            console.log(`[waitForNewImportLog] syslog query failed with status ${status}: ${JSON.stringify(body)}`);
        }

        await new Promise(r => setTimeout(r, pollMs));
    }

    console.log('[waitForNewImportLog] Timed out waiting for a new import completion log.');
    return false;
}

async function getBitsightFieldNames(page) {
    const url = `/api/now/table/sys_dictionary?sysparm_query=name=core_company^column_labelLIKEBitsight` +
        `&sysparm_fields=element,column_label&sysparm_limit=100`;

    const { ok, body } = await snFetch(page, url);
    if (!ok || !body?.result) return [];
    return body.result.map(r => ({ element: r.element, label: r.column_label }));
}

// Attempt 1: a record actually touched since the import baseline.
// Attempt 2 (fallback): the sync may have run with no changes to apply —
// fall back to any existing populated record so we still confirm the
// data/mapping is intact.
async function getSingleCompanyRecord(page, guidField, fieldNames, baselineIso) {
    const baselineSnDate = toSnDateTime(baselineIso);

    const freshUrl = `/api/now/table/core_company?sysparm_query=` +
        `${guidField.element}ISNOTEMPTY^sys_updated_on>=${encodeURIComponent(baselineSnDate)}` +
        `^ORDERBYDESCsys_updated_on` +
        `&sysparm_fields=${encodeURIComponent(fieldNames)}&sysparm_limit=1`;

    const freshResult = await snFetch(page, freshUrl);
    if (freshResult.ok && freshResult.body?.result?.length > 0) {
        console.log('[getSingleCompanyRecord] Found a record updated during this run (fresh data).');
        return { ok: true, status: freshResult.status, records: freshResult.body.result, fresh: true };
    }

    console.log('[getSingleCompanyRecord] No record updated since baseline — likely a no-op sync. Falling back to any existing matching record.');
    const fallbackUrl = `/api/now/table/core_company?sysparm_query=${guidField.element}ISNOTEMPTY` +
        `^ORDERBYDESCsys_updated_on` +
        `&sysparm_fields=${encodeURIComponent(fieldNames)}&sysparm_limit=1`;

    const fallbackResult = await snFetch(page, fallbackUrl);
    return {
        ok: fallbackResult.ok,
        status: fallbackResult.status,
        records: fallbackResult.body?.result ?? [],
        fresh: false,
    };
}
function unwrapField(val) {
    return (val && typeof val === 'object' && val.value !== undefined) ? val.value : val;
}

// Tier 1 Completeness Query: full-population GUIDs from core_company.
// Does NOT filter by sys_updated_on.
async function getBitsightVendorGuids(page) {
    const allGuids = [];
    const limit = 200;
    let offset = 0;
    let hasMore = true;

    console.log('[getBitsightVendorGuids] Fetching full-population Bitsight GUIDs from core_company (session token)...');

    while (hasMore) {
        const url = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY` +
            `^ORDERBYDESCsys_updated_on` +
            `&sysparm_fields=sys_id,x_bisit_vrm_bitsight_vendor_guid` +
            `&sysparm_limit=${limit}&sysparm_offset=${offset}`;

        const { ok, status, body } = await snFetch(page, url);
        if (!ok) {
            throw new Error(`Failed to query core_company GUIDs (HTTP ${status}): ${JSON.stringify(body)}`);
        }

        const results = body?.result || [];
        if (!results.length) {
            hasMore = false;
            break;
        }

        for (const row of results) {
            const guid = unwrapField(row.x_bisit_vrm_bitsight_vendor_guid) || '';
            const sysId = unwrapField(row.sys_id) || '';
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

    console.log(`[getBitsightVendorGuids] Retrieved ${allGuids.length} total Bitsight GUIDs from core_company.`);
    return allGuids;
}

// Tier 2 Sample Query: random N records from recently updated core_company records.
async function getRandomRecentlyUpdatedCoreCompanies(page, sampleSize = 15, poolLimit = 50) {
    console.log(`[getRandomRecentlyUpdatedCoreCompanies] Fetching pool of up to ${poolLimit} recently updated core_company records...`);

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

    const { ok, status, body } = await snFetch(page, url);
    if (!ok) {
        throw new Error(`Failed to query recently updated core_company records (HTTP ${status}): ${JSON.stringify(body)}`);
    }

    const results = body?.result || [];
    console.log(`[getRandomRecentlyUpdatedCoreCompanies] Retrieved pool of ${results.length} recently updated core_company records.`);

    if (!results.length) return [];

    const shuffled = [...results].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, Math.min(sampleSize, shuffled.length));

    console.log(`[getRandomRecentlyUpdatedCoreCompanies] Randomly selected ${selected.length} records for Tier 2 field validation.`);

    return selected.map(row => {
        const normalized = {};
        for (const key of Object.keys(row)) {
            normalized[key] = unwrapField(row[key]);
        }
        return normalized;
    });
}

// Extracts the failed portfolios count from syslog message matching
// 'There were {N} failed portfolios.' between baseline and completion.
async function getFailedPortfoliosCount(page, options = {}) {
    const { baselineTimestamp, completionTimestamp } = options;
    const baselineSnDate = baselineTimestamp ? toSnDateTime(baselineTimestamp) : '';
    const completionSnDate = completionTimestamp ? toSnDateTime(completionTimestamp) : '';

    let query = `sourceSTARTSWITHx_bisit^messageLIKEfailed portfolios`;
    if (baselineSnDate) {
        query += `^sys_created_on>=${baselineSnDate}`;
    }
    if (completionSnDate) {
        query += `^sys_created_on<=${completionSnDate}`;
    }
    query += `^ORDERBYDESCsys_created_on`;

    const url = `/api/now/table/syslog?sysparm_query=${query}&sysparm_fields=message,sys_created_on&sysparm_limit=50`;
    const { ok, body } = await snFetch(page, url);

    if (ok && body?.result?.length) {
        for (const entry of body.result) {
            const match = String(entry.message || '').match(/There were\s+(\d+)\s+failed portfolios/i);
            if (match) {
                const count = parseInt(match[1], 10);
                console.log(`[getFailedPortfoliosCount] Found syslog failure summary: "${entry.message}" -> failedCount = ${count}`);
                return count;
            }
        }
    }

    console.log('[getFailedPortfoliosCount] No failure summary found in syslog - assuming 0 failed portfolios.');
    return 0;
}
// Generic loose-equality comparator for ground-truth vs ServiceNow field values.
// Treats null/undefined/'' as equivalent, compares numbers numerically,
// booleans leniently (true/'true'/1/'1'), dates by their date-only portion,
// and everything else as trimmed, case-insensitive strings.
function areValuesEqual(expected, actual) {
    const isEmpty = (v) => v === undefined || v === null || v === '';

    if (isEmpty(expected) && isEmpty(actual)) {
        return true;
    }
    if (isEmpty(expected) || isEmpty(actual)) {
        return false;
    }

    // Boolean-ish values
    const boolLike = (v) => typeof v === 'boolean' || v === 'true' || v === 'false' || v === 1 || v === 0 || v === '1' || v === '0';
    if (boolLike(expected) && boolLike(actual)) {
        const toBool = (v) => v === true || v === 'true' || v === 1 || v === '1';
        return toBool(expected) === toBool(actual);
    }

    // Numeric values
    const expNum = Number(expected);
    const actNum = Number(actual);
    if (!Number.isNaN(expNum) && !Number.isNaN(actNum) && expected !== '' && actual !== '') {
        return expNum === actNum;
    }

    // Date-like strings ("yyyy-MM-dd HH:mm:ss" or ISO) - compare date-only portion
    const dateLike = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v);
    if (dateLike(expected) && dateLike(actual)) {
        const dateOnly = (v) => v.split('T')[0].split(' ')[0];
        return dateOnly(expected) === dateOnly(actual);
    }

    // Fallback: trimmed, case-insensitive string comparison
    return String(expected).trim().toLowerCase() === String(actual).trim().toLowerCase();
}



// Normalizes a domain/URL value for comparison: strips protocol, "www.",
// trailing slash, and lowercases/trims the result.
function normalizeDomain(value) {
    if (!value) return '';
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/^www\./, '')
        .replace(/\/+$/, '');
}

function normalizeText(value) {
    return value ? String(value).trim().toLowerCase() : '';
}

// Fetches existing core_company records with the fields the import job
// matches against: native name/website, plus the Bitsight vendor GUID
// field (populated on records already linked to a Bitsight company).
// Adjust 'website' below if the app matches against a different field.
async function getCoreCompanyMatchFields(page) {
    const fields = 'sys_id,name,website,x_bisit_vrm_bitsight_vendor_guid,sys_updated_on';
    const allRecords = [];
    const limit = 200;
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
        const url = `/api/now/table/core_company?sysparm_fields=${fields}` +
            `&sysparm_limit=${limit}&sysparm_offset=${offset}`;
        const { ok, status, body } = await snFetch(page, url);
        if (!ok) {
            throw new Error(`Failed to query core_company for matching (HTTP ${status}): ${JSON.stringify(body)}`);
        }

        const results = body?.result || [];
        if (!results.length) {
            hasMore = false;
            break;
        }

        for (const row of results) {
            allRecords.push({
                sys_id: unwrapField(row.sys_id) || '',
                name: unwrapField(row.name) || '',
                website: unwrapField(row.website) || '',
                bitsight_vendor_guid: unwrapField(row.x_bisit_vrm_bitsight_vendor_guid) || '',
                sys_updated_on: unwrapField(row.sys_updated_on) || '',
            });
        }

        if (results.length < limit) {
            hasMore = false;
        } else {
            offset += limit;
        }
    }

    return allRecords;
}

// Given the full Bitsight CM company list and the current core_company
// records, returns:
//   - unmatched: a Bitsight company whose guid, domain, and name all fail
//     to match any existing core_company record.
//   - matched: a Bitsight company that already matches an existing
//     core_company record (used as the "still imports fine" sanity check).
function classifyBitsightCompanies(bitsightCompanies, coreCompanyRecords) {
    const existingGuids = new Set(
        coreCompanyRecords.map(r => normalizeText(r.bitsight_vendor_guid)).filter(Boolean)
    );
    const existingDomains = new Set(
        coreCompanyRecords.map(r => normalizeDomain(r.website)).filter(Boolean)
    );
    const existingNames = new Set(
        coreCompanyRecords.map(r => normalizeText(r.name)).filter(Boolean)
    );

    let unmatched = null;
    let matched = null;

    for (const company of bitsightCompanies) {
        const guid = normalizeText(company.guid || company.bitsight_vendor_guid);
        const domain = normalizeDomain(company.primary_domain);
        const name = normalizeText(company.name);

        const guidHit = guid && existingGuids.has(guid);
        const domainHit = domain && existingDomains.has(domain);
        const nameHit = name && existingNames.has(name);

        if (!unmatched && !guidHit && !domainHit && !nameHit) {
            unmatched = company;
        }
        if (!matched && (guidHit || domainHit || nameHit)) {
            matched = {
                company,
                coreCompanyRecord: coreCompanyRecords.find(r =>
                    (guid && normalizeText(r.bitsight_vendor_guid) === guid) ||
                    (domain && normalizeDomain(r.website) === domain) ||
                    (name && normalizeText(r.name) === name)
                ),
            };
        }

        if (unmatched && matched) break;
    }

    return { unmatched, matched };
}

// Navigates fresh from BASE_URL to the Application Configuration screen.
// Returns the gsft_main frame for further interaction.
async function openApplicationConfiguration(page) {
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
        .getByLabel('Application Configuration 4 of')
        .click();

    return page.locator('iframe[name="gsft_main"]').contentFrame();
}

// Navigates from an already-open Application Configuration screen to the
// Scheduled Data Imports record and clicks Execute Now.
async function triggerScheduledImport(page, frame) {
    await page.getByText('All').first().click();
    await page
        .getByRole('listitem')
        .filter({ hasText: 'Bitsight Vendor Risk ManagementEdit ApplicationPortfolioEdit Module Rating and' })
        .getByLabel('Scheduled Data Imports 5 of')
        .click();
    await frame.getByRole('link', { name: 'Open record: Bitsight' }).nth(2).click();
    await frame.getByRole('button', { name: 'Execute Now' }).click();
}

async function snMutate(page, url, method, body) {
    return await page.evaluate(async ({ url, method, body }) => {
        const token = window.g_ck || (window.top && window.top.g_ck) || '';
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-UserToken': token,
        };
        const res = await fetch(url, {
            method,
            credentials: 'include',
            headers,
            body: body ? JSON.stringify(body) : undefined,
        });
        const status = res.status;
        let responseBody = null;
        try {
            responseBody = await res.json();
        } catch {
            responseBody = null;
        }
        return { ok: res.ok, status, body: responseBody };
    }, { url, method, body });
}

// Picks N random core_company records that already have a Bitsight vendor
// GUID (i.e. previously matched/imported records), returning enough fields
// to both delete them and verify their absence/presence afterward.
async function getRandomCoreCompaniesWithGuid(page, count = 5, poolLimit = 50) {
    const url = `/api/now/table/core_company?sysparm_query=x_bisit_vrm_bitsight_vendor_guidISNOTEMPTY` +
        `^ORDERBYDESCsys_updated_on` +
        `&sysparm_fields=sys_id,name,website,x_bisit_vrm_bitsight_vendor_guid` +
        `&sysparm_limit=${poolLimit}`;

    const { ok, status, body } = await snFetch(page, url);
    if (!ok) {
        throw new Error(`Failed to query core_company pool (HTTP ${status}): ${JSON.stringify(body)}`);
    }

    const pool = (body?.result || []).map(row => ({
        sys_id: unwrapField(row.sys_id) || '',
        name: unwrapField(row.name) || '',
        website: unwrapField(row.website) || '',
        guid: unwrapField(row.x_bisit_vrm_bitsight_vendor_guid) || '',
    })).filter(r => r.sys_id && r.guid);

    const shuffled = [...pool].sort(() => 0.5 - Math.random());
    return shuffled.slice(0, Math.min(count, shuffled.length));
}

async function deleteCoreCompanyRecords(page, records, batchSize = 50) {
    for (let i = 0; i < records.length; i += batchSize) {
        const chunk = records.slice(i, i + batchSize);

        const batchRequest = {
            batch_request_id: `delete-core-company-${i}`,
            rest_requests: chunk.map((record, idx) => ({
                id: String(idx),
                method: 'DELETE',
                url: `/api/now/table/core_company/${record.sys_id}`,
                headers: [{ name: 'Accept', value: 'application/json' }],
            })),
        };

        const { ok, status, body } = await snMutate(page, '/api/now/v1/batch', 'POST', batchRequest);
        if (!ok) {
            throw new Error(`Batch delete failed (HTTP ${status}): ${JSON.stringify(body)}`);
        }

        // body.serviced_requests is an array of individual responses - check each one
        for (const res of body.serviced_requests) {
            const record = chunk[Number(res.id)];
            if (res.status_code >= 200 && res.status_code < 300) {
                console.log(`[deleteCoreCompanyRecords] Deleted "${record.name}" (sys_id: ${record.sys_id})`);
            } else {
                console.error(`[deleteCoreCompanyRecords] Failed "${record.name}" (sys_id: ${record.sys_id}): HTTP ${res.status_code}`);
            }
        }
    }
}

// Queries core_company for any of the given Bitsight GUIDs. Returns the
// matching records (empty array if none found).
async function findCoreCompaniesByGuid(page, guids) {
    if (!guids.length) return [];

    const guidQuery = guids.map(g => `x_bisit_vrm_bitsight_vendor_guid=${encodeURIComponent(g)}`).join('^OR');
    const url = `/api/now/table/core_company?sysparm_query=${guidQuery}` +
        `&sysparm_fields=sys_id,name,website,x_bisit_vrm_bitsight_vendor_guid&sysparm_limit=${guids.length}`;

    const { ok, status, body } = await snFetch(page, url);
    if (!ok) {
        throw new Error(`Failed to query core_company by guid (HTTP ${status}): ${JSON.stringify(body)}`);
    }
    return body?.result || [];
}

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
    expect(completeLog, `${IMPORT_JOB_NAME} completion log should be found`).toBeTruthy();

    // 4. Optional wait for post-import transform scripts
    if (options.postWaitMs) {
        console.log(`Waiting ${options.postWaitMs / 1000}s for post-import transform scripts...`);
        await page.waitForTimeout(options.postWaitMs);
    }

    return { baselineTimestamp: baselineSyslogTimestamp, completeLog };
}


export {
    getAllCoreCompaniesWithGuid,
    getCoreCompanyVendorFlags,
    isVendorTrue,
    snFetch,
    toEpoch,
    toSnDateTime,
    getLatestImportCompleteLog,
    waitForNewImportLog,
    getBitsightFieldNames,
    getSingleCompanyRecord,
    unwrapField,
    getBitsightVendorGuids,
    getRandomRecentlyUpdatedCoreCompanies,
    getFailedPortfoliosCount,
    areValuesEqual,
    normalizeDomain,
    normalizeText,
    getCoreCompanyMatchFields,
    classifyBitsightCompanies,
    openApplicationConfiguration,
    triggerScheduledImport,
    snMutate,
    getRandomCoreCompaniesWithGuid,
    deleteCoreCompanyRecords,
    findCoreCompaniesByGuid,
    filterBitsightModules,
    navigateToApplicationConfiguration,
    navigateToScheduledDataImports,
    configureApplicationProperties,
    triggerAndWaitForAlertsImport,
};
