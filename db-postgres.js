/**
 * PostgreSQL Database Adapter for Salesforce Clone (ODS)
 * Server: sicsappsina6 (172.26.121.184:5433)
 * Database: salesforce_clone
 */

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || '172.26.121.184',
  port: parseInt(process.env.PG_PORT, 10) || 5433,
  database: process.env.PG_DATABASE || 'salesforce_clone',
  user: process.env.PG_USER || 'sfdc_admin',
  password: process.env.PG_PASSWORD || 'sfdc_admin_prod_2026!ideas',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[PostgreSQL ODS] Unexpected error on idle client:', err.message);
});

async function query(text, params) {
  const start = Date.now();
  const res = await pool.query(text, params);
  const duration = Date.now() - start;
  return res;
}

/**
 * Upserts a batch of task records into the PostgreSQL tasks table.
 */
async function upsertTasksBatch(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const text = `
      INSERT INTO tasks (
        task_id, task_number, case_id, case_number, subject, status,
        assigned, owner_id, case_owner, product_environment, account_chain_code,
        account_number, property_name, case_priority, case_status, case_reason,
        bounce_count, previous_owner, created_date, completed_date_time,
        last_modified_date, last_modified_by, system_modstamp, description, raw_payload, synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22, $23, $24, $25, CURRENT_TIMESTAMP
      )
      ON CONFLICT (task_id) DO UPDATE SET
        task_number = EXCLUDED.task_number,
        case_id = EXCLUDED.case_id,
        case_number = EXCLUDED.case_number,
        subject = EXCLUDED.subject,
        status = EXCLUDED.status,
        assigned = EXCLUDED.assigned,
        owner_id = EXCLUDED.owner_id,
        case_owner = EXCLUDED.case_owner,
        product_environment = EXCLUDED.product_environment,
        account_chain_code = EXCLUDED.account_chain_code,
        account_number = EXCLUDED.account_number,
        property_name = EXCLUDED.property_name,
        case_priority = EXCLUDED.case_priority,
        case_status = EXCLUDED.case_status,
        case_reason = EXCLUDED.case_reason,
        bounce_count = EXCLUDED.bounce_count,
        previous_owner = EXCLUDED.previous_owner,
        created_date = EXCLUDED.created_date,
        completed_date_time = EXCLUDED.completed_date_time,
        last_modified_date = EXCLUDED.last_modified_date,
        last_modified_by = EXCLUDED.last_modified_by,
        system_modstamp = EXCLUDED.system_modstamp,
        description = EXCLUDED.description,
        raw_payload = EXCLUDED.raw_payload,
        synced_at = CURRENT_TIMESTAMP;
    `;

    for (const t of tasks) {
      const taskId = t.task_id || t.Id || t.Task_Id || t.task_number || t.Task_Number__c || t.Task_Number;
      const vals = [
        taskId,
        t.task_number || t.Task_Number__c || t.Task_Number,
        t.case_id || t.WhatId || t.Case_Id,
        t.case_number || (t.What && t.What.CaseNumber) || t.Case_Number,
        t.subject || t.Subject,
        t.status || t.Status,
        t.assigned || (t.Owner && t.Owner.Name) || t.Assigned,
        t.owner_id || t.OwnerId,
        t.case_owner || (t.What && t.What.Owner && t.What.Owner.Name) || t.Case_Owner,
        t.product_environment || (t.What && t.What.Product_Environment__c) || t.Product_Environment,
        t.account_chain_code || (t.What && t.What.Account_Chain_Code__c) || t.Account_Chain_Code,
        t.account_number || (t.What && t.What.Account_Number__c) || t.Account_Number,
        t.property_name || (t.What && t.What.Account_Name__c) || t.Property_Name,
        t.case_priority || (t.What && t.What.Priority) || t.Case_Priority,
        t.case_status || (t.What && t.What.Status) || t.Case_Status,
        t.case_reason || (t.What && t.What.Reason) || t.Case_Reason,
        parseInt(t.bounce_count || t.Bounce_Count || 0, 10),
        t.previous_owner || t.Previous_Owner || null,
        t.created_date || t.CreatedDate ? new Date(t.created_date || t.CreatedDate) : null,
        t.completed_date_time || t.CompletedDateTime ? new Date(t.completed_date_time || t.CompletedDateTime) : null,
        t.last_modified_date || t.LastModifiedDate ? new Date(t.last_modified_date || t.LastModifiedDate) : null,
        t.last_modified_by || (t.LastModifiedBy && t.LastModifiedBy.Name) || t.Last_Modified_By,
        t.system_modstamp || t.SystemModstamp ? new Date(t.system_modstamp || t.SystemModstamp) : (t.last_modified_date || t.LastModifiedDate ? new Date(t.last_modified_date || t.LastModifiedDate) : null),
        t.description || t.Description || null,
        JSON.stringify(t)
      ];
      await client.query(text, vals);
    }

    await client.query('COMMIT');
    return tasks.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Upserts a batch of case records into the PostgreSQL cases table.
 */
async function upsertCasesBatch(cases) {
  if (!Array.isArray(cases) || cases.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const text = `
      INSERT INTO cases (
        case_id, case_number, account_id, account_name, account_chain_code,
        property_name, contact_id, contact_name, owner_id, owner_name,
        status, priority, case_reason, product_environment, subject,
        description, created_date, closed_date, last_modified_date,
        system_modstamp, raw_payload, synced_at
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15,
        $16, $17, $18, $19,
        $20, $21, CURRENT_TIMESTAMP
      )
      ON CONFLICT (case_id) DO UPDATE SET
        case_number = EXCLUDED.case_number,
        account_id = EXCLUDED.account_id,
        account_name = EXCLUDED.account_name,
        account_chain_code = EXCLUDED.account_chain_code,
        property_name = EXCLUDED.property_name,
        contact_id = EXCLUDED.contact_id,
        contact_name = EXCLUDED.contact_name,
        owner_id = EXCLUDED.owner_id,
        owner_name = EXCLUDED.owner_name,
        status = EXCLUDED.status,
        priority = EXCLUDED.priority,
        case_reason = EXCLUDED.case_reason,
        product_environment = EXCLUDED.product_environment,
        subject = EXCLUDED.subject,
        description = EXCLUDED.description,
        created_date = EXCLUDED.created_date,
        closed_date = EXCLUDED.closed_date,
        last_modified_date = EXCLUDED.last_modified_date,
        system_modstamp = EXCLUDED.system_modstamp,
        raw_payload = EXCLUDED.raw_payload,
        synced_at = CURRENT_TIMESTAMP;
    `;

    for (const c of cases) {
      const vals = [
        c.Id || c.case_id,
        c.CaseNumber || c.case_number,
        c.AccountId || c.account_id || null,
        (c.Account && c.Account.Name) || c.Account_Name__c || c.account_name || null,
        c.Account_Chain_Code__c || c.account_chain_code || null,
        c.Property_Name__c || c.property_name || null,
        c.ContactId || c.contact_id || null,
        (c.Contact && c.Contact.Name) || c.contact_name || null,
        c.OwnerId || c.owner_id || null,
        (c.Owner && c.Owner.Name) || c.owner_name || null,
        c.Status || c.status || null,
        c.Priority || c.priority || null,
        c.Reason || c.case_reason || null,
        c.Product_Environment__c || c.product_environment || null,
        c.Subject || c.subject || null,
        c.Description || c.description || null,
        c.CreatedDate ? new Date(c.CreatedDate) : null,
        c.ClosedDate ? new Date(c.ClosedDate) : null,
        c.LastModifiedDate ? new Date(c.LastModifiedDate) : null,
        c.SystemModstamp ? new Date(c.SystemModstamp) : (c.LastModifiedDate ? new Date(c.LastModifiedDate) : null),
        JSON.stringify(c)
      ];
      await client.query(text, vals);
    }

    await client.query('COMMIT');
    return cases.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Upserts a batch of users into the PostgreSQL users table.
 */
async function upsertUsersBatch(users) {
  if (!Array.isArray(users) || users.length === 0) return 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const text = `
      INSERT INTO users (
        user_id, name, email, username, is_active, role_id, profile_id, raw_payload, synced_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP
      )
      ON CONFLICT (user_id) DO UPDATE SET
        name = EXCLUDED.name,
        email = EXCLUDED.email,
        username = EXCLUDED.username,
        is_active = EXCLUDED.is_active,
        role_id = EXCLUDED.role_id,
        profile_id = EXCLUDED.profile_id,
        raw_payload = EXCLUDED.raw_payload,
        synced_at = CURRENT_TIMESTAMP;
    `;

    for (const u of users) {
      const vals = [
        u.Id || u.user_id,
        u.Name || u.name,
        u.Email || u.email,
        u.Username || u.username,
        u.IsActive !== undefined ? u.IsActive : (u.is_active !== undefined ? u.is_active : true),
        u.UserRoleId || u.role_id || null,
        u.ProfileId || u.profile_id || null,
        JSON.stringify(u)
      ];
      await client.query(text, vals);
    }

    await client.query('COMMIT');
    return users.length;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Sync State Tracking
 */
async function getSyncState(objectName) {
  const res = await query('SELECT * FROM sync_state WHERE object_name = $1', [objectName]);
  return res.rows[0] || null;
}

async function updateSyncState(objectName, systemModstamp, count, status, error = null) {
  const text = `
    INSERT INTO sync_state (object_name, last_synced_system_modstamp, total_records, last_status, last_error, updated_at)
    VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
    ON CONFLICT (object_name) DO UPDATE SET
      last_synced_system_modstamp = COALESCE(EXCLUDED.last_synced_system_modstamp, sync_state.last_synced_system_modstamp),
      total_records = EXCLUDED.total_records,
      last_status = EXCLUDED.last_status,
      last_error = EXCLUDED.last_error,
      updated_at = CURRENT_TIMESTAMP;
  `;
  await query(text, [objectName, systemModstamp, count, status, error]);
}

module.exports = {
  pool,
  query,
  upsertTasksBatch,
  upsertCasesBatch,
  upsertUsersBatch,
  getSyncState,
  updateSyncState
};
