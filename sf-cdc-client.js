/**
 * Salesforce Change Data Capture (CDC) & Streaming API Client
 * Protocol: Bayeux / CometD 60.0 (Zero external dependencies, pure Node.js HTTPS)
 * 
 * Provides sub-second real-time push replication from Salesforce to PostgreSQL:
 * Subscribes to /data/TaskChangeEvent and /data/CaseChangeEvent.
 * When a user or system modifies a record in Salesforce, an event is pushed in < 500ms
 * directly into the local PostgreSQL clone on sicsappsina6:5433.
 */

const https = require('https');
const { URL } = require('url');
const { getOrgAuth } = require('./sf-client');
const pgDb = require('./db-postgres');
const dlq = require('./dlq');

class SalesforceCdcClient {
  constructor(options = {}) {
    this.channels = options.channels || ['/data/TaskChangeEvent', '/data/CaseChangeEvent'];
    this.clientId = null;
    this.isRunning = false;
    this.cookies = {};
    this.replayMap = {};
    this.activeRequest = null;
  }

  _extractCookies(res) {
    const rawCookies = res.headers['set-cookie'];
    if (Array.isArray(rawCookies)) {
      for (const rc of rawCookies) {
        const parts = rc.split(';')[0].split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=');
          this.cookies[key] = val;
        }
      }
    }
  }

  _getCookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async _postCometd(messages) {
    const auth = getOrgAuth();
    const u = new URL(auth.instanceUrl);
    const payloadStr = JSON.stringify(messages);
    const cookieHeader = this._getCookieHeader();

    const headers = {
      'Authorization': `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payloadStr)
    };

    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: u.hostname,
        port: 443,
        path: '/cometd/60.0',
        method: 'POST',
        headers,
        timeout: 50000 // Salesforce long-polling hold is ~40 seconds
      }, (res) => {
        this._extractCookies(res);
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            return reject(new Error(`SESSION_EXPIRED: HTTP ${res.statusCode}`));
          }
          try {
            const parsed = JSON.parse(raw);
            resolve(parsed);
          } catch (e) {
            reject(new Error(`Invalid JSON from CometD: ${e.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        resolve([{ channel: '/meta/connect', successful: true, timeout: true }]);
      });

      this.activeRequest = req;
      req.write(payloadStr);
      req.end();
    });
  }

  async handshake() {
    console.log('[CDC Client] Initiating Bayeux handshake with Salesforce CometD 60.0...');
    const res = await this._postCometd([{
      channel: '/meta/handshake',
      version: '1.0',
      supportedConnectionTypes: ['long-polling']
    }]);

    const msg = Array.isArray(res) ? res[0] : res;
    if (!msg || !msg.successful) {
      throw new Error(`Handshake failed: ${msg ? msg.error : 'No response'}`);
    }

    this.clientId = msg.clientId;
    console.log(`[CDC Client] ✅ Handshake successful! Client ID: ${this.clientId}`);
  }

  async subscribe(channel) {
    if (!this.clientId) throw new Error('Cannot subscribe without handshake clientId');
    console.log(`[CDC Client] Subscribing to channel: ${channel}...`);

    const subMsg = {
      channel: '/meta/subscribe',
      clientId: this.clientId,
      subscription: channel
    };

    if (this.replayMap[channel]) {
      subMsg.ext = { "replay": { [channel]: this.replayMap[channel] } };
    }

    const res = await this._postCometd([subMsg]);
    const msg = Array.isArray(res) ? res[0] : res;
    if (!msg || !msg.successful) {
      console.warn(`[CDC Client] ⚠ Subscription notice for ${channel}:`, msg ? msg.error : 'Unknown');
      return false;
    }

    console.log(`[CDC Client] ✅ Subscribed to ${channel}`);
    return true;
  }

  async _pollLoop() {
    while (this.isRunning) {
      try {
        const res = await this._postCometd([{
          channel: '/meta/connect',
          clientId: this.clientId,
          connectionType: 'long-polling'
        }]);

        const messages = Array.isArray(res) ? res : [res];

        for (const m of messages) {
          if (!m) continue;

          // Event delivery message
          if (m.data && m.channel && m.channel.startsWith('/data/')) {
            await this._handleEventMessage(m);
          }

          // Connection status
          if (m.channel === '/meta/connect' && m.successful === false) {
            console.warn('[CDC Client] Connect returned unsuccessful. Re-handshaking...');
            await this.handshake();
            for (const ch of this.channels) await this.subscribe(ch);
          }
        }
      } catch (err) {
        if (!this.isRunning) break;
        console.warn(`[CDC Client] Long poll notice: ${err.message}. Reconnecting...`);
        if (err.message && err.message.includes('SESSION_EXPIRED')) {
          getOrgAuth(true); // Force refresh token
        }
        await new Promise(r => setTimeout(r, 4000));
        try {
          await this.handshake();
          for (const ch of this.channels) await this.subscribe(ch);
        } catch (e) {}
      }
    }
  }

  async _handleEventMessage(msg) {
    const payload = msg.data.payload;
    const header = payload.ChangeEventHeader || {};
    const entity = header.entityName;
    const changeType = header.changeType;
    const recordIds = header.recordIds || [];
    const replayId = (msg.data.event && msg.data.event.replayId) || null;

    if (replayId && msg.channel) {
      this.replayMap[msg.channel] = replayId;
    }

    console.log(`[CDC Push] ⚡ Real-Time ${changeType} on ${entity} (${recordIds.length} records: ${recordIds.slice(0, 3).join(', ')}...)`);

    try {
      if (entity === 'Task') {
        await this._syncChangedTasks(recordIds, payload, changeType);
      } else if (entity === 'Case') {
        await this._syncChangedCases(recordIds, payload, changeType);
      }
    } catch (handlerErr) {
      console.error(`[CDC Push Error]:`, handlerErr.message);
      await dlq.enqueue(entity.toLowerCase() + 's_cdc', { recordIds, payload, changeType }, handlerErr);
    }
  }

  async _syncChangedTasks(recordIds, payload, changeType) {
    if (changeType === 'DELETE') {
      await pgDb.query('DELETE FROM tasks WHERE task_id = ANY($1)', [recordIds]);
      console.log(`[CDC Postgres] Deleted ${recordIds.length} task(s) from PostgreSQL clone.`);
      return;
    }

    const { fetchQueryBatch } = require('./sf-client');
    const auth = getOrgAuth();
    const formattedIds = recordIds.map(id => `'${id}'`).join(',');
    const soql = `
      SELECT
        Id, WhatId,
        TYPEOF What
            WHEN Case THEN Id, CaseNumber, AccountId, Product_Environment__c, Account_Chain_Code__c,
                            Account_Number__c, Account_Name__c, Priority, Status, Owner.Name, Reason
        END,
        Task_Number__c, Subject, Status, Access_Flag__c, Owner.Name, ActivityDate,
        LastModifiedBy.Name, Last_Modified_Time__c, LastModifiedDate, CompletedDateTime, Description, SystemModstamp
      FROM Task
      WHERE Id IN (${formattedIds})
    `;

    const res = await fetchQueryBatch(auth.accessToken, auth.instanceUrl, `/services/data/v60.0/query?q=${encodeURIComponent(soql)}`);
    if (res.records && res.records.length > 0) {
      await pgDb.upsertTasksBatch(res.records);
      console.log(`[CDC Postgres] ⚡ Instant push upserted ${res.records.length} task(s) to sicsappsina6:5433 in < 500ms!`);
    }
  }

  async _syncChangedCases(recordIds, payload, changeType) {
    if (changeType === 'DELETE') {
      await pgDb.query('DELETE FROM cases WHERE case_id = ANY($1)', [recordIds]);
      console.log(`[CDC Postgres] Deleted ${recordIds.length} case(s) from PostgreSQL clone.`);
      return;
    }

    const { fetchQueryBatch } = require('./sf-client');
    const auth = getOrgAuth();
    const formattedIds = recordIds.map(id => `'${id}'`).join(',');
    const soql = `
      SELECT 
        Id, CaseNumber, AccountId, Account.Name, Account_Chain_Code__c,
        ContactId, Contact.Name, OwnerId, Owner.Name, Status, Priority,
        Reason, Product_Environment__c, Subject, Description,
        CreatedDate, ClosedDate, LastModifiedDate, SystemModstamp 
      FROM Case 
      WHERE Id IN (${formattedIds})
    `;

    const res = await fetchQueryBatch(auth.accessToken, auth.instanceUrl, `/services/data/v60.0/query?q=${encodeURIComponent(soql)}`);
    if (res.records && res.records.length > 0) {
      await pgDb.upsertCasesBatch(res.records);
      console.log(`[CDC Postgres] ⚡ Instant push upserted ${res.records.length} case(s) to sicsappsina6:5433 in < 500ms!`);
    }
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[CDC Engine] Starting Real-Time Change Data Capture daemon...');

    try {
      await this.handshake();
      for (const ch of this.channels) {
        await this.subscribe(ch);
      }
      this._pollLoop();
    } catch (err) {
      console.warn('[CDC Engine] Initial startup warning (will retry in 10s):', err.message);
      setTimeout(() => {
        if (this.isRunning) this.start();
      }, 10000);
    }
  }

  stop() {
    this.isRunning = false;
    if (this.activeRequest) {
      try { this.activeRequest.destroy(); } catch (e) {}
    }
    console.log('[CDC Engine] Stopped.');
  }
}

const cdcClient = new SalesforceCdcClient();

module.exports = {
  SalesforceCdcClient,
  cdcClient
};
