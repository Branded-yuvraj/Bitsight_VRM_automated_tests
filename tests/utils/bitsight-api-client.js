/**
 * Bitsight API Client
 * Independent source of truth for CM and VRM ground truth data.
 * Pure JavaScript - no ServiceNow dependencies.
 */

class BitsightApiClient {
    constructor(options = {}) {
        this.token = options.token ||
            process.env.CMVRM_TOKEN ||
            process.env.BITSIGHT_API_TOKEN ||
            process.env.CM_TOKEN;

        if (!this.token) {
            throw new Error(
                'Bitsight API token not found. Please set CMVRM_TOKEN in your environment.'
            );
        }

        this.ratingsBaseUrl = options.ratingsBaseUrl || 'https://api.bitsighttech.com';
        this.vrmBaseUrl = options.vrmBaseUrl || 'https://service.bitsighttech.com';
        this.maxConcurrency = options.maxConcurrency || 6;
        this.timeoutMs = options.timeoutMs || 30000;

        this._cachedLifecycleStages = null;
    }

    /**
     * Helper to get standard Basic Auth / API token headers for Bitsight
     */
    _getHeaders() {
        const basicAuth = Buffer.from(`${this.token}:`).toString('base64');
        return {
            'Authorization': `Basic ${basicAuth}`,
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Bitsight-Playwright-Validator/1.0',
        };
    }

    /**
     * Direct HTTP fetch for Bitsight APIs without retries
     */
    async _fetch(url, options = {}) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    ...this._getHeaders(),
                    ...(options.headers || {}),
                },
                signal: controller.signal,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorBody = await response.text().catch(() => '');
                throw new Error(`Bitsight API HTTP ${response.status} for ${url}: ${errorBody}`);
            }

            return await response.json();
        } catch (err) {
            clearTimeout(timeoutId);
            throw err;
        }
    }

    /*
    // Kept for future reference if retry mechanism is re-enabled:
    async _fetchWithRetry(url, options = {}) {
        let attempt = 0;
        let lastError = null;

        while (attempt < this.maxRetries) {
            attempt++;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

                const response = await fetch(url, {
                    ...options,
                    headers: {
                        ...this._getHeaders(),
                        ...(options.headers || {}),
                    },
                    signal: controller.signal,
                });

                clearTimeout(timeoutId);

                if (response.status === 429) {
                    const retryAfter = response.headers.get('Retry-After');
                    const waitMs = retryAfter
                        ? parseInt(retryAfter, 10) * 1000
                        : this.baseBackoffMs * Math.pow(2, attempt - 1);

                    console.warn(`[BitsightAPI] HTTP 429 Rate limited on ${url}. Retrying in ${waitMs}ms (attempt ${attempt}/${this.maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                    continue;
                }

                if (response.status >= 500 && attempt < this.maxRetries) {
                    const waitMs = this.baseBackoffMs * Math.pow(2, attempt - 1);
                    console.warn(`[BitsightAPI] HTTP ${response.status} Server error on ${url}. Retrying in ${waitMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                    continue;
                }

                if (!response.ok) {
                    const errorBody = await response.text().catch(() => '');
                    throw new Error(`Bitsight API HTTP ${response.status} for ${url}: ${errorBody}`);
                }

                return await response.json();
            } catch (err) {
                lastError = err;
                if (err.name === 'AbortError') {
                    console.warn(`[BitsightAPI] Request timed out on ${url} (attempt ${attempt}/${this.maxRetries}).`);
                }
                if (attempt < this.maxRetries) {
                    const waitMs = this.baseBackoffMs * Math.pow(2, attempt - 1);
                    await new Promise(resolve => setTimeout(resolve, waitMs));
                }
            }
        }

        throw new Error(`Bitsight API request failed after ${this.maxRetries} attempts on ${url}: ${lastError?.message || lastError}`);
    }
    */

    /**
     * Concurrent task runner with concurrency cap
     */
    async _mapConcurrent(items, limit, fn) {
        const results = new Array(items.length);
        let index = 0;

        const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (index < items.length) {
                const currentIndex = index++;
                results[currentIndex] = await fn(items[currentIndex], currentIndex);
            }
        });

        await Promise.all(workers);
        return results;
    }

    /**
     * API 1: CM Companies (GET https://api.bitsighttech.com/ratings/v1/companies)
     * Concurrent offset pagination:
     * 1. Fetches Page 1 (limit=100, offset=0).
     * 2. Reads `count` from the response to calculate remaining offsets: [100, 200, ..., ceil(count/100)-1 * 100].
     * 3. Fetches all remaining offsets concurrently using _mapConcurrent pool.
     */
    /**
     * API 1: CM Companies (GET https://api.bitsighttech.com/ratings/v1/companies)
     */
    async getCompanies() {
        const limit = 100;
        const initialUrl = `${this.ratingsBaseUrl}/ratings/v1/companies?limit=${limit}&offset=0`;
        const firstPageData = await this._fetch(initialUrl);

        const firstPageResults = Array.isArray(firstPageData)
            ? firstPageData
            : (firstPageData.results || firstPageData.companies || []);

        const allCompanies = firstPageResults.map(comp => this._extractRawCompany(comp));

        const totalCount = firstPageData?.count;
        if (typeof totalCount === 'number' && totalCount > limit) {
            const offsets = [];
            for (let offset = limit; offset < totalCount; offset += limit) {
                offsets.push(offset);
            }

            console.log(`[BitsightAPI] Concurrently fetching ${offsets.length} remaining company pages (total=${totalCount})...`);

            const pageResults = await this._mapConcurrent(offsets, this.maxConcurrency, async (offset) => {
                const url = `${this.ratingsBaseUrl}/ratings/v1/companies?limit=${limit}&offset=${offset}`;
                const data = await this._fetch(url);
                return Array.isArray(data) ? data : (data.results || data.companies || []);
            });

            for (const batch of pageResults) {
                for (const comp of batch) {
                    allCompanies.push(this._extractRawCompany(comp));
                }
            }
        }

        return allCompanies;
    }

    /**
     * Extract raw fields from CM company object without preliminary transformation
     */
    _extractRawCompany(raw) {
        return {
            bitsight_vendor_guid: raw.guid || '',
            guid: raw.guid || '',
            name: raw.name || '',
            primary_domain: raw.primary_domain || '',
            href: raw.href || '',
            display_url: raw.display_url || '',
            rating_date: raw.rating_date || '',
            rating: raw.rating !== undefined ? raw.rating : null,
            subscription_type: raw.subscription_type || '',
            industry: raw.industry || '',
            logo: raw.logo || '',
            is_vrm: false,
            u_is_vrm: false,
            x_bisit_vrm_is_vrm: false,
            raw,
        };
    }

    /**
     * API 2: VRM Vendors (POST https://service.bitsighttech.com/customer-api/vrm/v1/vendors/query)
     */
    async getVendors() {
        const pageSize = 100;
        const url = `${this.vrmBaseUrl}/customer-api/vrm/v1/vendors/query?page=1&page_size=${pageSize}`;
        const firstPageData = await this._fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                page: 1,
                page_size: pageSize,
            }),
        });

        const firstPageResults = Array.isArray(firstPageData)
            ? firstPageData
            : (firstPageData.results || firstPageData.vendors || firstPageData.data || []);

        const allVendors = firstPageResults.map(vendor => this._extractRawVendor(vendor));

        const totalCount = firstPageData?.total ?? firstPageData?.count;
        if (typeof totalCount === 'number' && totalCount > pageSize) {
            const totalPages = Math.ceil(totalCount / pageSize);
            const remainingPages = [];
            for (let p = 2; p <= totalPages; p++) {
                remainingPages.push(p);
            }

            console.log(`[BitsightAPI] Concurrently fetching ${remainingPages.length} remaining vendor pages (total=${totalCount})...`);

            const pageResults = await this._mapConcurrent(remainingPages, this.maxConcurrency, async (page) => {
                const pageUrl = `${this.vrmBaseUrl}/customer-api/vrm/v1/vendors/query?page=${page}&page_size=${pageSize}`;
                const data = await this._fetch(pageUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        page: page,
                        page_size: pageSize,
                    }),
                });
                return Array.isArray(data) ? data : (data.results || data.vendors || data.data || []);
            });

            for (const batch of pageResults) {
                for (const vendor of batch) {
                    allVendors.push(this._extractRawVendor(vendor));
                }
            }
        }

        return allVendors;
    }

    /**
     * Extract raw fields from VRM vendor object without preliminary transformation
     */
    _extractRawVendor(raw) {
        return {
            bitsight_vendor_guid: raw.bs_company_guid || '',
            bs_company_guid: raw.bs_company_guid || '',
            guid: raw.bs_company_guid || raw.vendor_guid || '',
            vendor_guid: raw.vendor_guid || '',
            name: raw.name || raw.company_legal_name || '',
            company_domain: raw.company_domain || '',
            primary_domain: raw.company_domain || '',
            logo: raw.logo || '',
            impact_score: raw.impact_score !== undefined ? raw.impact_score : null,
            risk_score: raw.risk_score !== undefined ? raw.risk_score : null,
            trust_score: raw.trust_score !== undefined ? raw.trust_score : null,
            due_date: raw.due_date || '',
            is_managed: raw.is_managed !== undefined ? Boolean(raw.is_managed) : false,
            life_cycle_stage_guid: raw.life_cycle_stage_guid || '',
            is_vrm: true,
            u_is_vrm: true,
            x_bisit_vrm_is_vrm: true,
            raw,
        };
    }

    /**
     * API 3: VRM Company Rating
     * GET https://service.bitsighttech.com/customer-api/vrm/v1/companies/${bst_company_guid}/rating
     */
    async getVendorRatings(bstCompanyGuid) {
        if (!bstCompanyGuid || typeof bstCompanyGuid !== 'string' || !bstCompanyGuid.trim()) {
            return { rating: null, rating_date: '' };
        }

        const guid = encodeURIComponent(bstCompanyGuid.trim());
        const url = `${this.vrmBaseUrl}/customer-api/vrm/v1/companies/${guid}/rating`;

        try {
            const data = await this._fetch(url).catch(() => null);
            const firstRating = data?.ratings?.[0];
            return {
                rating: firstRating?.rating !== undefined ? Number(firstRating.rating) : null,
                rating_date: firstRating?.rating_date || '',
            };
        } catch {
            return { rating: null, rating_date: '' };
        }
    }

    /**
     * API 4: Lifecycle Stages
     * GET https://service.bitsighttech.com/customer-api/vrm/v1/life-cycle-stages
     */
    async getLifecycleStages() {
        if (this._cachedLifecycleStages) {
            return this._cachedLifecycleStages;
        }

        const url = `${this.vrmBaseUrl}/customer-api/vrm/v1/life-cycle-stages`;
        const data = await this._fetch(url);

        const stageList = Array.isArray(data)
            ? data
            : (data.results || data.life_cycle_stages || data.stages || []);

        const stageMap = {};
        for (const stage of stageList) {
            const id = stage.guid || stage.id || stage.life_cycle_stage_id || stage.life_cycle_stage_guid;
            const name = stage.name || stage.display_name || stage.title || stage.stage_name;
            if (id && name) {
                stageMap[id] = name;
            }
        }

        this._cachedLifecycleStages = stageMap;
        return stageMap;
    }

    /**
     * Merge CM companies and VRM vendors:
     * - VRM vendor records are the base source of truth (is_vrm: true).
     * - CM companies match by cm.bitsight_vendor_guid === vrm.bs_company_guid.
     * - When matched, keep all VRM vendor data and append only subscription_type and industry from CM.
     * - CM-only records are added with is_vrm: false.
     */
    mergeCompanyVendorPortfolios(companies, vendors) {
        const portfolioMap = new Map();

        // 1. Seed with VRM vendors (is_vrm is true for all VRM vendors)
        vendors.forEach(vendor => {
            const key = vendor.bs_company_guid || vendor.bitsight_vendor_guid || vendor.vendor_guid || vendor.guid;
            if (key) {
                portfolioMap.set(key, {
                    ...vendor,
                    guid: key,
                    bitsight_vendor_guid: vendor.bs_company_guid || vendor.bitsight_vendor_guid || key,
                    is_vrm: true,
                    u_is_vrm: true,
                    x_bisit_vrm_is_vrm: true,
                });
            }
        });

        // 2. Overlay CM companies
        companies.forEach(company => {
            const key = company.bitsight_vendor_guid || company.guid;
            if (!key) return;

            const existing = portfolioMap.get(key);

            if (existing) {
                // MATCH FOUND: Keep VRM vendor data as source of truth,
                // and append subscription_type and industry (plus href/display_url if not on VRM)
                // is_vrm remains true
                portfolioMap.set(key, {
                    ...existing,
                    subscription_type: company.subscription_type || existing.subscription_type || '',
                    industry: company.industry || existing.industry || '',
                    href: existing.href || company.href || '',
                    display_url: existing.display_url || company.display_url || '',
                    rating: existing.rating !== undefined && existing.rating !== null ? existing.rating : company.rating,
                    rating_date: existing.rating_date || company.rating_date || '',
                    is_vrm: true,
                    u_is_vrm: true,
                    x_bisit_vrm_is_vrm: true,
                });
            } else {
                // CM-ONLY RECORD: Insert as-is, is_vrm is false
                portfolioMap.set(key, {
                    ...company,
                    guid: key,
                    bitsight_vendor_guid: key,
                    is_vrm: false,
                    u_is_vrm: false,
                    x_bisit_vrm_is_vrm: false,
                });
            }
        });

        const mergedPortfolios = Array.from(portfolioMap.values());

        return {
            portfolioList: mergedPortfolios,
            passed_portfolio: mergedPortfolios.length,
            portfolioMap,
        };
    }

    /**
     * Post-Merge Normalization:
     * Standardizes all fields across merged portfolio records for consistent validation.
     */
    normalizeMergedPortfolio(portfolioList) {
        return portfolioList.map(item => {
            let ratingDate = item.rating_date || item.ratingDate || '';
            if (ratingDate && typeof ratingDate === 'string') {
                ratingDate = ratingDate.split('T')[0].split(' ')[0];
            }

            let dueDate = item.due_date || '';
            if (dueDate && typeof dueDate === 'string') {
                dueDate = dueDate.split('T')[0].split(' ')[0];
            }

            const ratingNum = item.rating !== undefined && item.rating !== null && item.rating !== ''
                ? Number(item.rating)
                : null;

            const isVrm = Boolean(item.is_vrm === true || item.u_is_vrm === true || item.x_bisit_vrm_is_vrm === true);

            return {
                ...item,
                bitsight_vendor_guid: item.bitsight_vendor_guid || item.bs_company_guid || item.guid || '',
                x_bisit_vrm_bitsight_vendor_guid: item.bitsight_vendor_guid || item.bs_company_guid || item.guid || '',
                name: item.name || '',
                x_bisit_vrm_company_name: item.name || '',
                primary_domain: item.primary_domain || item.company_domain || '',
                x_bisit_vrm_primary_domain: item.primary_domain || item.company_domain || '',
                rating: Number.isFinite(ratingNum) ? ratingNum : null,
                x_bisit_vrm_security_rating: Number.isFinite(ratingNum) ? ratingNum : null,
                rating_date: ratingDate,
                x_bisit_vrm_rating_date: ratingDate,
                is_vrm: isVrm,
                u_is_vrm: isVrm,
                x_bisit_vrm_is_vrm: isVrm,
                vendor_guid: item.vendor_guid || '',
                x_bisit_vrm_vendor_guid: item.vendor_guid || '',
                impact_score: item.impact_score !== undefined && item.impact_score !== null ? Number(item.impact_score) : null,
                x_bisit_vrm_impact_score: item.impact_score !== undefined && item.impact_score !== null ? Number(item.impact_score) : null,
                risk_score: item.risk_score !== undefined && item.risk_score !== null ? Number(item.risk_score) : null,
                x_bisit_vrm_risk_score: item.risk_score !== undefined && item.risk_score !== null ? Number(item.risk_score) : null,
                trust_score: item.trust_score !== undefined && item.trust_score !== null ? Number(item.trust_score) : null,
                x_bisit_vrm_trust_score: item.trust_score !== undefined && item.trust_score !== null ? Number(item.trust_score) : null,
                due_date: dueDate,
                x_bisit_vrm_due_date: dueDate,
                is_managed: item.is_managed !== undefined ? Boolean(item.is_managed) : false,
                x_bisit_vrm_is_managed: item.is_managed !== undefined ? Boolean(item.is_managed) : false,
                life_cycle_stage_guid: item.life_cycle_stage_guid || '',
                life_cycle_stage_name: item.life_cycle_stage_name || item.x_bisit_vrm_life_cycle_stage_name || '',
                x_bisit_vrm_life_cycle_stage_name: item.life_cycle_stage_name || item.x_bisit_vrm_life_cycle_stage_name || '',
                subscription_type: item.subscription_type || '',
                industry: item.industry || '',
                href: item.href || '',
                display_url: item.display_url || '',
                logo: item.logo || '',
            };
        });
    }

    /**
     * Fast Ground Truth Assembly
     * Fetches raw CM companies & VRM vendors, merges them with VRM as source of truth,
     * and normalizes the resulting portfolio.
     */
    async getGroundTruth() {
        console.log('[BitsightAPI] Fetching CM companies and VRM vendors...');
        const [companies, vendors] = await Promise.all([
            this.getCompanies(),
            this.getVendors(),
        ]);

        console.log(`[BitsightAPI] Retrieved ${companies.length} CM companies and ${vendors.length} VRM vendors.`);

        const mergeResult = this.mergeCompanyVendorPortfolios(companies, vendors);
        const normalizedList = this.normalizeMergedPortfolio(mergeResult.portfolioList);

        // Build Map for O(1) lookup by bitsight_vendor_guid or vendor_guid
        const normalizedMap = new Map();
        for (const item of normalizedList) {
            if (item.bitsight_vendor_guid) {
                normalizedMap.set(item.bitsight_vendor_guid, item);
            }
            if (item.vendor_guid) {
                normalizedMap.set(item.vendor_guid, item);
            }
        }

        console.log(`[BitsightAPI] Ground truth assembled & normalized: total union = ${normalizedList.length}`);

        return {
            companies,
            vendors,
            portfolioList: normalizedList,
            passed_portfolio: normalizedList.length,
            portfolioMap: normalizedMap,
            lifecycleStages: this._cachedLifecycleStages || {},
        };
    }

    /**
     * Tier 2 Sample Enrichment:
     * Enriches only the sampled records with VRM ratings and resolved lifecycle stage names.
     * For each record:
     * - Ratings: Only fetched if bst_entity_guid is present and non-empty; skipped otherwise.
     * - Lifecycle Stage: Only fetched/resolved if life_cycle_stage_id is present and non-empty; skipped otherwise.
     */
    async enrichSample(sampledEntries) {
        // 1. Ratings: Filter only records where required bst_entity_guid is present
        const vrmItemsToRate = sampledEntries.filter(
            entry => (entry.recordType === 'vrm_only' || entry.recordType === 'merged') &&
                     entry.bst_entity_guid &&
                     String(entry.bst_entity_guid).trim() !== ''
        );

        if (vrmItemsToRate.length > 0) {
            console.log(`[BitsightAPI] Fetching VRM ratings for ${vrmItemsToRate.length} sampled entries with valid bst_entity_guid...`);

            const ratings = await this._mapConcurrent(vrmItemsToRate, this.maxConcurrency, async (item) => {
                if (item.bst_entity_guid && String(item.bst_entity_guid).trim() !== '') {
                    return await this.getVendorRatings(String(item.bst_entity_guid).trim());
                }
                return { rating: null, ratingDate: '' };
            });

            for (let i = 0; i < vrmItemsToRate.length; i++) {
                const item = vrmItemsToRate[i];
                const ratingInfo = ratings[i];
                if (ratingInfo && ratingInfo.rating !== null) {
                    item.u_rating = ratingInfo.rating;
                    const rDate = ratingInfo.rating_date || ratingInfo.ratingDate;
                    if (rDate) {
                        item.u_rating_date = rDate;
                    }
                }
            }
        } else {
            console.log('[BitsightAPI] Skipping VRM ratings fetch: No sampled entries have a valid bst_entity_guid.');
        }

        // 2. Lifecycle Stage: Only resolve if required life_cycle_stage_id GUID is present
        const itemsWithStageGuid = sampledEntries.filter(
            entry => entry.life_cycle_stage_id && String(entry.life_cycle_stage_id).trim() !== ''
        );

        if (itemsWithStageGuid.length > 0) {
            console.log(`[BitsightAPI] Resolving lifecycle stage for ${itemsWithStageGuid.length} sampled entries with stage GUID...`);
            const stageMap = this._cachedLifecycleStages || await this.getLifecycleStages();
            for (const item of sampledEntries) {
                if (item.life_cycle_stage_id && String(item.life_cycle_stage_id).trim() !== '') {
                    const stageId = String(item.life_cycle_stage_id).trim();
                    item.u_vrm_life_cycle_stage = stageMap[stageId] || stageId;
                } else {
                    item.u_vrm_life_cycle_stage = null;
                }
            }
        } else {
            console.log('[BitsightAPI] Skipping lifecycle stages fetch: No sampled entries have a life_cycle_stage_id.');
            for (const item of sampledEntries) {
                item.u_vrm_life_cycle_stage = null;
            }
        }

        return sampledEntries;
    }
}

module.exports = {
    BitsightApiClient,
};
