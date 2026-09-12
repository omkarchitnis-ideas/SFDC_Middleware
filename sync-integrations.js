/**
 * Fast Sync for Salesforce Integration__c Custom Object
 * Syncs all 580 integration records into PostgreSQL salesforce_clone.integrations
 */

const { getOrgAuth, runSoql, describeSObject } = require('./sf-client');
const pgDb = require('./db-postgres');

async function syncIntegrations() {
  console.log('🚀 [Integrations Sync] Starting sync of Integration__c...');
  const auth = getOrgAuth();
  const fields = await describeSObject(auth.accessToken, auth.instanceUrl, 'Integration__c');
  console.log(`  🔍 Discovered ${fields.length} queryable fields on Integration__c.`);

  // Create table if not exists
  await pgDb.query(`
    CREATE TABLE IF NOT EXISTS integrations (
      integration_id VARCHAR(18) PRIMARY KEY,
      name VARCHAR(255),
      account_id VARCHAR(18),
      overbooking_controls VARCHAR(255),
      decisions_provided BOOLEAN,
      integration_type VARCHAR(255),
      raw_payload JSONB,
      synced_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_integrations_account_id ON integrations(account_id);
    GRANT SELECT ON integrations TO team_reader;
  `);

  const soql = `SELECT ${fields.join(', ')} FROM Integration__c`;
  const result = await runSoql(auth.accessToken, auth.instanceUrl, soql);
  const records = result.records || [];
  console.log(`  📦 Retrieved ${records.length} Integration__c records from Salesforce.`);

  const client = await pgDb.pool.connect();
  try {
    await client.query('BEGIN');
    const text = `
      INSERT INTO integrations (
        integration_id, name, account_id, overbooking_controls, decisions_provided,
        integration_type, raw_payload, synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
      ON CONFLICT (integration_id) DO UPDATE SET
        name = EXCLUDED.name,
        account_id = EXCLUDED.account_id,
        overbooking_controls = EXCLUDED.overbooking_controls,
        decisions_provided = EXCLUDED.decisions_provided,
        integration_type = EXCLUDED.integration_type,
        raw_payload = EXCLUDED.raw_payload,
        synced_at = CURRENT_TIMESTAMP;
    `;

    for (const r of records) {
      await client.query(text, [
        r.Id,
        r.Name,
        r.Account__c || null,
        r.Overbooking_Controls__c || null,
        Boolean(r.Decisions_Provided__c),
        r.Integration_Type__c || null,
        JSON.stringify(r)
      ]);
    }
    await client.query('COMMIT');
    console.log(`  ✅ Successfully saved all ${records.length} Integration__c records to PostgreSQL!`);
    await pgDb.updateSyncState('Integration__c', new Date(), records.length, 'SUCCESS');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  syncIntegrations()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Sync failed:', err);
      process.exit(1);
    });
}

module.exports = { syncIntegrations };
