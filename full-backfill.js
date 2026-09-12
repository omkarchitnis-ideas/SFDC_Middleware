/**
 * Comprehensive Background Backfill Engine for Salesforce Clone (ODS)
 * Server: sicsappsina6:5433 | Database: salesforce_clone
 * 
 * OPTION A IMPLEMENTATION: Dynamic Describe (100% Field Coverage)
 * Dynamically queries Salesforce metadata at runtime to ingest all standard and custom (__c)
 * fields across Case, Task, Account, and CaseComment into PostgreSQL with JSONB raw_payload.
 */

const { getOrgAuth, streamSoql, describeSObject } = require('./sf-client');
const pgDb = require('./db-postgres');

async function backfillAccounts(auth) {
  console.log('\n[Option A Backfill 1/4] Discovering & Streaming Accounts...');
  const fields = await describeSObject(auth.accessToken, auth.instanceUrl, 'Account');
  console.log(`  Discovered ${fields.length} queryable fields on Account.`);
  
  let totalAccounts = 0;
  const soql = `SELECT ${fields.join(', ')} FROM Account`;

  const client = await pgDb.pool.connect();
  try {
    const { total } = await streamSoql(
      auth.accessToken,
      auth.instanceUrl,
      soql,
      async (batch) => {
        await client.query('BEGIN');
        const text = `
          INSERT INTO accounts (account_id, account_name, account_number, billing_country, raw_payload, synced_at)
          VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
          ON CONFLICT (account_id) DO UPDATE SET
            account_name = EXCLUDED.account_name,
            account_number = EXCLUDED.account_number,
            billing_country = EXCLUDED.billing_country,
            raw_payload = EXCLUDED.raw_payload,
            synced_at = CURRENT_TIMESTAMP;
        `;
        for (const a of batch) {
          await client.query(text, [
            a.Id,
            a.Name || 'Unnamed Account',
            a.AccountNumber || null,
            a.BillingCountry || null,
            JSON.stringify(a)
          ]);
        }
        await client.query('COMMIT');
        totalAccounts += batch.length;
        process.stdout.write(`  Accounts streamed: ${totalAccounts} (all ${fields.length} fields)...\r`);
      },
      { maxRecords: 250000 }
    );
    console.log(`\n✅ Accounts backfill complete: ${totalAccounts} accounts stored with 100% field coverage.`);
    await pgDb.updateSyncState('Account', new Date(), totalAccounts, 'SUCCESS');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌ Accounts backfill error:', err.message);
    await pgDb.updateSyncState('Account', new Date(), totalAccounts, 'ERROR', err.message);
  } finally {
    client.release();
  }
}

async function backfillCases(auth) {
  console.log('\n[Option A Backfill 2/4] Discovering & Streaming Full Cases...');
  const fields = await describeSObject(auth.accessToken, auth.instanceUrl, 'Case');
  console.log(`  Discovered ${fields.length} queryable fields on Case.`);

  let totalCases = 0;
  const soql = `
    SELECT 
      ${fields.join(', ')},
      Account.Name, Contact.Name, Owner.Name
    FROM Case 
    ORDER BY CreatedDate DESC
  `;

  try {
    const { total } = await streamSoql(
      auth.accessToken,
      auth.instanceUrl,
      soql,
      async (batch) => {
        await pgDb.upsertCasesBatch(batch);
        totalCases += batch.length;
        process.stdout.write(`  Cases streamed: ${totalCases} (all ${fields.length} fields)...\r`);
      },
      { maxRecords: 100000 }
    );
    console.log(`\n✅ Cases backfill complete: ${totalCases} cases stored with 100% field coverage.`);
    await pgDb.updateSyncState('Case', new Date(), totalCases, 'SUCCESS');
  } catch (err) {
    console.error('\n❌ Cases backfill error:', err.message);
    await pgDb.updateSyncState('Case', new Date(), totalCases, 'ERROR', err.message);
  }
}

async function backfillCaseComments(auth) {
  console.log('\n[Option A Backfill 3/4] Discovering & Streaming Case Comments...');
  const fields = await describeSObject(auth.accessToken, auth.instanceUrl, 'CaseComment');
  console.log(`  Discovered ${fields.length} queryable fields on CaseComment.`);

  let totalComments = 0;
  const soql = `
    SELECT ${fields.join(', ')}, CreatedBy.Name
    FROM CaseComment
    ORDER BY CreatedDate DESC
  `;

  const client = await pgDb.pool.connect();
  try {
    const { total } = await streamSoql(
      auth.accessToken,
      auth.instanceUrl,
      soql,
      async (batch) => {
        await client.query('BEGIN');
        const text = `
          INSERT INTO case_comments (
            comment_id, case_id, is_published, comment_body, created_by_id, created_by_name,
            created_date, last_modified_date, system_modstamp, raw_payload, synced_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
          ON CONFLICT (comment_id) DO UPDATE SET
            is_published = EXCLUDED.is_published,
            comment_body = EXCLUDED.comment_body,
            created_by_name = EXCLUDED.created_by_name,
            last_modified_date = EXCLUDED.last_modified_date,
            system_modstamp = EXCLUDED.system_modstamp,
            raw_payload = EXCLUDED.raw_payload,
            synced_at = CURRENT_TIMESTAMP;
        `;
        for (const c of batch) {
          await client.query(text, [
            c.Id,
            c.ParentId,
            Boolean(c.IsPublished),
            c.CommentBody || null,
            c.CreatedById || null,
            (c.CreatedBy && c.CreatedBy.Name) || null,
            c.CreatedDate ? new Date(c.CreatedDate) : null,
            c.LastModifiedDate ? new Date(c.LastModifiedDate) : null,
            c.SystemModstamp ? new Date(c.SystemModstamp) : (c.LastModifiedDate ? new Date(c.LastModifiedDate) : null),
            JSON.stringify(c)
          ]);
        }
        await client.query('COMMIT');
        totalComments += batch.length;
        process.stdout.write(`  Comments streamed: ${totalComments}...\r`);
      },
      { maxRecords: 100000 }
    );
    console.log(`\n✅ Case Comments backfill complete: ${totalComments} comments stored.`);
    await pgDb.updateSyncState('CaseComment', new Date(), totalComments, 'SUCCESS');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\n❌ Case Comments backfill error:', err.message);
    await pgDb.updateSyncState('CaseComment', new Date(), totalComments, 'ERROR', err.message);
  } finally {
    client.release();
  }
}

async function backfillTasks(auth) {
  console.log('\n[Option A Backfill 4/4] Discovering & Streaming Full Tasks...');
  const fields = await describeSObject(auth.accessToken, auth.instanceUrl, 'Task');
  console.log(`  Discovered ${fields.length} queryable fields on Task.`);

  let totalTasks = 0;
  const soql = `
    SELECT
      ${fields.join(', ')},
      TYPEOF What
          WHEN Case THEN Id, CaseNumber, AccountId, Product_Environment__c, Account_Chain_Code__c,
                          Account_Number__c, Account_Name__c, Priority, Status, Owner.Name, Reason
      END,
      Owner.Name,
      LastModifiedBy.Name
    FROM Task
    WHERE What.Type = 'Case'
    ORDER BY CreatedDate DESC
  `;

  try {
    const { total } = await streamSoql(
      auth.accessToken,
      auth.instanceUrl,
      soql,
      async (batch) => {
        await pgDb.upsertTasksBatch(batch);
        totalTasks += batch.length;
        process.stdout.write(`  Tasks streamed: ${totalTasks} (all ${fields.length} fields)...\r`);
      },
      { maxRecords: 100000 }
    );
    console.log(`\n✅ Tasks backfill complete: ${totalTasks} tasks stored with 100% field coverage.`);
    await pgDb.updateSyncState('Task', new Date(), totalTasks, 'SUCCESS');
  } catch (err) {
    console.error('\n❌ Tasks backfill error:', err.message);
  }
}

async function runFullBackfill() {
  console.log('===========================================================');
  console.log('🚀 COMMENCING ENTERPRISE SALESFORCE CLONE FULL BACKFILL');
  console.log('Option A: Dynamic Describe (100% Field Coverage)');
  console.log('Target: sicsappsina6:5433 | Database: salesforce_clone');
  console.log('===========================================================');

  const startTime = Date.now();
  const auth = getOrgAuth();

  // 1. Accounts
  await backfillAccounts(auth);

  // 2. Cases
  await backfillCases(auth);

  // 3. Case Comments
  await backfillCaseComments(auth);

  // 4. Tasks
  await backfillTasks(auth);

  const durationMin = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log('\n===========================================================');
  console.log(`🎉 FULL BACKFILL PIPELINE COMPLETE in ${durationMin} minutes!`);
  console.log('===========================================================');

  const counts = await pgDb.query(`
    SELECT 'tasks' as tbl, count(*) as c FROM tasks
    UNION ALL SELECT 'tasks_archive', count(*) FROM tasks_archive
    UNION ALL SELECT 'cases', count(*) FROM cases
    UNION ALL SELECT 'case_comments', count(*) FROM case_comments
    UNION ALL SELECT 'accounts', count(*) FROM accounts
    UNION ALL SELECT 'users', count(*) FROM users;
  `);

  console.table(counts.rows);
  await pgDb.pool.end();
}

runFullBackfill().catch(err => {
  console.error('Fatal backfill error:', err);
  process.exit(1);
});
