const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ORG_ALIAS = process.env.ORG_ALIAS || 'OmkarSFDC';
const SF_INSTANCE_URL = process.env.SF_INSTANCE_URL || 'https://ideas-sas.my.salesforce.com';

let cachedAuth = null;
let tokenExpiration = 0;

/**
 * Checks if an error is transient and eligible for retry.
 */
function isTransientError(err) {
  if (!err) return false;
  const status = err.statusCode || err.status;
  if (status && (status === 429 || (status >= 500 && status < 600))) {
    return true;
  }
  const code = err.code || '';
  const transientCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED', 'EPIPE', 'EHOSTUNREACH'];
  if (transientCodes.includes(code)) {
    return true;
  }
  const msg = (err.message || '').toLowerCase();
  if (
    msg.includes('socket hang up') ||
    msg.includes('timeout') ||
    msg.includes('rate limit') ||
    msg.includes('ecouldnotconnect') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('500')
  ) {
    return true;
  }
  return false;
}

/**
 * Helper to retry an async function with exponential backoff on transient failures.
 */
async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries ?? parseInt(process.env.MAX_RETRIES || '3', 10);
  const initialDelay = options.initialDelay ?? parseInt(process.env.RETRY_INITIAL_DELAY_MS || '1000', 10);
  const backoffFactor = options.backoffFactor ?? 2;

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const isTransient = isTransientError(err);
      if (attempt > maxRetries || !isTransient) {
        throw err;
      }
      const delay = initialDelay * Math.pow(backoffFactor, attempt - 1);
      console.warn(`[Retry ${attempt}/${maxRetries}] Transient failure ("${err.message}"). Retrying in ${delay}ms...`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
}

/**
 * Direct Salesforce SOAP Login (Partner API).
 * Used as a zero-dependency, automated headless login/fallback whenever CLI session expires.
 */
function directSoapLoginSync(instanceUrl, username, password) {
  const { execFileSync } = require('child_process');
  const helper = `
    const https = require('https');
    const u = new URL(${JSON.stringify(instanceUrl)});
    const xml = '<?xml version="1.0" encoding="utf-8" ?><env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><n1:login xmlns:n1="urn:partner.soap.sforce.com"><n1:username>' + ${JSON.stringify(username)} + '</n1:username><n1:password>' + ${JSON.stringify(password)} + '</n1:password></n1:login></env:Body></env:Envelope>';
    const req = https.request({
      hostname: u.hostname,
      path: '/services/Soap/u/58.0',
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=UTF-8',
        'SOAPAction': 'login',
        'Content-Length': Buffer.byteLength(xml)
      },
      timeout: 15000
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        const sid = (data.match(/<sessionId>(.*?)<\\/sessionId>/) || [])[1];
        const sUrl = (data.match(/<serverUrl>(.*?)<\\/serverUrl>/) || [])[1];
        if (res.statusCode === 200 && sid) {
          let resolved = ${JSON.stringify(instanceUrl)};
          if (sUrl) {
            try {
              const su = new URL(sUrl);
              resolved = su.protocol + '//' + su.host;
            } catch (e) {}
          }
          process.stdout.write(JSON.stringify({ accessToken: sid, instanceUrl: resolved }));
        } else {
          process.exit(1);
        }
      });
    });
    req.on('error', () => process.exit(1));
    req.on('timeout', () => { req.destroy(); process.exit(1); });
    req.write(xml);
    req.end();
  `;
  const raw = execFileSync(process.execPath, ['-e', helper], { encoding: 'utf8', timeout: 20000 });
  return JSON.parse(raw.trim());
}

function invalidateTokenCache() {
  cachedAuth = null;
  tokenExpiration = 0;
  const tokenCacheFile = path.join(__dirname, '.sf_token_cache.json');
  try {
    if (fs.existsSync(tokenCacheFile)) fs.unlinkSync(tokenCacheFile);
  } catch (e) {}
}

/**
 * Fetches token from centralized SFDC Middleware Token Service synchronously.
 */
function fetchRemoteTokenSync(serviceUrl, apiKey) {
  const { execFileSync } = require('child_process');
  const helper = `
    const http = require('http');
    const https = require('https');
    const u = new URL(${JSON.stringify(serviceUrl)});
    const client = u.protocol === 'https:' ? https : http;
    const headers = {};
    const key = ${JSON.stringify(apiKey || '')};
    if (key) {
      headers['x-api-key'] = key;
    }
    const req = client.request(u, { headers, timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        if (res.statusCode === 200) {
          process.stdout.write(data);
        } else {
          process.exit(1);
        }
      });
    });
    req.on('error', () => process.exit(1));
    req.on('timeout', () => { req.destroy(); process.exit(1); });
    req.end();
  `;
  const raw = execFileSync(process.execPath, ['-e', helper], { encoding: 'utf8', timeout: 8000 });
  return JSON.parse(raw.trim());
}

function getOrgAuth(forceRefresh = false) {
  if (!forceRefresh && cachedAuth && Date.now() < tokenExpiration) {
    return cachedAuth;
  }

  const tokenCacheFile = path.join(__dirname, '.sf_token_cache.json');
  if (!forceRefresh && fs.existsSync(tokenCacheFile)) {
    try {
      const diskCache = JSON.parse(fs.readFileSync(tokenCacheFile, 'utf8'));
      if (diskCache.accessToken && diskCache.tokenExpiration && Date.now() < diskCache.tokenExpiration) {
        cachedAuth = diskCache;
        tokenExpiration = diskCache.tokenExpiration;
        return cachedAuth;
      }
    } catch (e) {}
  }

  if (forceRefresh) {
    invalidateTokenCache();
  }

  console.log(forceRefresh ? 'Force refreshing Salesforce auth token...' : 'Fetching new Salesforce auth token...');

  // 1. Try centralized SFDC Middleware Token Service if configured
  const tokenServiceUrl = process.env.SFDC_TOKEN_SERVICE_URL;
  if (tokenServiceUrl) {
    try {
      console.log(`Attempting to fetch shared token from SFDC Token Service at ${tokenServiceUrl}...`);
      const remoteAuth = fetchRemoteTokenSync(tokenServiceUrl, process.env.API_KEY);
      if (remoteAuth && remoteAuth.accessToken) {
        cachedAuth = {
          accessToken: remoteAuth.accessToken,
          instanceUrl: remoteAuth.instanceUrl || (process.env.SFDC_INSTANCE_URL || SF_INSTANCE_URL),
          tokenExpiration: remoteAuth.tokenExpiration || (Date.now() + 2 * 60 * 60 * 1000),
          authMethod: 'token_service',
          issuedAt: remoteAuth.issuedAt || Date.now()
        };
        tokenExpiration = cachedAuth.tokenExpiration;
        try { fs.writeFileSync(tokenCacheFile, JSON.stringify(cachedAuth, null, 2)); } catch (e) {}
        console.log('✅ Acquired shared token from SFDC Middleware Token Service!');
        return cachedAuth;
      }
    } catch (tsErr) {
      console.warn('Central SFDC Token Service query failed, falling back to direct login:', tsErr.message);
    }
  }

  // 2. Try Direct Salesforce API login (SOAP) if credentials are provided in env
  const sfdcUser = process.env.SFDC_USERNAME;
  const sfdcPass = process.env.SFDC_PASSWORD;
  const sfdcInstance = process.env.SFDC_INSTANCE_URL || SF_INSTANCE_URL;

  if (sfdcUser && sfdcPass) {
    try {
      console.log(`Attempting Direct Salesforce API login for ${sfdcUser}...`);
      const directAuth = directSoapLoginSync(sfdcInstance, sfdcUser, sfdcPass);
      if (directAuth && directAuth.accessToken) {
        cachedAuth = {
          accessToken: directAuth.accessToken,
          instanceUrl: directAuth.instanceUrl || sfdcInstance,
          tokenExpiration: Date.now() + (2 * 60 * 60 * 1000),
          authMethod: 'soap_direct',
          issuedAt: Date.now()
        };
        tokenExpiration = cachedAuth.tokenExpiration;
        try { fs.writeFileSync(tokenCacheFile, JSON.stringify(cachedAuth, null, 2)); } catch (e) {}
        console.log('✅ Direct Salesforce API authentication successful!');
        return cachedAuth;
      }
    } catch (soapErr) {
      console.warn('Direct Salesforce API login failed, falling back to sf CLI:', soapErr.message);
    }
  }

  // 2. Try Salesforce CLI org display
  try {
    if (process.platform !== 'win32') {
      try {
        execSync('chmod 600 ~/.sfdx/* ~/.sf/* 2>/dev/null || true', { shell: true, stdio: 'ignore' });
      } catch (e) {}
    }

    const env = { ...process.env, SF_TEMP_SHOW_SECRETS: 'true' };
    const sfCmd = process.platform === 'win32' ? 'sf.cmd' : 'sf';
    const raw = execSync(`${sfCmd} org display --target-org ${ORG_ALIAS} --json`, {
      encoding: 'utf8',
      shell: process.platform === 'win32' ? 'cmd.exe' : true,
      env
    });

    const jsonStart = raw.indexOf('{');
    const jsonEnd = raw.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1) {
      throw new Error('No valid JSON object found in sf org display output');
    }
    const parsed = JSON.parse(raw.slice(jsonStart, jsonEnd + 1));
    if (!parsed || !parsed.result || !parsed.result.accessToken || parsed.result.accessToken.includes('REDACTED')) {
      throw new Error('Token missing or redacted');
    }

    cachedAuth = {
      accessToken: parsed.result.accessToken,
      instanceUrl: parsed.result.instanceUrl || SF_INSTANCE_URL,
      tokenExpiration: Date.now() + (2 * 60 * 60 * 1000),
      authMethod: 'sfdc_cli',
      issuedAt: Date.now()
    };
    tokenExpiration = cachedAuth.tokenExpiration;
    try { fs.writeFileSync(tokenCacheFile, JSON.stringify(cachedAuth, null, 2)); } catch (e) {}

    return cachedAuth;

  } catch (err) {
    // 3. Fallback: Check if static SFDC_ACCESS_TOKEN is provided in environment
    if (process.env.SFDC_ACCESS_TOKEN) {
      console.log('Using static SFDC_ACCESS_TOKEN from environment.');
      cachedAuth = {
        accessToken: process.env.SFDC_ACCESS_TOKEN,
        instanceUrl: sfdcInstance,
        tokenExpiration: Date.now() + (60 * 60 * 1000),
        authMethod: 'static_env',
        issuedAt: Date.now()
      };
      tokenExpiration = cachedAuth.tokenExpiration;
      try { fs.writeFileSync(tokenCacheFile, JSON.stringify(cachedAuth, null, 2)); } catch (e) {}
      return cachedAuth;
    }

    console.log('Token expired or auth failed. Spawning auto-login browser...');

    try {
      const { spawn } = require('child_process');
      const fs = require('fs');
      const path = require('path');

      const batPath = path.join(__dirname, 'launch_chrome.bat');
      // The start "" ensures Windows spawns a brand new detached Chrome window
      fs.writeFileSync(batPath, '@echo off\nstart "" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --profile-directory="Default" --new-window %*');

      const env = { ...process.env, BROWSER: batPath };

      const cmd = `sf org login web --alias ${ORG_ALIAS} --instance-url ${SF_INSTANCE_URL}`;

      spawn(cmd, {
        env,
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsHide: true
      }).unref();
    } catch (spawnErr) {
      console.log('Browser trigger failed silently.');
    }

    // STRICT RETURN: This is the exact string the UI will show.
    throw new Error('API Error: Token expired. Auto-login initiated in browser. Please wait a moment for the window to close, then run your query again.');
  }
}

function getNestedValue(obj, p) {
  if (!p || !obj) return '';
  return p.split('.').reduce((acc, part) => acc && acc[part], obj) || '';
}

function invalidateAuthCache() {
  cachedAuth = null;
  tokenExpiration = 0;
}

function fetchQueryBatchSingle(accessToken, instanceUrl, uriPath) {
  return new Promise((resolve, reject) => {
    let hostname;
    try {
      hostname = new URL(instanceUrl).hostname;
    } catch (e) {
      hostname = instanceUrl;
    }

    const req = https.request(
      {
        hostname,
        path: uriPath,
        method: 'GET',
        headers: { Authorization: `Bearer ${accessToken}` }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            invalidateAuthCache();
            const err = new Error(`Salesforce API returned status ${res.statusCode}: ${data}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`Salesforce API returned status ${res.statusCode}: ${data}`);
            err.statusCode = res.statusCode;
            return reject(err);
          }
          try {
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed) && parsed[0] && parsed[0].errorCode) {
              if (parsed[0].errorCode === 'INVALID_AUTH_HEADER' || parsed[0].errorCode === 'INVALID_SESSION_ID') {
                invalidateAuthCache();
              }
              const err = new Error(parsed[0].message || 'Salesforce error');
              err.errorCode = parsed[0].errorCode;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Failed to parse Salesforce response JSON: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function fetchQueryBatch(accessToken, instanceUrl, uriPath, opts = {}) {
  return withRetry(() => fetchQueryBatchSingle(accessToken, instanceUrl, uriPath), opts);
}

/**
 * Pages through a SOQL query via nextRecordsUrl, invoking onBatch(records, isLast)
 * as each ~2000-row Salesforce page arrives, instead of accumulating everything
 * in memory first. This is what lets /export write a file incrementally for
 * large result sets, and lets /query stop early once it hits a preview cap.
 *
 * opts.maxRecords: if set, stops paging once this many records have been
 * delivered to onBatch (the final batch is trimmed to land exactly on the cap).
 * Returns { total, truncated }.
 */
async function streamSoql(accessToken, instanceUrl, soql, onBatch, opts = {}) {
  const { maxRecords } = opts;
  let total = 0;
  let uriPath = `/services/data/v60.0/query?q=${encodeURIComponent(soql.trim())}`;

  while (uriPath) {
    const data = await fetchQueryBatch(accessToken, instanceUrl, uriPath, opts);
    let batch = data.records || [];

    if (maxRecords && total + batch.length > maxRecords) {
      batch = batch.slice(0, maxRecords - total);
      total += batch.length;
      if (batch.length) await onBatch(batch, true);
      return { total, truncated: true };
    }

    total += batch.length;
    if (batch.length) await onBatch(batch, !data.nextRecordsUrl);
    uriPath = data.nextRecordsUrl || null;
  }
  return { total, truncated: false };
}

/**
 * Convenience wrapper for callers that just want the full record array
 * (fine for the cron sync, which already filters down to a known-bounded set).
 */
async function runSoql(accessToken, instanceUrl, soql, opts) {
  const records = [];
  const { total, truncated } = await streamSoql(
    accessToken, instanceUrl, soql,
    (batch) => { records.push(...batch); },
    opts
  );
  return { records, total, truncated };
}

/**
 * Only single SELECT statements are allowed through the API/UI — no DML,
 * no DDL. Shared so /query, /export, and (a mirrored copy of) the UI all
 * agree on the rule.
 */
function isSelectOnly(soql) {
  const cleaned = String(soql || '').trim().replace(/\s+/g, ' ');

  // 1. The query must still start with SELECT
  if (!/^SELECT\s/i.test(cleaned)) return false;

  // 2. Temporarily remove all string literals ('...') so the regex doesn't scan inside them
  const stringlessQuery = cleaned.replace(/'[^']*'/g, '');

  // 3. Now check the safe string for blocked DML keywords
  const blocked = /\b(INSERT|UPDATE|DELETE|UPSERT|MERGE|UNDELETE|CREATE|DROP|ALTER)\b/i;
  return !blocked.test(stringlessQuery);
}

/**
 * Salesforce doesn't return relationship fields as flat "Owner.Name" keys —
 * it nests them: { "Owner": { "attributes": {...}, "Name": "..." } }. Left
 * as-is, that nested object gets JSON.stringify'd into tables/exports,
 * dumping "attributes"/"url" junk into what should be a clean data column.
 * This recursively flattens single-relationship lookups into dotted keys
 * (Owner.Name, What.Account_Chain_Code__c, ...) and drops "attributes".
 *
 * Child-relationship subqueries (which come back as { records: [...] })
 * aren't flattened row-by-row — they're collapsed to a short summary,
 * since expanding them would mean a variable number of columns/rows per
 * parent record, which doesn't fit a flat CSV/XLSX row.
 */
function flattenRecord(record, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (key === 'attributes') continue;
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (Array.isArray(value.records)) {
        out[fullKey] = `[${value.records.length} related record${value.records.length === 1 ? '' : 's'}]`;
      } else {
        Object.assign(out, flattenRecord(value, fullKey));
      }
    } else if (Array.isArray(value)) {
      out[fullKey] = JSON.stringify(value);
    } else {
      out[fullKey] = value;
    }
  }
  return out;
}

/**
 * Executes a single DML operation (create, update, delete) via the sf CLI.
 */
async function executeSfDmlSingle(action, sobject, recordId, fieldValues = {}) {
  const { accessToken, instanceUrl } = getOrgAuth();
  
  if (action === 'create') {
    const valuesStr = Object.entries(fieldValues)
      .map(([k, v]) => `${k}='${String(v).replace(/'/g, "\\'")}'`)
      .join(' ');
    const cmd = `sf data create record --target-org ${ORG_ALIAS} --sobject ${sobject} --values "${valuesStr}" --json`;
    const raw = execSync(cmd, { encoding: 'utf8', windowsHide: true, shell: true });
    return JSON.parse(raw);
  } else if (action === 'update') {
    const valuesStr = Object.entries(fieldValues)
      .map(([k, v]) => `${k}='${String(v).replace(/'/g, "\\'")}'`)
      .join(' ');
    const cmd = `sf data update record --target-org ${ORG_ALIAS} --sobject ${sobject} --record-id ${recordId} --values "${valuesStr}" --json`;
    const raw = execSync(cmd, { encoding: 'utf8', windowsHide: true, shell: true });
    return JSON.parse(raw);
  } else if (action === 'delete') {
    const cmd = `sf data delete record --target-org ${ORG_ALIAS} --sobject ${sobject} --record-id ${recordId} --no-prompt --json`;
    const raw = execSync(cmd, { encoding: 'utf8', windowsHide: true, shell: true });
    return JSON.parse(raw);
  } else {
    throw new Error(`Unsupported action: ${action}`);
  }
}

/**
 * Executes chunked bulk DML operations (batches of 200) via Salesforce Composite REST endpoints
 * using the sf CLI session token.
 */
async function executeSfDmlBulk(action, sobject, records = [], options = {}) {
  const { accessToken, instanceUrl } = getOrgAuth();
  const chunkSize = options.chunkSize || 200;
  const allOrNone = options.allOrNone ?? false;

  const chunks = [];
  for (let i = 0; i < records.length; i += chunkSize) {
    chunks.push(records.slice(i, i + chunkSize));
  }

  const chunkResults = [];

  for (const chunk of chunks) {
    let method = 'PATCH';
    let path = '/services/data/v60.0/composite/sobjects';
    let body = null;

    if (action === 'create') {
      method = 'POST';
      body = {
        allOrNone,
        records: chunk.map(r => ({
          attributes: { type: sobject },
          ...r
        }))
      };
    } else if (action === 'update') {
      method = 'PATCH';
      body = {
        allOrNone,
        records: chunk.map(r => ({
          attributes: { type: sobject },
          ...r
        }))
      };
    } else if (action === 'delete') {
      method = 'DELETE';
      const idsParam = chunk.map(r => (typeof r === 'string' ? r : r.Id)).join(',');
      path += `?ids=${encodeURIComponent(idsParam)}&allOrNone=${allOrNone}`;
    }

    const payloadStr = body ? JSON.stringify(body) : '';
    const resBatch = await withRetry(async () => {
      return new Promise((resolve, reject) => {
        const url = new URL(`${instanceUrl}${path}`);
        const reqOpts = {
          hostname: url.hostname,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: method,
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...(body ? { 'Content-Length': Buffer.byteLength(payloadStr) } : {})
          }
        };

        const req = https.request(reqOpts, (res) => {
          let data = '';
          res.on('data', (c) => { data += c; });
          res.on('end', () => {
            try {
              const parsed = data ? JSON.parse(data) : {};
              if (res.statusCode >= 400) {
                reject({ statusCode: res.statusCode, message: parsed.error || JSON.stringify(parsed) });
              } else {
                resolve(parsed);
              }
            } catch (e) {
              resolve(data);
            }
          });
        });

        req.on('error', reject);
        if (body) req.write(payloadStr);
        req.end();
      });
    });

    chunkResults.push({ chunkSize: chunk.length, results: resBatch });
  }

  return {
    totalRecordsProcessed: records.length,
    chunkCount: chunks.length,
    chunks: chunkResults
  };
}

let cachedOwnerMap = null;
let ownerMapExpires = 0;

/**
 * Returns a mapping of lowercased User and Queue names (and usernames/developer names) to Salesforce IDs.
 */
async function getSfOwnerMap(forceRefresh = false) {
  if (!forceRefresh && cachedOwnerMap && Date.now() < ownerMapExpires) {
    return cachedOwnerMap;
  }
  const { accessToken, instanceUrl } = getOrgAuth();
  const users = await runSoql(accessToken, instanceUrl, "SELECT Id, Name, Email, Username FROM User WHERE IsActive = TRUE");
  let groups = { records: [] };
  try {
    groups = await runSoql(accessToken, instanceUrl, "SELECT Id, Name, DeveloperName FROM Group WHERE Type = 'Queue'");
  } catch (e) {
    console.warn('Queue lookup warning:', e.message);
  }

  const map = {};
  for (const u of (users.records || [])) {
    if (u.Name) map[u.Name.toLowerCase().trim()] = u.Id;
    if (u.Email) map[u.Email.toLowerCase().trim()] = u.Id;
    if (u.Username) map[u.Username.toLowerCase().trim()] = u.Id;
  }
  for (const g of (groups.records || [])) {
    if (g.Name) map[g.Name.toLowerCase().trim()] = g.Id;
    if (g.DeveloperName) map[g.DeveloperName.toLowerCase().trim()] = g.Id;
  }

  cachedOwnerMap = map;
  ownerMapExpires = Date.now() + (15 * 60 * 1000); // 15 minutes TTL
  return map;
}

/**
 * Resolves a human name or queue name to a Salesforce 18-character User/Group ID.
 */
async function getSfOwnerIdByName(name) {
  if (!name) return null;
  const map = await getSfOwnerMap();
  return map[name.toLowerCase().trim()] || null;
}

/**
 * Updates task owners directly in Salesforce via Composite REST API in real time.
 * @param {Array<{ id: string, ownerId: string }>} taskUpdates 
 */
async function reassignTasksInSalesforce(taskUpdates) {
  if (!Array.isArray(taskUpdates) || taskUpdates.length === 0) {
    return { success: true, count: 0, results: [] };
  }

  const records = taskUpdates.map(t => {
    const rec = {
      id: t.id || t.Id,
      OwnerId: t.ownerId || t.OwnerId
    };
    if (t.Description !== undefined || t.description !== undefined) {
      rec.Description = t.Description !== undefined ? t.Description : t.description;
    }
    return rec;
  });

  const res = await executeSfDmlBulk('update', 'Task', records, { allOrNone: false });
  return res;
}

const describeCache = {};

/**
 * Dynamically retrieves all queryable field names for an sObject from Salesforce REST API.
 * Automatically filters out compound fields (address, location), base64 blobs, and deprecated/hidden fields.
 * Caches results in memory to eliminate redundant API calls.
 */
async function describeSObject(accessToken, instanceUrl, sobjectName, forceRefresh = false) {
  if (!forceRefresh && describeCache[sobjectName]) {
    return describeCache[sobjectName];
  }

  const describeUri = `/services/data/v60.0/sobjects/${sobjectName}/describe`;
  const meta = await fetchQueryBatch(accessToken, instanceUrl, describeUri);
  if (!meta || !Array.isArray(meta.fields)) {
    throw new Error(`Failed to describe sObject ${sobjectName}: No fields returned.`);
  }

  const queryableFields = meta.fields
    .filter(f => {
      if (f.type === 'address' || f.type === 'location' || f.type === 'base64') return false;
      if (f.deprecatedAndHidden) return false;
      if (sobjectName === 'Task' && f.name.startsWith('Recurrence')) return false;
      return true;
    })
    .map(f => f.name);

  describeCache[sobjectName] = queryableFields;
  return queryableFields;
}

module.exports = {
  getOrgAuth,
  invalidateTokenCache,
  getNestedValue,
  fetchQueryBatch,
  streamSoql,
  runSoql,
  isSelectOnly,
  flattenRecord,
  withRetry,
  isTransientError,
  executeSfDmlSingle,
  executeSfDmlBulk,
  getSfOwnerMap,
  getSfOwnerIdByName,
  reassignTasksInSalesforce,
  describeSObject
};