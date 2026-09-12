/**
 * Standalone Fast Sync for Salesforce Users
 * Fetches all 54,871 users (both active and inactive) with 100% field coverage (229 fields)
 * and upserts them into PostgreSQL salesforce_clone.users
 */

const { getOrgAuth, streamSoql, describeSObject } = require('./sf-client');
const pgDb = require('./db-postgres');

async function syncAllUsers() {
  console.log('🚀 [User Sync] Starting full sync of Salesforce Users...');
  const startTime = Date.now();
  const auth = getOrgAuth();

  console.log('  🔍 Describing User object...');
  const fields = await describeSObject(auth.accessToken, auth.instanceUrl, 'User');
  console.log(`  ✅ Discovered ${fields.length} queryable fields on User.`);

  const soql = `SELECT ${fields.join(', ')} FROM User ORDER BY CreatedDate DESC`;

  let totalUsers = 0;
  let activeUsers = 0;
  let inactiveUsers = 0;

  try {
    const { total } = await streamSoql(
      auth.accessToken,
      auth.instanceUrl,
      soql,
      async (batch) => {
        await pgDb.upsertUsersBatch(batch);
        totalUsers += batch.length;
        for (const u of batch) {
          if (u.IsActive) activeUsers++;
          else inactiveUsers++;
        }
        process.stdout.write(`  👥 Streamed & saved: ${totalUsers.toLocaleString()} users (${activeUsers.toLocaleString()} active, ${inactiveUsers.toLocaleString()} inactive)...\r`);
      },
      { maxRecords: 100000 }
    );

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n🎉 [User Sync Complete] Successfully synced ${totalUsers.toLocaleString()} total users (${activeUsers.toLocaleString()} active, ${inactiveUsers.toLocaleString()} inactive) in ${elapsedSec}s!`);
    await pgDb.updateSyncState('User', new Date(), totalUsers, 'SUCCESS');
  } catch (err) {
    console.error('\n❌ [User Sync Error]:', err.message);
    await pgDb.updateSyncState('User', new Date(), totalUsers, 'ERROR', err.message);
    throw err;
  }
}

if (require.main === module) {
  syncAllUsers()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { syncAllUsers };
