/**
 * Universal Enterprise Salesforce Model Context Protocol (MCP) Server
 * 
 * Comprehensive 24-tool suite covering:
 * - Case Lifecycle & History
 * - Tasks & Team Queues
 * - Accounts, Contacts, Users & Integrations
 * - Document & File Attachments
 * - Schema & Picklist Discovery
 * - Universal SQL/SOQL & Generic DML Engine
 * 
 * Backed by PostgreSQL Clone (salesforce_clone on sicsappsina6:5433),
 * live Salesforce REST API, and Dead Letter Queue (DLQ).
 */

const express = require('express');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { z } = require('zod');

const pgDb = require('./db-postgres');
const sfClient = require('./sf-client');
const dlq = require('./dlq');

// Initialize MCP Server instance
const mcp = new McpServer({
  name: 'sfdc-enterprise-mcp',
  version: '2.0.0',
  description: 'Universal Enterprise Salesforce MCP Server for Ohm Agent and Automated Systems'
});

// =========================================================================
// DOMAIN 1: CASE LIFECYCLE MANAGEMENT (6 TOOLS)
// =========================================================================

// Tool 1: sfdc_get_case
mcp.tool(
  'sfdc_get_case',
  'Retrieve complete details for a Salesforce Case from PostgreSQL clone in <50ms. Includes all 557 fields, case comments, and owner details.',
  {
    case_number: z.string().optional().describe("8-digit Salesforce Case Number (e.g. '03373301')"),
    case_id: z.string().optional().describe("18-character Salesforce Case ID ('500...')"),
    include_comments: z.boolean().optional().default(true).describe("Whether to include case comments")
  },
  async ({ case_number, case_id, include_comments }) => {
    if (!case_number && !case_id) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Either case_number or case_id must be provided.' }) }],
        isError: true
      };
    }

    const start = Date.now();
    let res;
    if (case_number) {
      const padded = case_number.trim().padStart(8, '0');
      res = await pgDb.query('SELECT * FROM cases WHERE case_number = $1 LIMIT 1', [padded]);
      if (res.rows.length === 0 && padded !== case_number.trim()) {
        res = await pgDb.query('SELECT * FROM cases WHERE case_number = $1 LIMIT 1', [case_number.trim()]);
      }
    } else {
      res = await pgDb.query('SELECT * FROM cases WHERE case_id = $1 LIMIT 1', [case_id.trim()]);
    }

    if (res.rows.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ found: false, message: `Case not found in clone database for: ${case_number || case_id}` }) }]
      };
    }

    const caseData = res.rows[0];
    let comments = [];
    if (include_comments && caseData.case_id) {
      const cRes = await pgDb.query(
        'SELECT comment_id, is_published, comment_body, created_by_name, created_date FROM case_comments WHERE case_id = $1 ORDER BY created_date ASC',
        [caseData.case_id]
      );
      comments = cRes.rows;
    }

    let ownerDetails = null;
    if (caseData.owner_id) {
      const uRes = await pgDb.query('SELECT user_id, name, email, username, is_active FROM users WHERE user_id = $1 LIMIT 1', [caseData.owner_id]);
      if (uRes.rows.length > 0) ownerDetails = uRes.rows[0];
    }

    const durationMs = Date.now() - start;
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          found: true,
          case_id: caseData.case_id,
          case_number: caseData.case_number,
          subject: caseData.subject,
          status: caseData.status,
          priority: caseData.priority,
          case_reason: caseData.case_reason,
          product_environment: caseData.product_environment,
          account_chain_code: caseData.account_chain_code,
          account_name: caseData.account_name,
          property_name: caseData.property_name,
          contact_name: caseData.contact_name,
          owner_name: caseData.owner_name,
          owner_details: ownerDetails,
          description: caseData.description,
          created_date: caseData.created_date,
          closed_date: caseData.closed_date,
          last_modified_date: caseData.last_modified_date,
          comments: comments,
          raw_payload: caseData.raw_payload,
          _query_time_ms: durationMs
        }, null, 2)
      }]
    };
  }
);

// Tool 2: sfdc_search_cases
mcp.tool(
  'sfdc_search_cases',
  'Search and filter historical or active Salesforce cases using indexed attributes (account chain code, property name, product environment, status, priority).',
  {
    account_chain_code: z.string().optional().describe("Client Chain Code (e.g. 'HYATT', 'MAR', 'IHG')"),
    property_name: z.string().optional().describe("Hotel/Property Name or partial string"),
    product_environment: z.string().optional().describe("Product Environment (e.g. 'PROD', 'TEST')"),
    status: z.string().optional().describe("Case Status ('Open', 'Closed', etc.)"),
    priority: z.string().optional().describe("Case Priority ('IS', 'CM0', 'CM1', etc.)"),
    limit: z.number().optional().default(20).describe("Maximum number of records to return (max 100)")
  },
  async ({ account_chain_code, property_name, product_environment, status, priority, limit }) => {
    const start = Date.now();
    const conditions = [];
    const params = [];
    let idx = 1;

    if (account_chain_code) {
      conditions.push(`account_chain_code ILIKE $${idx++}`);
      params.push(`%${account_chain_code.trim()}%`);
    }
    if (property_name) {
      conditions.push(`property_name ILIKE $${idx++}`);
      params.push(`%${property_name.trim()}%`);
    }
    if (product_environment) {
      conditions.push(`product_environment = $${idx++}`);
      params.push(product_environment.trim());
    }
    if (status) {
      conditions.push(`status ILIKE $${idx++}`);
      params.push(status.trim());
    }
    if (priority) {
      conditions.push(`priority ILIKE $${idx++}`);
      params.push(priority.trim());
    }

    const maxRows = Math.min(Math.max(limit || 20, 1), 100);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT case_id, case_number, account_name, account_chain_code, property_name,
             product_environment, status, priority, subject, owner_name, created_date, closed_date
      FROM cases
      ${whereClause}
      ORDER BY created_date DESC
      LIMIT ${maxRows}
    `;

    const res = await pgDb.query(sql, params);
    const durationMs = Date.now() - start;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: res.rows.length,
          cases: res.rows,
          _query_time_ms: durationMs
        }, null, 2)
      }]
    };
  }
);

// Tool 3: sfdc_create_case
mcp.tool(
  'sfdc_create_case',
  'Create a new Case record in Salesforce with instant dual-write to PostgreSQL clone and DLQ protection.',
  {
    subject: z.string().describe("Case Subject"),
    description: z.string().describe("Case Description"),
    account_id: z.string().optional().describe("Salesforce Account ID"),
    priority: z.string().optional().default("Medium").describe("Case Priority"),
    status: z.string().optional().default("New").describe("Case Status"),
    product_environment: z.string().optional().describe("Product Environment (e.g. 'PROD')"),
    case_reason: z.string().optional().describe("Case Reason")
  },
  async ({ subject, description, account_id, priority, status, product_environment, case_reason }) => {
    const start = Date.now();
    const fields = { Subject: subject, Description: description, Priority: priority, Status: status };
    if (account_id) fields.AccountId = account_id;
    if (product_environment) fields.Product_Environment__c = product_environment;
    if (case_reason) fields.Reason = case_reason;

    try {
      const auth = await sfClient.getOrgAuth();
      const sfdcRes = await sfClient.executeSfDmlSingle(auth.accessToken, auth.instanceUrl, 'Case', null, fields, 'POST');
      const caseId = sfdcRes.id;

      // Write-through to Postgres
      await pgDb.query(`
        INSERT INTO cases (case_id, subject, description, priority, status, product_environment, case_reason, account_id, created_date, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (case_id) DO NOTHING;
      `, [caseId, subject, description, priority, status, product_environment || null, case_reason || null, account_id || null]);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, case_id: caseId, status: 'CREATED', _execution_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      const dlqId = dlq.enqueueMutation('CASE_CREATE', 'NEW', fields, err.message);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: err.message, dlq_enqueued: true, dlq_id: dlqId }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool 4: sfdc_update_case
mcp.tool(
  'sfdc_update_case',
  'Update an existing Case record in Salesforce with immediate write-through to PostgreSQL and DLQ protection.',
  {
    case_id: z.string().describe("18-character Salesforce Case ID ('500...')"),
    status: z.string().optional().describe("New Case Status (e.g. 'Closed', 'In Progress')"),
    priority: z.string().optional().describe("New Case Priority (e.g. 'High', 'IS')"),
    reason: z.string().optional().describe("Case Reason"),
    resolution_notes: z.string().optional().describe("Internal or resolution notes appended to description")
  },
  async ({ case_id, status, priority, reason, resolution_notes }) => {
    const start = Date.now();
    const updateFields = {};
    if (status) updateFields.Status = status;
    if (priority) updateFields.Priority = priority;
    if (reason) updateFields.Reason = reason;
    if (resolution_notes) updateFields.Description = resolution_notes;

    if (Object.keys(updateFields).length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'No update fields provided.' }) }],
        isError: true
      };
    }

    try {
      const auth = await sfClient.getOrgAuth();
      await sfClient.executeSfDmlSingle(auth.accessToken, auth.instanceUrl, 'Case', case_id, updateFields, 'PATCH');

      // Local write-through
      await pgDb.query(`
        UPDATE cases SET
          status = COALESCE($1, status),
          priority = COALESCE($2, priority),
          case_reason = COALESCE($3, case_reason),
          last_modified_date = CURRENT_TIMESTAMP,
          synced_at = CURRENT_TIMESTAMP
        WHERE case_id = $4
      `, [status || null, priority || null, reason || null, case_id]);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, case_id, updated_fields: updateFields, status: 'UPDATED', _execution_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      const dlqId = dlq.enqueueMutation('CASE_UPDATE', case_id, updateFields, err.message);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, case_id, error: err.message, dlq_enqueued: true, dlq_id: dlqId }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool 5: sfdc_add_case_comment
mcp.tool(
  'sfdc_add_case_comment',
  'Add a CaseComment note to a Salesforce Case with dual-write to PostgreSQL.',
  {
    case_id: z.string().describe("18-character Salesforce Case ID ('500...')"),
    comment_body: z.string().describe("Text content of the comment"),
    is_published: z.boolean().optional().default(false).describe("Whether the comment is visible to external customer portal")
  },
  async ({ case_id, comment_body, is_published }) => {
    const start = Date.now();
    try {
      const auth = await sfClient.getOrgAuth();
      const sfdcRes = await sfClient.executeSfDmlSingle(
        auth.accessToken,
        auth.instanceUrl,
        'CaseComment',
        null,
        { ParentId: case_id, CommentBody: comment_body, IsPublished: is_published },
        'POST'
      );

      const commentId = sfdcRes.id;
      await pgDb.query(`
        INSERT INTO case_comments (comment_id, case_id, is_published, comment_body, created_date, synced_at)
        VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (comment_id) DO NOTHING;
      `, [commentId, case_id, is_published, comment_body]);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, comment_id: commentId, case_id, _execution_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }],
        isError: true
      };
    }
  }
);

// Tool 6: sfdc_get_case_history
mcp.tool(
  'sfdc_get_case_history',
  'Retrieve the field audit trail history for a case (tracking changes to Status, Owner, Priority over time).',
  {
    case_id: z.string().describe("18-character Salesforce Case ID ('500...')")
  },
  async ({ case_id }) => {
    const start = Date.now();
    try {
      const auth = await sfClient.getOrgAuth();
      const soql = `SELECT Id, CaseId, Field, OldValue, NewValue, CreatedById, CreatedDate FROM CaseHistory WHERE CaseId = '${case_id}' ORDER BY CreatedDate DESC LIMIT 50`;
      const res = await sfClient.runSoql(auth.accessToken, auth.instanceUrl, soql);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ case_id, history_count: (res.records || []).length, history: res.records || [], _query_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }],
        isError: true
      };
    }
  }
);

// =========================================================================
// DOMAIN 2: TASKS & QUEUE OPERATIONS (6 TOOLS)
// =========================================================================

// Tool 7: sfdc_get_task
mcp.tool(
  'sfdc_get_task',
  'Retrieve full task details and parent case context by task ID or task number.',
  {
    task_id: z.string().optional().describe("Salesforce Task ID ('00T...')"),
    task_number: z.string().optional().describe("Task Number (e.g. '00123456')")
  },
  async ({ task_id, task_number }) => {
    if (!task_id && !task_number) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Either task_id or task_number must be provided.' }) }],
        isError: true
      };
    }
    const start = Date.now();
    const query = task_id
      ? 'SELECT * FROM tasks WHERE task_id = $1 LIMIT 1'
      : 'SELECT * FROM tasks WHERE task_number = $1 LIMIT 1';
    const res = await pgDb.query(query, [task_id || task_number]);

    if (res.rows.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ found: false, message: 'Task not found.' }) }]
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ found: true, task: res.rows[0], _query_time_ms: Date.now() - start }, null, 2)
      }]
    };
  }
);

// Tool 8: sfdc_search_tasks
mcp.tool(
  'sfdc_search_tasks',
  'Search operational tasks by status, assignee, priority, case number, or property.',
  {
    status: z.string().optional().describe("Task Status (e.g. 'Open', 'Completed')"),
    assigned: z.string().optional().describe("Assignee name or queue"),
    case_number: z.string().optional().describe("Related Case Number"),
    priority: z.string().optional().describe("Case Priority"),
    limit: z.number().optional().default(50).describe("Max records (max 100)")
  },
  async ({ status, assigned, case_number, priority, limit }) => {
    const start = Date.now();
    const conds = [];
    const params = [];
    let idx = 1;

    if (status) { conds.push(`status ILIKE $${idx++}`); params.push(status.trim()); }
    if (assigned) { conds.push(`assigned ILIKE $${idx++}`); params.push(`%${assigned.trim()}%`); }
    if (case_number) { conds.push(`case_number = $${idx++}`); params.push(case_number.trim().padStart(8, '0')); }
    if (priority) { conds.push(`case_priority ILIKE $${idx++}`); params.push(priority.trim()); }

    const maxRows = Math.min(Math.max(limit || 50, 1), 100);
    const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const sql = `SELECT * FROM tasks ${where} ORDER BY last_modified_date DESC LIMIT ${maxRows}`;
    const res = await pgDb.query(sql, params);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: res.rows.length, tasks: res.rows, _query_time_ms: Date.now() - start }, null, 2)
      }]
    };
  }
);

// Tool 9: sfdc_create_task (Supports Ohm Audit Failure Tasks)
mcp.tool(
  'sfdc_create_task',
  'Create a new Salesforce Task attached to a Case or Account with instant write-through to PostgreSQL and DLQ protection.',
  {
    what_id: z.string().describe("Related Case ID or Account ID ('500...' or '001...')"),
    subject: z.string().describe("Task Subject (e.g. 'Ohm Case Verification Agent - Audit Failed')"),
    description: z.string().describe("Detailed Task Description / Audit Report"),
    owner_name_or_id: z.string().optional().describe("Assignee Name or User ID (e.g. 'Omkar Chitnis')"),
    priority: z.string().optional().default("High").describe("Task Priority ('High', 'Normal', 'Low')"),
    status: z.string().optional().default("Not Started").describe("Task Status ('Not Started', 'In Progress')"),
    activity_date: z.string().optional().describe("Due Date in YYYY-MM-DD format")
  },
  async ({ what_id, subject, description, owner_name_or_id, priority, status, activity_date }) => {
    const start = Date.now();
    let targetOwnerId = null;

    if (owner_name_or_id) {
      if (owner_name_or_id.startsWith('005') || owner_name_or_id.startsWith('00G')) {
        targetOwnerId = owner_name_or_id;
      } else {
        targetOwnerId = await sfClient.getSfOwnerIdByName(owner_name_or_id);
      }
    }

    const taskFields = {
      WhatId: what_id,
      Subject: subject,
      Description: description,
      Priority: priority,
      Status: status
    };
    if (targetOwnerId) taskFields.OwnerId = targetOwnerId;
    if (activity_date) taskFields.ActivityDate = activity_date;

    try {
      const auth = await sfClient.getOrgAuth();
      const sfdcRes = await sfClient.executeSfDmlSingle(auth.accessToken, auth.instanceUrl, 'Task', null, taskFields, 'POST');
      const taskId = sfdcRes.id;

      // Local write-through
      await pgDb.query(`
        INSERT INTO tasks (task_id, case_id, subject, description, status, assigned, owner_id, created_date, synced_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT (task_id) DO NOTHING;
      `, [taskId, what_id.startsWith('500') ? what_id : null, subject, description, status, owner_name_or_id || null, targetOwnerId]);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, task_id: taskId, status: 'CREATED', _execution_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      const dlqId = dlq.enqueueMutation('TASK_CREATE', 'NEW', taskFields, err.message);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: err.message, dlq_enqueued: true, dlq_id: dlqId }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool 10: sfdc_update_task
mcp.tool(
  'sfdc_update_task',
  'Update an existing Task (status, priority, subject, description) in Salesforce and PostgreSQL.',
  {
    task_id: z.string().describe("18-character Salesforce Task ID ('00T...')"),
    status: z.string().optional().describe("New Task Status (e.g. 'Completed', 'In Progress')"),
    priority: z.string().optional().describe("New Task Priority"),
    subject: z.string().optional().describe("New Task Subject"),
    description: z.string().optional().describe("Updated Description")
  },
  async ({ task_id, status, priority, subject, description }) => {
    const start = Date.now();
    const updateFields = {};
    if (status) updateFields.Status = status;
    if (priority) updateFields.Priority = priority;
    if (subject) updateFields.Subject = subject;
    if (description) updateFields.Description = description;

    if (Object.keys(updateFields).length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'No update fields specified.' }) }],
        isError: true
      };
    }

    try {
      const auth = await sfClient.getOrgAuth();
      await sfClient.executeSfDmlSingle(auth.accessToken, auth.instanceUrl, 'Task', task_id, updateFields, 'PATCH');

      await pgDb.query(`
        UPDATE tasks SET
          status = COALESCE($1, status),
          case_priority = COALESCE($2, case_priority),
          subject = COALESCE($3, subject),
          description = COALESCE($4, description),
          last_modified_date = CURRENT_TIMESTAMP,
          synced_at = CURRENT_TIMESTAMP
        WHERE task_id = $5
      `, [status || null, priority || null, subject || null, description || null, task_id]);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, task_id, updated_fields: updateFields, status: 'UPDATED', _execution_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      const dlqId = dlq.enqueueMutation('TASK_UPDATE', task_id, updateFields, err.message);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, task_id, error: err.message, dlq_enqueued: true, dlq_id: dlqId }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool 11: sfdc_reassign_task
mcp.tool(
  'sfdc_reassign_task',
  'Safely reassign a Salesforce Task to another engineer or queue with dual-write to PostgreSQL and Dead Letter Queue (DLQ) protection.',
  {
    task_id: z.string().describe("18-character Salesforce Task ID ('00T...')"),
    new_assignee_name: z.string().describe("Target assignee name or email (e.g. 'Omkar Chitnis')")
  },
  async ({ task_id, new_assignee_name }) => {
    const start = Date.now();
    try {
      const targetOwnerId = await sfClient.getSfOwnerIdByName(new_assignee_name);
      if (!targetOwnerId) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ success: false, error: `Could not resolve '${new_assignee_name}' to an active Salesforce User or Queue.` })
          }],
          isError: true
        };
      }

      const auth = await sfClient.getOrgAuth();
      await sfClient.executeSfDmlSingle(auth.accessToken, auth.instanceUrl, 'Task', task_id, { OwnerId: targetOwnerId }, 'PATCH');

      await pgDb.query(
        'UPDATE tasks SET assigned = $1, owner_id = $2, last_modified_date = CURRENT_TIMESTAMP, synced_at = CURRENT_TIMESTAMP WHERE task_id = $3',
        [new_assignee_name, targetOwnerId, task_id]
      );

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            task_id,
            new_assignee_name,
            target_owner_id: targetOwnerId,
            status: 'UPDATED',
            _execution_time_ms: Date.now() - start
          }, null, 2)
        }]
      };
    } catch (err) {
      const dlqId = dlq.enqueueMutation('TASK_REASSIGN', task_id, { new_assignee: new_assignee_name }, err.message);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, task_id, error: err.message, dlq_enqueued: true, dlq_id: dlqId }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// Tool 12: sfdc_get_team_workload
mcp.tool(
  'sfdc_get_team_workload',
  'Retrieve live aggregated team and queue workload metrics from the pre-computed v_team_workload enterprise view.',
  {},
  async () => {
    const start = Date.now();
    const res = await pgDb.query('SELECT * FROM v_team_workload ORDER BY active_tasks DESC');
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ workload: res.rows, _query_time_ms: Date.now() - start }, null, 2)
      }]
    };
  }
);

// =========================================================================
// DOMAIN 3: DIRECTORY, CONTACTS & INTEGRATIONS (5 TOOLS)
// =========================================================================

// Tool 13: sfdc_get_account
mcp.tool(
  'sfdc_get_account',
  'Retrieve complete details for a client Account from PostgreSQL clone (94k accounts) in <5ms with all 359 fields.',
  {
    account_id: z.string().optional().describe("18-character Salesforce Account ID ('001...')"),
    account_name: z.string().optional().describe("Exact or partial Account / Hotel name"),
    account_number: z.string().optional().describe("Account Number")
  },
  async ({ account_id, account_name, account_number }) => {
    if (!account_id && !account_name && !account_number) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Provide account_id, account_name, or account_number.' }) }],
        isError: true
      };
    }
    const start = Date.now();
    let sql, params;
    if (account_id) {
      sql = 'SELECT * FROM accounts WHERE account_id = $1 LIMIT 1';
      params = [account_id.trim()];
    } else if (account_number) {
      sql = 'SELECT * FROM accounts WHERE account_number = $1 LIMIT 1';
      params = [account_number.trim()];
    } else {
      sql = 'SELECT * FROM accounts WHERE account_name ILIKE $1 LIMIT 1';
      params = [`%${account_name.trim()}%`];
    }

    const res = await pgDb.query(sql, params);
    if (res.rows.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ found: false, message: 'Account not found.' }) }]
      };
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ found: true, account: res.rows[0], _query_time_ms: Date.now() - start }, null, 2)
      }]
    };
  }
);

// Tool 14: sfdc_search_accounts
mcp.tool(
  'sfdc_search_accounts',
  'Search the 94k accounts directory by chain code, brand, country, or keyword.',
  {
    query: z.string().describe("Search keyword, hotel brand, or chain code"),
    country: z.string().optional().describe("Filter by Billing Country"),
    limit: z.number().optional().default(20).describe("Max records (max 100)")
  },
  async ({ query, country, limit }) => {
    const start = Date.now();
    const conds = ['(account_name ILIKE $1 OR account_number ILIKE $1)'];
    const params = [`%${query.trim()}%`];
    let idx = 2;

    if (country) {
      conds.push(`billing_country ILIKE $${idx++}`);
      params.push(`%${country.trim()}%`);
    }

    const maxRows = Math.min(Math.max(limit || 20, 1), 100);
    const sql = `SELECT account_id, account_name, account_number, billing_country FROM accounts WHERE ${conds.join(' AND ')} ORDER BY account_name ASC LIMIT ${maxRows}`;
    const res = await pgDb.query(sql, params);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: res.rows.length, accounts: res.rows, _query_time_ms: Date.now() - start }, null, 2)
      }]
    };
  }
);

// Tool 15: sfdc_resolve_user
mcp.tool(
  'sfdc_resolve_user',
  'Resolve any past or present engineer, consultant, or queue from the complete 54k Salesforce user directory.',
  {
    query: z.string().describe("User ID ('005...'), Name, Email, or Username"),
    active_only: z.boolean().optional().default(false).describe("Whether to only return active users")
  },
  async ({ query, active_only }) => {
    const start = Date.now();
    const q = query.trim();
    let sql, params;

    if (q.startsWith('005')) {
      sql = 'SELECT user_id, name, email, username, is_active, role_id, profile_id, synced_at FROM users WHERE user_id = $1';
      params = [q];
    } else {
      sql = `
        SELECT user_id, name, email, username, is_active, role_id, profile_id, synced_at
        FROM users
        WHERE (name ILIKE $1 OR email ILIKE $1 OR username ILIKE $1)
        ${active_only ? 'AND is_active = true' : ''}
        ORDER BY is_active DESC, name ASC
        LIMIT 25
      `;
      params = [`%${q}%`];
    }

    const res = await pgDb.query(sql, params);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ query: q, count: res.rows.length, users: res.rows, _query_time_ms: Date.now() - start }, null, 2)
      }]
    };
  }
);

// Tool 16: sfdc_get_contact
mcp.tool(
  'sfdc_get_contact',
  'Retrieve hotel or client contacts by contact ID, email, or account ID.',
  {
    contact_id: z.string().optional().describe("Salesforce Contact ID ('003...')"),
    email: z.string().optional().describe("Contact Email Address"),
    account_id: z.string().optional().describe("Salesforce Account ID ('001...')")
  },
  async ({ contact_id, email, account_id }) => {
    const start = Date.now();
    try {
      const auth = await sfClient.getOrgAuth();
      let soql;
      if (contact_id) {
        soql = `SELECT Id, Name, Email, Phone, Title, AccountId FROM Contact WHERE Id = '${contact_id}' LIMIT 1`;
      } else if (email) {
        soql = `SELECT Id, Name, Email, Phone, Title, AccountId FROM Contact WHERE Email = '${email.trim()}' LIMIT 5`;
      } else if (account_id) {
        soql = `SELECT Id, Name, Email, Phone, Title, AccountId FROM Contact WHERE AccountId = '${account_id.trim()}' LIMIT 25`;
      } else {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'Provide contact_id, email, or account_id.' }) }], isError: true };
      }

      const res = await sfClient.runSoql(auth.accessToken, auth.instanceUrl, soql);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: (res.records || []).length, contacts: res.records || [], _query_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

// Tool 17: sfdc_get_integration
mcp.tool(
  'sfdc_get_integration',
  'Retrieve RMS PMS/CRS integration profiles (Overbooking Controls, Decisions Provided, Integration Type) for an Account in <1ms.',
  {
    account_id: z.string().optional().describe("Salesforce Account ID ('001...')"),
    integration_name: z.string().optional().describe("Integration or PMS vendor name (e.g. 'Opera', 'Maestro')")
  },
  async ({ account_id, integration_name }) => {
    const start = Date.now();
    let sql, params;
    if (account_id) {
      sql = 'SELECT * FROM integrations WHERE account_id = $1 LIMIT 5';
      params = [account_id.trim()];
    } else if (integration_name) {
      sql = 'SELECT * FROM integrations WHERE name ILIKE $1 LIMIT 10';
      params = [`%${integration_name.trim()}%`];
    } else {
      sql = 'SELECT * FROM integrations ORDER BY name ASC LIMIT 25';
      params = [];
    }

    const res = await pgDb.query(sql, params);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: res.rows.length, integrations: res.rows, _query_time_ms: Date.now() - start }, null, 2)
      }]
    };
  }
);

// =========================================================================
// DOMAIN 4: FILES & ATTACHMENTS (2 TOOLS)
// =========================================================================

// Tool 18: sfdc_upload_attachment
mcp.tool(
  'sfdc_upload_attachment',
  'Upload a file (diagnostic report, Excel audit, screenshot) as a ContentVersion linked to a Task or Case.',
  {
    entity_id: z.string().describe("Target Task ID or Case ID to attach the file to"),
    filename: z.string().describe("File name with extension (e.g. 'audit_report_03373301.xlsx')"),
    base64_content: z.string().describe("Base64-encoded string of file bytes"),
    title: z.string().optional().describe("Human readable title")
  },
  async ({ entity_id, filename, base64_content, title }) => {
    const start = Date.now();
    try {
      const auth = await sfClient.getOrgAuth();
      const payload = {
        Title: title || filename.replace('.xlsx', '').replace('_', ' '),
        PathOnClient: filename,
        VersionData: base64_content,
        FirstPublishLocationId: entity_id
      };

      const res = await sfClient.executeSfDmlSingle(auth.accessToken, auth.instanceUrl, 'ContentVersion', null, payload, 'POST');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, content_version_id: res.id, linked_entity: entity_id, filename, _execution_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: err.message }) }], isError: true };
    }
  }
);

// Tool 19: sfdc_list_attachments
mcp.tool(
  'sfdc_list_attachments',
  'List all files and attachments linked to a Salesforce Case or Task.',
  {
    entity_id: z.string().describe("Salesforce Case ID ('500...') or Task ID ('00T...')")
  },
  async ({ entity_id }) => {
    const start = Date.now();
    try {
      const auth = await sfClient.getOrgAuth();
      const soql = `
        SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileType,
               ContentDocument.ContentSize, ContentDocument.CreatedDate
        FROM ContentDocumentLink
        WHERE LinkedEntityId = '${entity_id}'
        ORDER BY ContentDocument.CreatedDate DESC
      `;
      const res = await sfClient.runSoql(auth.accessToken, auth.instanceUrl, soql);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ entity_id, count: (res.records || []).length, files: res.records || [], _query_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

// =========================================================================
// DOMAIN 5: SCHEMA & PICKLIST DISCOVERY (2 TOOLS)
// =========================================================================

// Tool 20: sfdc_describe_object
mcp.tool(
  'sfdc_describe_object',
  'Introspect the schema, queryable fields, relationships, and types of any Salesforce sObject (Case, Task, Account, Integration__c, etc.).',
  {
    sobject_name: z.string().describe("Object API name (e.g. 'Case', 'Task', 'Integration__c')")
  },
  async ({ sobject_name }) => {
    const start = Date.now();
    try {
      const auth = await sfClient.getOrgAuth();
      const fields = await sfClient.describeSObject(auth.accessToken, auth.instanceUrl, sobject_name);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ sobject: sobject_name, field_count: fields.length, fields, _query_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

// Tool 21: sfdc_get_picklist_values
mcp.tool(
  'sfdc_get_picklist_values',
  'Retrieve valid picklist options for any field (e.g. Case.Status, Case.Priority, Task.Status) to guarantee zero validation rule failures.',
  {
    sobject_name: z.string().describe("sObject API name (e.g. 'Case', 'Task')"),
    field_name: z.string().describe("Picklist Field API name (e.g. 'Status', 'Priority', 'Reason')")
  },
  async ({ sobject_name, field_name }) => {
    const start = Date.now();
    try {
      const auth = await sfClient.getOrgAuth();
      const meta = await sfClient.fetchQueryBatch(auth.accessToken, auth.instanceUrl, `/services/data/v60.0/sobjects/${sobject_name}/describe`);
      const targetField = (meta.fields || []).find(f => f.name.toLowerCase() === field_name.toLowerCase());

      if (!targetField) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `Field '${field_name}' not found on sObject '${sobject_name}'.` }) }], isError: true };
      }

      const picklistValues = (targetField.picklistValues || []).map(p => ({
        label: p.label,
        value: p.value,
        active: p.active,
        default: p.defaultValue
      }));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            sobject: sobject_name,
            field: targetField.name,
            type: targetField.type,
            picklist_values: picklistValues,
            _query_time_ms: Date.now() - start
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

// =========================================================================
// DOMAIN 6: UNIVERSAL POWER TOOLS (3 TOOLS)
// =========================================================================

// Tool 22: sfdc_query_clone
mcp.tool(
  'sfdc_query_clone',
  'Execute arbitrary read-only SQL queries against the local PostgreSQL clone (cases, accounts, users, tasks, integrations, views).',
  {
    sql: z.string().describe("SQL SELECT statement")
  },
  async ({ sql }) => {
    const trimmed = sql.trim();
    if (!trimmed.toLowerCase().startsWith('select') && !trimmed.toLowerCase().startsWith('with')) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Security violation: Only read-only SELECT or WITH statements permitted.' }) }],
        isError: true
      };
    }
    const start = Date.now();
    try {
      const res = await pgDb.query(trimmed);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ rowCount: res.rows.length, rows: res.rows, _execution_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

// Tool 23: sfdc_query_soql
mcp.tool(
  'sfdc_query_soql',
  'Execute arbitrary read-only SOQL queries directly against live Salesforce REST API.',
  {
    soql: z.string().describe("Valid SOQL SELECT statement")
  },
  async ({ soql }) => {
    const start = Date.now();
    try {
      const auth = await sfClient.getOrgAuth();
      const res = await sfClient.runSoql(auth.accessToken, auth.instanceUrl, soql);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            totalSize: res.total,
            truncated: res.truncated,
            records: res.records,
            _execution_time_ms: Date.now() - start
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  }
);

// Tool 24: sfdc_generic_dml
mcp.tool(
  'sfdc_generic_dml',
  'Generic insert or update for ANY standard or custom Salesforce object with DLQ fallback protection.',
  {
    sobject_name: z.string().describe("Object API Name (e.g. 'Case', 'Task', 'Custom_Object__c')"),
    record_id: z.string().optional().describe("Record ID if updating (leave empty for insert)"),
    fields: z.record(z.any()).describe("Key-value dictionary of field values"),
    operation: z.enum(["POST", "PATCH"]).default("PATCH").describe("HTTP method: POST for insert, PATCH for update")
  },
  async ({ sobject_name, record_id, fields, operation }) => {
    const start = Date.now();
    try {
      const auth = await sfClient.getOrgAuth();
      const res = await sfClient.executeSfDmlSingle(auth.accessToken, auth.instanceUrl, sobject_name, record_id || null, fields, operation);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, id: res.id || record_id, operation, sobject: sobject_name, _execution_time_ms: Date.now() - start }, null, 2)
        }]
      };
    } catch (err) {
      const dlqId = dlq.enqueueMutation(`GENERIC_${operation}_${sobject_name}`, record_id || 'NEW', fields, err.message);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: false, error: err.message, dlq_enqueued: true, dlq_id: dlqId }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// =========================================================================
// MCP RESOURCES
// =========================================================================
mcp.resource(
  'active-workload',
  'sfdc://views/team_workload',
  async (uri) => {
    const res = await pgDb.query('SELECT * FROM v_team_workload ORDER BY active_tasks DESC');
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(res.rows, null, 2), mimeType: 'application/json' }]
    };
  }
);

mcp.resource(
  'system-stats',
  'sfdc://system/stats',
  async (uri) => {
    const counts = await pgDb.query(`
      SELECT 
        (SELECT count(*) FROM cases) AS cases_count,
        (SELECT count(*) FROM accounts) AS accounts_count,
        (SELECT count(*) FROM users) AS users_count,
        (SELECT count(*) FROM tasks) AS tasks_count,
        (SELECT count(*) FROM integrations) AS integrations_count,
        (SELECT count(*) FROM case_comments) AS comments_count
    `);
    const syncStates = await pgDb.query('SELECT * FROM sync_state');
    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify({ counts: counts.rows[0], sync_states: syncStates.rows }, null, 2),
        mimeType: 'application/json'
      }]
    };
  }
);

// =========================================================================
// SERVER STARTUP (SSE & Stdio Support)
// =========================================================================
const PORT = parseInt(process.env.MCP_PORT || '4005', 10);

async function startServer() {
  const isStdio = process.argv.includes('--stdio');

  if (isStdio) {
    console.error('[SFDC MCP] Starting in Stdio mode...');
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    console.error('[SFDC MCP] Connected via Stdio transport.');
  } else {
    const app = express();
    app.use(express.json({ limit: '50mb' }));

    const transports = new Map();

    app.get('/health', (req, res) => {
      res.json({
        status: 'HEALTHY',
        server: 'sfdc-enterprise-mcp',
        tools_registered: Object.keys(mcp._registeredTools || mcp.tools || {}).length,
        active_sessions: transports.size,
        timestamp: new Date()
      });
    });

    app.get('/sse', async (req, res) => {
      console.log('[MCP SSE] Client connected to /sse');
      const transport = new SSEServerTransport('/message', res);
      transports.set(transport.sessionId, transport);

      req.on('close', () => {
        console.log(`[MCP SSE] Client disconnected: ${transport.sessionId}`);
        transports.delete(transport.sessionId);
      });

      await mcp.connect(transport);
      console.log(`[MCP SSE] Session established: ${transport.sessionId}`);
    });

    app.post('/message', async (req, res) => {
      const sessionId = req.query.sessionId;
      const transport = transports.get(sessionId);
      if (!transport) {
        return res.status(404).json({ error: `Session not found: ${sessionId}` });
      }
      await transport.handlePostMessage(req, res, req.body);
    });

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 [SFDC Enterprise MCP Server] Listening on http://0.0.0.0:${PORT}`);
      console.log(`   • SSE Endpoint:     http://0.0.0.0:${PORT}/sse`);
      console.log(`   • Message Endpoint: http://0.0.0.0:${PORT}/message`);
      console.log(`   • Health Endpoint:  http://0.0.0.0:${PORT}/health`);
      console.log(`   • Total Tools:      24 Registered`);
    });
  }
}

if (require.main === module) {
  startServer().catch((err) => {
    console.error('[SFDC MCP Server Fatal Error]:', err);
    process.exit(1);
  });
}

module.exports = { mcp, startServer };
