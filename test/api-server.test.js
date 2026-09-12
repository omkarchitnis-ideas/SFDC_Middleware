const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('path');
const fs = require('fs');

// Use an isolated test database for app db
const TEST_DB_FILE = path.join(__dirname, 'test_app.db');
process.env.APP_DB_FILE = TEST_DB_FILE;
process.env.API_KEY = 'test_master_key_123';

const sfClient = require('../sf-client');
const db = require('../db');

// Mock Salesforce Client functions
const mockRecords = [
  {
    attributes: { type: 'Task' },
    Task_Number__c: 'TSK-001',
    Subject: 'Test Salesforce Task',
    Status: 'In Progress',
    Owner: {
      attributes: { type: 'Name' },
      Name: 'Omkar Chitnis'
    },
    What: {
      attributes: { type: 'Case' },
      CaseNumber: 'CS-1001',
      Account_Chain_Code__c: 'SCAN'
    }
  }
];

sfClient.getOrgAuth = () => ({
  accessToken: 'mock_token_123',
  instanceUrl: 'https://mock.salesforce.com'
});

sfClient.runSoql = async (token, url, soql, opts) => {
  return {
    records: mockRecords,
    total: mockRecords.length,
    truncated: false
  };
};

sfClient.streamSoql = async (token, url, soql, onBatch, opts) => {
  await onBatch(mockRecords, true);
  return { total: mockRecords.length, truncated: false };
};

const app = require('../api-server');

let server;
let baseUrl;
const TEST_KEY = 'test_admin_key_abc123';

function makeRequest(method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(baseUrl + urlPath);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          bodyText: buffer.toString('utf8'),
          buffer
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

describe('api-server integration tests', () => {

  before(async () => {
    // Insert test admin key into app.db
    db.prepare('INSERT OR REPLACE INTO api_keys (key_value, user_name, role, is_active) VALUES (?, ?, ?, 1)')
      .run(TEST_KEY, 'Test Admin', 'admin');

    // Start express app on a random available port
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    if (server) server.close();
    try {
      if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
      if (fs.existsSync(TEST_DB_FILE + '-wal')) fs.unlinkSync(TEST_DB_FILE + '-wal');
      if (fs.existsSync(TEST_DB_FILE + '-shm')) fs.unlinkSync(TEST_DB_FILE + '-shm');
    } catch (e) {}
  });

  describe('POST /query', () => {
    test('returns 401 when x-api-key header is missing', async () => {
      const res = await makeRequest('POST', '/query', {}, { soql: 'SELECT Id FROM Task' });
      assert.strictEqual(res.status, 401);
      const json = JSON.parse(res.bodyText);
      assert.strictEqual(json.error, 'Missing x-api-key header.');
    });

    test('returns 401 when x-api-key header is invalid', async () => {
      const res = await makeRequest('POST', '/query', { 'x-api-key': 'invalid_key' }, { soql: 'SELECT Id FROM Task' });
      assert.strictEqual(res.status, 401);
      const json = JSON.parse(res.bodyText);
      assert.strictEqual(json.error, 'Invalid or deactivated API key.');
    });

    test('returns 400 when DML query is passed', async () => {
      const res = await makeRequest('POST', '/query', { 'x-api-key': TEST_KEY }, { soql: 'DELETE FROM Task' });
      assert.strictEqual(res.status, 400);
      const json = JSON.parse(res.bodyText);
      assert.strictEqual(json.error, 'Only single SELECT statements are allowed.');
    });

    test('returns 200 with flattened records on valid SELECT query', async () => {
      const res = await makeRequest('POST', '/query', { 'x-api-key': TEST_KEY }, { soql: 'SELECT Id, Subject FROM Task' });
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.bodyText);
      assert.strictEqual(json.count, 1);
      assert.strictEqual(json.records.length, 1);
      assert.strictEqual(json.records[0].Task_Number__c, 'TSK-001');
      assert.strictEqual(json.records[0]['Owner.Name'], 'Omkar Chitnis');
      assert.strictEqual(json.records[0]['What.Account_Chain_Code__c'], 'SCAN');

      // Verify audit log entry was created in database
      const log = db.prepare('SELECT * FROM audit_logs WHERE key_value = ? ORDER BY id DESC LIMIT 1').get(TEST_KEY);
      assert.ok(log);
      assert.strictEqual(log.endpoint, '/query');
      assert.strictEqual(log.status_code, 200);
    });
  });

  describe('POST /export', () => {
    test('streams CSV format successfully', async () => {
      const res = await makeRequest('POST', '/export', { 'x-api-key': TEST_KEY }, { soql: 'SELECT Id, Subject FROM Task', format: 'csv' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['content-type'].includes('text/csv'));
      assert.ok(res.bodyText.includes('Task_Number__c'));
      assert.ok(res.bodyText.includes('"TSK-001"'));
      assert.ok(res.bodyText.includes('"Omkar Chitnis"'));
    });

    test('streams XLSX format successfully', async () => {
      const res = await makeRequest('POST', '/export', { 'x-api-key': TEST_KEY }, { soql: 'SELECT Id, Subject FROM Task', format: 'xlsx' });
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers['content-type'].includes('spreadsheetml'));
      assert.ok(res.buffer.length > 0);
    });

    test('returns 400 for invalid format', async () => {
      const res = await makeRequest('POST', '/export', { 'x-api-key': TEST_KEY }, { soql: 'SELECT Id FROM Task', format: 'xml' });
      assert.strictEqual(res.status, 400);
      const json = JSON.parse(res.bodyText);
      assert.strictEqual(json.error, 'format must be "csv" or "xlsx".');
    });
  });

  describe('GET /admin/sync/status', () => {
    test('returns sync status info for admin key', async () => {
      const res = await makeRequest('GET', '/admin/sync/status', { 'x-api-key': TEST_KEY });
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.bodyText);
      assert.ok('exists' in json);
    });
  });

  describe('Token Service Endpoints', () => {
    test('GET /api/sfdc/token vends valid token object', async () => {
      const res = await makeRequest('GET', '/api/sfdc/token');
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.bodyText);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.accessToken, 'mock_token_123');
      assert.strictEqual(json.instanceUrl, 'https://mock.salesforce.com');
      assert.ok('expiresInSeconds' in json);
    });

    test('GET /auth/token alias vends identical token object', async () => {
      const res = await makeRequest('GET', '/auth/token');
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.bodyText);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.accessToken, 'mock_token_123');
    });

    test('POST /api/sfdc/token/refresh triggers token refresh', async () => {
      const res = await makeRequest('POST', '/api/sfdc/token/refresh');
      assert.strictEqual(res.status, 200);
      const json = JSON.parse(res.bodyText);
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.refreshed, true);
      assert.strictEqual(json.accessToken, 'mock_token_123');
    });
  });

});
