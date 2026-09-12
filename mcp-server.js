/**
 * Salesforce Middleware Model Context Protocol (MCP) Server
 * 
 * Exposes the PostgreSQL Salesforce Clone (salesforce_clone on sicsappsina6:5433),
 * live 1-minute delta sync, and DLQ-resilient mutations to Ohm Agent, Claude Desktop,
 * Cursor, and other MCP clients.
 * 
 * Supports:
 * - HTTP / Server-Sent Events (SSE) Transport (default via /sse on port 4001 or mounted in api-server.js)
 * - Stdio Transport (when run via CLI with --stdio)
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
  name: 'sfdc-middleware-mcp',
  version: '1.0.0',
  description: 'Enterprise Salesforce ODS & Clone MCP Server for Ohm Agent'
});

// =========================================================================
// TOOL 1: sfdc_get_case
// =========================================================================
mcp.tool(
  'sfdc_get_case',
  'Retrieve complete details for a Salesforce Case from PostgreSQL clone in <5ms. Includes all 557 fields and case comments.',
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
        content: [{ type: 'text', text: JSON.stringify({ found: false, message: `Case not found in clone database for query: ${case_number || case_id}` }) }]
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

    // Resolve owner details from 54k user directory
    let ownerDetails = null;
    if (caseData.owner_id) {
      const uRes = await pgDb.query('SELECT user_id, name, email, username, is_active FROM users WHERE user_id = $1 LIMIT 1', [caseData.owner_id]);
      if (uRes.rows.length > 0) {
        ownerDetails = uRes.rows[0];
      }
    }

    const durationMs = Date.now() - start;
    const responsePayload = {
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
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(responsePayload, null, 2) }]
    };
  }
);

// =========================================================================
// TOOL 2: sfdc_search_cases
// =========================================================================
mcp.tool(
  'sfdc_search_cases',
  'Search and filter historical or active Salesforce cases using indexed attributes (account chain code, property name, product environment, status).',
  {
    account_chain_code: z.string().optional().describe("Client Chain Code (e.g. 'HYATT', 'MAR', 'IHG')"),
    property_name: z.string().optional().describe("Hotel/Property Name or partial string"),
    product_environment: z.string().optional().describe("Product Environment (e.g. 'PROD', 'TEST')"),
    status: z.string().optional().describe("Case Status ('Open', 'Closed', etc.)"),
    limit: z.number().optional().default(20).describe("Maximum number of records to return (max 100)")
  },
  async ({ account_chain_code, property_name, product_environment, status, limit }) => {
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

// =========================================================================
// TOOL 3: sfdc_resolve_user
// =========================================================================
mcp.tool(
  'sfdc_resolve_user',
  'Resolve any past or present engineer, consultant, or queue from the complete 54k Salesforce user directory.',
  {
    query: z.string().describe("User ID ('005...'), Name (e.g. 'Omkar Chitnis'), Email, or Username"),
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
    const durationMs = Date.now() - start;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          query: q,
          count: res.rows.length,
          users: res.rows,
          _query_time_ms: durationMs
        }, null, 2)
      }]
    };
  }
);

// =========================================================================
// TOOL 4: sfdc_get_tasks_queue
// =========================================================================
mcp.tool(
  'sfdc_get_tasks_queue',
  'Retrieve open/pending tasks from the live operational queue with related case and property context.',
  {
    status: z.string().optional().describe("Filter by Task Status (e.g. 'Open', 'In Progress')"),
    assigned: z.string().optional().describe("Filter by assigned user or queue"),
    limit: z.number().optional().default(50).describe("Maximum records to return (max 100)")
  },
  async ({ status, assigned, limit }) => {
    const start = Date.now();
    const conditions = [];
    const params = [];
    let idx = 1;

    if (status) {
      conditions.push(`status ILIKE $${idx++}`);
      params.push(status.trim());
    }
    if (assigned) {
      conditions.push(`assigned ILIKE $${idx++}`);
      params.push(`%${assigned.trim()}%`);
    }

    const maxRows = Math.min(Math.max(limit || 50, 1), 100);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `
      SELECT task_id, task_number, case_number, subject, status, assigned,
             product_environment, account_chain_code, property_name,
             case_priority, bounce_count, created_date, last_modified_date
      FROM tasks
      ${whereClause}
      ORDER BY last_modified_date DESC
      LIMIT ${maxRows}
    `;

    const res = await pgDb.query(sql, params);
    const durationMs = Date.now() - start;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          count: res.rows.length,
          tasks: res.rows,
          _query_time_ms: durationMs
        }, null, 2)
      }]
    };
  }
);

// =========================================================================
// TOOL 5: sfdc_get_team_workload
// =========================================================================
mcp.tool(
  'sfdc_get_team_workload',
  'Retrieve live aggregated team and queue workload metrics from the pre-computed v_team_workload enterprise view.',
  {},
  async () => {
    const start = Date.now();
    const res = await pgDb.query('SELECT * FROM v_team_workload ORDER BY active_tasks DESC');
    const durationMs = Date.now() - start;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          workload: res.rows,
          _query_time_ms: durationMs
        }, null, 2)
      }]
    };
  }
);

// =========================================================================
// TOOL 6: sfdc_reassign_task (with DLQ Protection)
// =========================================================================
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
            text: JSON.stringify({
              success: false,
              error: `Could not resolve '${new_assignee_name}' to an active Salesforce User or Queue.`
            })
          }],
          isError: true
        };
      }

      // Live DML to Salesforce
      await sfClient.executeSfDmlSingle(
        (await sfClient.getOrgAuth()).accessToken,
        (await sfClient.getOrgAuth()).instanceUrl,
        'Task',
        task_id,
        { OwnerId: targetOwnerId },
        'PATCH'
      );

      // Instant write-through to PostgreSQL
      await pgDb.query(
        'UPDATE tasks SET assigned = $1, owner_id = $2, last_modified_date = CURRENT_TIMESTAMP, synced_at = CURRENT_TIMESTAMP WHERE task_id = $3',
        [new_assignee_name, targetOwnerId, task_id]
      );

      const durationMs = Date.now() - start;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            task_id,
            new_assignee_name,
            target_owner_id: targetOwnerId,
            status: 'UPDATED',
            _execution_time_ms: durationMs
          }, null, 2)
        }]
      };
    } catch (err) {
      const dlqId = dlq.enqueueMutation('TASK_REASSIGN', task_id, { new_assignee: new_assignee_name }, err.message);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: false,
            task_id,
            error: err.message,
            dlq_enqueued: true,
            dlq_id: dlqId,
            message: 'Task update failed upstream; safely enqueued in DLQ for automatic background replay.'
          }, null, 2)
        }],
        isError: true
      };
    }
  }
);

// =========================================================================
// TOOL 7: sfdc_query_clone (Read-Only SQL Sandbox)
// =========================================================================
mcp.tool(
  'sfdc_query_clone',
  'Execute a read-only SQL query against the PostgreSQL salesforce_clone database. Permitted on cases, tasks, accounts, users, and enterprise views.',
  {
    sql: z.string().describe("SQL SELECT statement (e.g. 'SELECT count(*), status FROM cases GROUP BY status')")
  },
  async ({ sql }) => {
    const trimmed = sql.trim();
    if (!trimmed.toLowerCase().startsWith('select') && !trimmed.toLowerCase().startsWith('with')) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'Security violation: Only read-only SELECT or WITH statements are permitted.' }) }],
        isError: true
      };
    }

    const start = Date.now();
    try {
      const res = await pgDb.query(trimmed);
      const durationMs = Date.now() - start;
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            rowCount: res.rows.length,
            rows: res.rows,
            _execution_time_ms: durationMs
          }, null, 2)
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
// MCP RESOURCES
// =========================================================================
mcp.resource(
  'active-workload',
  'sfdc://views/team_workload',
  async (uri) => {
    const res = await pgDb.query('SELECT * FROM v_team_workload ORDER BY active_tasks DESC');
    return {
      contents: [{
        uri: uri.href,
        text: JSON.stringify(res.rows, null, 2),
        mimeType: 'application/json'
      }]
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
const PORT = parseInt(process.env.MCP_PORT || '4001', 10);

async function startServer() {
  const isStdio = process.argv.includes('--stdio');

  if (isStdio) {
    console.error('[SFDC MCP] Starting in Stdio mode...');
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    console.error('[SFDC MCP] Connected via Stdio transport.');
  } else {
    const app = express();
    app.use(express.json());

    const transports = new Map();

    app.get('/health', (req, res) => {
      res.json({
        status: 'HEALTHY',
        server: 'sfdc-middleware-mcp',
        active_sessions: transports.size,
        timestamp: new Date()
      });
    });

    app.get('/sse', async (req, res) => {
      console.log('[MCP SSE] Client connecting to /sse');
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
      console.log(`🚀 [SFDC MCP Server] Listening on http://0.0.0.0:${PORT}`);
      console.log(`   • SSE Endpoint:     http://0.0.0.0:${PORT}/sse`);
      console.log(`   • Message Endpoint: http://0.0.0.0:${PORT}/message`);
      console.log(`   • Health Endpoint:  http://0.0.0.0:${PORT}/health`);
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
