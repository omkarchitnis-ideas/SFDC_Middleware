/**
 * Sets up JSONB Functional & Partial Indexes and Enterprise Dynamic Views
 * on PostgreSQL server sicsappsina6:5433 (salesforce_clone)
 */

const pgDb = require('./db-postgres');

async function setupViewsAndIndexes() {
  console.log('=== Configuring PostgreSQL Optimization Layer ===');
  
  // 1. Functional & Partial Indexes
  console.log('1. Creating JSONB Functional & Partial Indexes...');
  const indexQueries = [
    `CREATE INDEX IF NOT EXISTS idx_cases_raw_prod_env ON cases ((raw_payload->>'Product_Environment__c'));`,
    `CREATE INDEX IF NOT EXISTS idx_cases_raw_chain_code ON cases ((raw_payload->>'Account_Chain_Code__c'));`,
    `CREATE INDEX IF NOT EXISTS idx_cases_raw_prop_name ON cases ((raw_payload->>'Property_Name__c'));`,
    `CREATE INDEX IF NOT EXISTS idx_cases_open_prio ON cases (priority, status) WHERE status NOT IN ('Closed', 'Resolved');`,
    `CREATE INDEX IF NOT EXISTS idx_cases_created_desc ON cases (created_date DESC);`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_raw_access_flag ON tasks ((raw_payload->>'Access_Flag__c'));`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_assigned_active ON tasks (assigned, status) WHERE status NOT LIKE '%Complete%';`
  ];

  for (const q of indexQueries) {
    try {
      await pgDb.query(q);
      console.log(`   ✔ Index ensured`);
    } catch (e) {
      console.warn(`   ⚠ Index warning: ${e.message}`);
    }
  }

  // 2. Enterprise Dynamic Tabular Views
  console.log('2. Creating Enterprise Dynamic Tabular Views...');
  
  const view1 = `
    CREATE OR REPLACE VIEW v_active_cases AS
    SELECT 
      c.case_id,
      c.case_number,
      c.account_id,
      c.account_name,
      c.account_chain_code,
      c.property_name,
      c.contact_name,
      c.owner_name,
      c.status,
      c.priority,
      c.case_reason,
      c.product_environment,
      c.subject,
      c.created_date,
      c.last_modified_date,
      ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - c.created_date)) / 86400.0, 1) AS age_days,
      c.raw_payload->>'Sub_Status__c' AS sub_status,
      c.raw_payload->>'Customer_Tier__c' AS customer_tier,
      c.raw_payload->>'Severity__c' AS severity,
      c.raw_payload->>'Resolution_Summary__c' AS resolution_summary
    FROM cases c
    WHERE c.status NOT IN ('Closed', 'Resolved');
  `;

  const view2 = `
    CREATE OR REPLACE VIEW v_tasks_queue AS
    SELECT 
      t.task_id,
      t.task_number,
      t.case_number,
      t.subject,
      t.status,
      t.assigned,
      t.owner_id,
      t.case_owner,
      t.product_environment,
      t.account_chain_code,
      t.property_name,
      t.case_priority,
      t.case_status,
      t.case_reason,
      t.bounce_count,
      t.previous_owner,
      t.created_date,
      t.last_modified_date,
      t.completed_date_time,
      ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(t.last_modified_date, t.created_date))) / 3600.0, 1) AS unhandled_hours,
      t.raw_payload->>'Access_Flag__c' AS access_flag,
      t.raw_payload->>'Estimated_Time__c' AS estimated_time
    FROM tasks t;
  `;

  const view3 = `
    CREATE OR REPLACE VIEW v_team_workload AS
    SELECT 
      COALESCE(assigned, 'Unassigned') AS team_member,
      count(*) FILTER (WHERE status NOT LIKE '%Complete%') AS active_tasks,
      count(*) FILTER (WHERE status NOT LIKE '%Complete%' AND ROUND(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - COALESCE(last_modified_date, created_date))) / 3600.0, 1) >= 24) AS severe_overdue_24h,
      count(*) FILTER (WHERE status LIKE '%Complete%' AND completed_date_time::date = CURRENT_DATE) AS resolved_today,
      count(*) FILTER (WHERE bounce_count > 0) AS bounced_tasks
    FROM tasks
    GROUP BY assigned
    ORDER BY active_tasks DESC;
  `;

  await pgDb.query(view1);
  console.log('   ✔ View created: v_active_cases');
  await pgDb.query(view2);
  console.log('   ✔ View created: v_tasks_queue');
  await pgDb.query(view3);
  console.log('   ✔ View created: v_team_workload');

  // 3. Permissions for team_reader
  console.log('3. Granting SELECT permissions to team_reader...');
  await pgDb.query(`GRANT SELECT ON v_active_cases TO team_reader;`);
  await pgDb.query(`GRANT SELECT ON v_tasks_queue TO team_reader;`);
  await pgDb.query(`GRANT SELECT ON v_team_workload TO team_reader;`);
  console.log('   ✔ All permissions granted to team_reader.');

  console.log('=== Optimization Layer Configured Successfully ===');
  await pgDb.pool.end();
}

setupViewsAndIndexes().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
