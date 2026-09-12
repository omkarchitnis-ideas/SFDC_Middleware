/**
 * Salesforce -> SQLite Live Sync (Enterprise Delta & Reconciliation Engine)
 * Features: Delta Loads, Periodic Full Reconciliation, Bounce Tracking, Cold Storage Archiving, and Zero Read-Locks.
 */

const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { getOrgAuth, fetchQueryBatch, withRetry } = require('./sf-client');

const fs = require('fs');

const DB_FILE = process.env.DB_FILE || 'salesforce_data.db';
const syncDbDir = path.dirname(DB_FILE);
if (syncDbDir && syncDbDir !== '.' && !fs.existsSync(syncDbDir)) {
    fs.mkdirSync(syncDbDir, { recursive: true });
}

// Configurable Cron Schedules
const SYNC_CRON = process.env.SYNC_CRON || '*/2 * * * *';
const RECONCILIATION_CRON = process.env.RECONCILIATION_CRON || '0 */6 * * *';
const ARCHIVE_CRON = process.env.ARCHIVE_CRON || '59 23 * * *';

// Configurable Monitored Owner List
const DEFAULT_OWNERS = [
    'Saurabh Thakare', 'Afroz Khan', 'Swapnil Satpute', 'Sandesh Shahapurkar',
    'Omkar Chitnis', 'Omkar Shete', 'Manoj Shinde', 'Bipinchandra Khangar',
    'Kishore Fukate', 'Vinay Anavatti', 'care department', 'Vishal Goyal',
    'Vikash Yadav', 'Karteek Desai'
];

function getMonitoredOwnersList() {
    if (process.env.MONITORED_OWNERS) {
        return process.env.MONITORED_OWNERS.split(',').map(s => s.trim()).filter(Boolean);
    }
    return DEFAULT_OWNERS;
}

const { notifyCareTasksAlert } = require('./notifications');

// Promise wrappers for SQLite to keep code clean
const db = new sqlite3.Database(DB_FILE);
const runDb = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function (e) { e ? rej(e) : res(this) }));
const getDb = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (e, row) => e ? rej(e) : res(row)));
const allDb = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)));

async function initializeDatabase() {
    await runDb(`PRAGMA journal_mode = DELETE;`);
    await runDb(`PRAGMA busy_timeout = 10000;`);
    await runDb(`CREATE TABLE IF NOT EXISTS teams_alert_logs (task_number TEXT PRIMARY KEY, alerted_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await runDb(`
        CREATE TABLE IF NOT EXISTS tasks (
            Task_Number TEXT PRIMARY KEY, Case_Number TEXT, Product_Environment TEXT, Account_Chain_Code TEXT, Account_Number TEXT, Property_Name TEXT,
            Case_Priority TEXT, Subject TEXT, Status TEXT, Case_Status TEXT, Access_Flag TEXT, Assigned TEXT, Date TEXT, Case_Owner TEXT, 
            Last_Modified_By TEXT, Last_Modified_Time TEXT, Last_Modified_Date TEXT, Completed_Date_Time TEXT, Case_Reason TEXT,
            Bounce_Count INTEGER DEFAULT 0, Previous_Owner TEXT, Task_Id TEXT, Case_Id TEXT, Description TEXT
        )
    `);
    await runDb(`
        CREATE TABLE IF NOT EXISTS tasks_archive (
            Task_Number TEXT PRIMARY KEY, Case_Number TEXT, Product_Environment TEXT, Account_Chain_Code TEXT, Account_Number TEXT, Property_Name TEXT,
            Case_Priority TEXT, Subject TEXT, Status TEXT, Case_Status TEXT, Access_Flag TEXT, Assigned TEXT, Date TEXT, Case_Owner TEXT, 
            Last_Modified_By TEXT, Last_Modified_Time TEXT, Last_Modified_Date TEXT, Completed_Date_Time TEXT, Case_Reason TEXT,
            Bounce_Count INTEGER, Previous_Owner TEXT, Archived_At DATETIME DEFAULT CURRENT_TIMESTAMP, Task_Id TEXT, Case_Id TEXT, Description TEXT
        )
    `);
    try { await runDb(`ALTER TABLE tasks ADD COLUMN Task_Id TEXT`); } catch (e) { }
    try { await runDb(`ALTER TABLE tasks ADD COLUMN Case_Id TEXT`); } catch (e) { }
    try { await runDb(`ALTER TABLE tasks ADD COLUMN Account_Id TEXT`); } catch (e) { }
    try { await runDb(`ALTER TABLE tasks ADD COLUMN System_Mode TEXT`); } catch (e) { }
    try { await runDb(`ALTER TABLE tasks ADD COLUMN Description TEXT`); } catch (e) { }
    try { await runDb(`ALTER TABLE tasks_archive ADD COLUMN Task_Id TEXT`); } catch (e) { }
    try { await runDb(`ALTER TABLE tasks_archive ADD COLUMN Case_Id TEXT`); } catch (e) { }
    try { await runDb(`ALTER TABLE tasks_archive ADD COLUMN Account_Id TEXT`); } catch (e) { }
    try { await runDb(`ALTER TABLE tasks_archive ADD COLUMN System_Mode TEXT`); } catch (e) { }
    try { await runDb(`ALTER TABLE tasks_archive ADD COLUMN Description TEXT`); } catch (e) { }

    await runDb(`CREATE TABLE IF NOT EXISTS sync_meta (id INTEGER PRIMARY KEY, last_sync_time TEXT)`);
    await runDb(`
        CREATE TABLE IF NOT EXISTS task_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_number TEXT NOT NULL,
            case_number TEXT,
            from_owner TEXT,
            to_owner TEXT,
            status TEXT,
            changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Indexes on frequently filtered columns for pandas & SQL query performance pushdown
    await runDb(`CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(Assigned)`);
    await runDb(`CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(Status)`);
    await runDb(`CREATE INDEX IF NOT EXISTS idx_tasks_chain_code ON tasks(Account_Chain_Code)`);
    await runDb(`CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(Date)`);
    await runDb(`CREATE INDEX IF NOT EXISTS idx_tasks_completed_date ON tasks(Completed_Date_Time)`);
    await runDb(`CREATE INDEX IF NOT EXISTS idx_task_history_task_num ON task_history(task_number)`);
}

async function fetchDeltaData(accessToken, instanceUrl, lastSyncTime) {
    let allRecords = [];
    const ownerList = getMonitoredOwnersList();
    const formattedOwners = ownerList.map(o => `'${o.replace(/'/g, "\\'")}'`).join(', ');

    const ownerFilter = lastSyncTime ? '' : `(Owner.Name IN (${formattedOwners})) AND `;

    let soql = `
        SELECT
            Id, WhatId,
            TYPEOF What
                WHEN Case THEN Id, CaseNumber, AccountId, Product_Environment__c, Account_Chain_Code__c,
                                Account_Number__c, Account_Name__c, Priority, Status, Owner.Name, Reason
            END,
            Task_Number__c, Subject, Status, Access_Flag__c, Owner.Name, ActivityDate,
            LastModifiedBy.Name, Last_Modified_Time__c, LastModifiedDate, CompletedDateTime, Description
        FROM Task
        WHERE ${ownerFilter}What.Type = 'Case'
        AND (ActivityDate = NULL OR ActivityDate > 2025-12-31)


        AND (NOT Subject LIKE 'Monitor Auto Processing')
        AND (NOT Subject LIKE 'SPM Task')
        AND (NOT Subject LIKE 'Monitor')
        AND (NOT Subject LIKE 'Migration')
        AND (NOT Subject LIKE 'ROA')
        AND (NOT Subject LIKE 'SPM')
        AND (NOT Subject LIKE 'Car Park RMS')
        AND (NOT Subject LIKE 'G3-OHIP-4B Post check')
        AND (NOT Subject LIKE 'G3-OHIP-4E Monitor the property')
        AND (NOT Subject LIKE 'G3-OHIP-4D G3 DV (CPM to Assign to ROA)')
        AND (NOT Subject LIKE 'G3-OHIP-6 Add G3 System CEO')
        AND (NOT Subject LIKE 'G3-OHIP-7 System Access')
        AND (NOT Subject LIKE 'G3-OHIP-8 Client Completes AMS')
        AND (NOT Subject LIKE 'G3-9 Client Completes CCFG')
        AND (NOT Subject LIKE 'G3-OHIP-10 Post CCFG G3 DV by ROA')
        AND (NOT Subject LIKE 'G3 OHIP-11 ROA Forecast Review')
        AND (NOT Subject LIKE 'G3 OHIP-12 Open Separate Case for Restrictions Configuration')
        AND (NOT Subject LIKE 'G3-OHIP-5A Open RSS Case as applicable')
        AND (NOT Subject LIKE 'G3 OHIP-5B RMS_Create Data Analysis Workbook')
        AND (NOT Subject LIKE 'G3-OHIP-4C-Assign task to CPM')
        AND (NOT Subject LIKE 'G3-OHIP-4A Install OHIP')
        AND (NOT Subject LIKE 'G3 OHIP 3C API User Request')
        AND (NOT Subject LIKE 'G3-OHIP-3B Peer review')
        AND (NOT Subject LIKE 'G3-OHIP-3A Add Property')
        AND (NOT Subject LIKE 'G3 OHIP-2.4 Add Property In NGI')
        AND (NOT Subject LIKE 'G3 OHIP-2.3B Check OHIP Eligibility')
        AND (NOT Subject LIKE 'G3 OHIP-2.3A Check OHIP Eligibility')
        AND (NOT Subject LIKE 'G3 OHIP-2.2B Check OHIP Eligibility')
        AND (NOT Subject LIKE 'G3 OHIP-2.2A Check OHIP Eligibility')
        AND (NOT Subject LIKE 'G3 OHIP-2.1 Verify Property is added in FDS')
        AND (NOT Subject LIKE 'G3-OHIP-2 Add Client')
        AND (NOT Subject LIKE 'G3-OHIP-1C CPM to check SFDC')
        AND (NOT Subject LIKE 'G3-OHIP-1B CPM Collects Additional Information')
        AND (NOT Subject LIKE 'G3 OHIP-1A CPM Collects Parameters')
        AND (NOT Subject LIKE 'RMS_SD4')
        AND (NOT Subject LIKE 'Update Night Shift Details')
        AND (NOT Subject LIKE 'G3 DQ : Manual Push of Data to DQ AWS QuickSight')
        AND (NOT Subject LIKE 'G3- Do Not Monitor')

        AND WhatId IN (
            SELECT Id
            FROM Case
            WHERE Status NOT IN ('Waiting For Response', 'Closed')
                AND Priority NOT IN ('MS', 'M0', 'M1', 'M2')

                
                AND Reason NOT IN (
                    'Monitor Hilton Report Daily',
                    'Special Care',
                    'MGM - BDE Special care monitoring',
                    'CARE Mailbox Backup',
                    'Update BDE and IDP',
                    'Audit',
                    'RevPlan',
                    'OHIP PMS Migration',
                    'G3-HTNG-Synthetic History Build-OIQ-6 System Access',
                    'Update Night Shift Details',
                    'Hyatt Service Delivery - Daily SCRUM',
                    'EscalatedSpecial Care During Onsite training',
                    'G3 AGENT to HTNG_MIGRATION',
                    'G3 OXI to AGENT MIGRATION',
                    'Elevate',
                    'G3 OXI to HTNG MIGRATION',
                    'special care',
                    'Questionnaire',
                    'First Decision Upload',
                    'G3 Opera AGENT to Opera CLOUD MIGRATION',
                    'G3 HTNG to NGI-AGENT PMS MIGRATION',
                    'G3 HTNG to HTNG MIGRATION',
                    'G3 OHIP Data Capture and Deployment WO Component Rooms',
                    'G2 Opera NGI Agent PMS Migration',
                    'Full Decision File Upload',
                    'Data Capture Deployment- 60 Day',
                    'Data Capture',
                    'Multi INTF to SWB message status',
                    'TLUK G3 RMS Property Installation Deployment',
                    'G3- Do Not Monitor',
                    'G3-HTNG-Synthetic History Build-OIQ-6 System Access',
                    'Update Night Shift Details',
                    'Hyatt Service Delivery - Daily SCRUM',
                    'EscalatedSpecial Care During Onsite training'
                )

                AND (NOT Owner.Name LIKE 'Raviprakash Porwale')

                
                AND (NOT Subject LIKE 'SRP Attribute File Date')
                AND (NOT Subject LIKE 'Repopulate')
                AND (NOT Subject LIKE 'Elevate-Internal Audit')
                AND (NOT Subject LIKE 'Car Park RMS')
                AND (NOT Subject LIKE 'Multi INTF to SWB message status')
                AND (NOT Subject LIKE 'G3 Agent to G3 OHIP PMS Migration')
                AND (NOT Subject LIKE 'ROA Internal Project')
                AND (NOT Subject LIKE 'Extract not created or received')
                AND (NOT Subject LIKE 'Process Completed - Upload Failed')
                AND (NOT Subject LIKE 'G3 OXI to G3 OHIP PMS Migration')
                AND (NOT Subject LIKE 'G3 HTNG to G3 OHIP PMS Migration')
                AND (NOT Subject LIKE 'G3 OXI to G3 OHIP PMS Migration')
                AND (NOT Subject LIKE 'G3 HTNG to G3 OHIP Migration')

                AND Account_Chain_Code__c NOT IN ('ACC', 'RHAB', 'UNIV', 'HLTN')
                AND Product_Environment__c NOT IN ('RevPlan', 'Elevate')
        )
    `;

    // THE DELTA LOGIC: Only pull records modified since the last successful sync if not a full reconciliation run
    if (lastSyncTime) {
        soql += ` AND LastModifiedDate >= ${lastSyncTime}`;
    }

    let uriPath = `/services/data/v60.0/query?q=${encodeURIComponent(soql.trim())}`;

    while (uriPath) {
        const data = await fetchQueryBatch(accessToken, instanceUrl, uriPath);
        if (data.records) allRecords = allRecords.concat(data.records);
        uriPath = data.nextRecordsUrl ? data.nextRecordsUrl : null;
    }

    return allRecords;
}

const getVal = (obj, p) => p.split('.').reduce((acc, part) => acc && acc[part], obj) || '';

async function processRecords(records) {
    const newlyInsertedCareTasks = [];
    const monitoredList = getMonitoredOwnersList().map(s => s.toLowerCase());

    const stmt = db.prepare(`
        INSERT INTO tasks (
            Task_Number, Case_Number, Product_Environment, Account_Chain_Code, Account_Number, Property_Name, Case_Priority, Subject, 
            Status, Case_Status, Access_Flag, Assigned, Date, Case_Owner, Last_Modified_By, Last_Modified_Time, Last_Modified_Date, 
            Completed_Date_Time, Case_Reason, Bounce_Count, Previous_Owner, Task_Id, Case_Id, Account_Id, Description
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(Task_Number) DO UPDATE SET 
            Case_Number=excluded.Case_Number, Product_Environment=excluded.Product_Environment, Account_Chain_Code=excluded.Account_Chain_Code, Account_Number=excluded.Account_Number, Property_Name=excluded.Property_Name, Case_Priority=excluded.Case_Priority, Subject=excluded.Subject, Status=excluded.Status, Case_Status=excluded.Case_Status, Access_Flag=excluded.Access_Flag, Assigned=excluded.Assigned, Date=excluded.Date, Case_Owner=excluded.Case_Owner, Last_Modified_By=excluded.Last_Modified_By, Last_Modified_Time=excluded.Last_Modified_Time, Last_Modified_Date=excluded.Last_Modified_Date, Completed_Date_Time=excluded.Completed_Date_Time, Case_Reason=excluded.Case_Reason, Bounce_Count=excluded.Bounce_Count, Previous_Owner=excluded.Previous_Owner, Task_Id=excluded.Task_Id, Case_Id=excluded.Case_Id, Account_Id=excluded.Account_Id, Description=excluded.Description
    `);

    for (const record of records) {
        const taskNum = getVal(record, 'Task_Number__c');
        const newOwner = getVal(record, 'Owner.Name') || 'Unassigned';
        const taskId = getVal(record, 'Id');
        const caseId = getVal(record, 'What.Id') || getVal(record, 'WhatId');
        const accountId = getVal(record, 'What.AccountId') || getVal(record, 'AccountId');
        const status = getVal(record, 'Status');
        const completedDt = getVal(record, 'CompletedDateTime');

        const isClosed = (status && (status.toLowerCase().includes('complete') || status.toLowerCase().includes('closed'))) || Boolean(completedDt);
        const isMonitored = monitoredList.includes(newOwner.toLowerCase());

        const EXCLUDED_CASES = new Set(['00807798', '03174598', '03198506', '02763990', '03134302']);
        const caseNumber = String(getVal(record, 'What.CaseNumber') || '').trim();
        const subject = String(getVal(record, 'Subject') || '').toLowerCase();
        const propName = (getVal(record, 'What.Account_Name__c') || '').toLowerCase();
        const chainCode = (getVal(record, 'What.Account_Chain_Code__c') || '').toUpperCase();

        const isExcludedCase = EXCLUDED_CASES.has(caseNumber);
        const isExcludedSubj = subject.includes('monitor g2 for monthly os patching') || subject.includes('spm');
        const isChoiceHotels = propName.includes('choice hotels international') || chainCode === 'CHOI';

        if (isExcludedCase || isExcludedSubj || isChoiceHotels) {
            await runDb(`DELETE FROM tasks WHERE Task_Number = ?`, [taskNum]);
            await runDb(`DELETE FROM tasks_archive WHERE Task_Number = ?`, [taskNum]);
            continue;
        }

        let isCompletedToday = false;
        if (completedDt) {
            try {
                const compDateStr = new Date(completedDt).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                if (compDateStr === todayStr) {
                    isCompletedToday = true;
                }
            } catch (e) {}
        }

        // If not a monitored owner, or if completed on a previous day:
        if (!isMonitored || (isClosed && !isCompletedToday)) {
            await runDb(`DELETE FROM tasks WHERE Task_Number = ?`, [taskNum]);
            continue;
        }

        // BOUNCE TRACKER LOGIC
        const existing = await getDb(`SELECT Assigned, Bounce_Count, Previous_Owner FROM tasks WHERE Task_Number = ?`, [taskNum]);
        const isNewInsert = !existing;
        let bounceCount = existing ? existing.Bounce_Count : 0;
        let prevOwner = existing ? existing.Previous_Owner : '';

        if (existing && existing.Assigned !== newOwner && newOwner !== 'Unassigned') {
            bounceCount += 1;
            prevOwner = existing.Assigned; // Record who bounced it
            try {
                await runDb(
                    `INSERT INTO task_history (task_number, case_number, from_owner, to_owner, status) VALUES (?, ?, ?, ?, ?)`,
                    [taskNum, getVal(record, 'What.CaseNumber'), existing.Assigned, newOwner, status]
                );
            } catch (e) {}
        } else if (isNewInsert) {
            try {
                await runDb(
                    `INSERT INTO task_history (task_number, case_number, from_owner, to_owner, status) VALUES (?, ?, ?, ?, ?)`,
                    [taskNum, getVal(record, 'What.CaseNumber'), 'Initial Queue', newOwner, status]
                );
            } catch (e) {}
        }

        stmt.run(
            taskNum, getVal(record, 'What.CaseNumber'), getVal(record, 'What.Product_Environment__c'), getVal(record, 'What.Account_Chain_Code__c'), getVal(record, 'What.Account_Number__c'), getVal(record, 'What.Account_Name__c'), getVal(record, 'What.Priority'), getVal(record, 'Subject'), status, getVal(record, 'What.Status'), getVal(record, 'Access_Flag__c'), newOwner, getVal(record, 'ActivityDate'), getVal(record, 'What.Owner.Name'), getVal(record, 'LastModifiedBy.Name'), getVal(record, 'Last_Modified_Time__c'), getVal(record, 'LastModifiedDate'), completedDt, getVal(record, 'What.Reason'), bounceCount, prevOwner, taskId, caseId, accountId, getVal(record, 'Description')
        );

        if (isNewInsert && (newOwner.toUpperCase().includes('CARE') || newOwner === 'Unassigned')) {
            newlyInsertedCareTasks.push({
                Case_Number: getVal(record, 'What.CaseNumber') || '—',
                Task_Number: taskNum,
                Subject: getVal(record, 'Subject') || 'No Subject',
                Property_Name: getVal(record, 'What.Account_Name__c') || 'N/A',
                Account_Chain_Code: getVal(record, 'What.Account_Chain_Code__c') || 'N/A',
                Assigned: newOwner
            });
        }
    }
    stmt.finalize();
    return newlyInsertedCareTasks;
}

async function syncSystemModes(accessToken, instanceUrl, accountIds) {
    try {
        const rowsAcc = await allDb(`SELECT DISTINCT Account_Id FROM tasks WHERE Account_Id IS NOT NULL AND Account_Id != ''`);
        const rowsChain = await allDb(`SELECT DISTINCT Account_Chain_Code FROM tasks WHERE Account_Chain_Code IS NOT NULL AND Account_Chain_Code != ''`);

        const accList = Array.from(new Set([...(accountIds || []), ...rowsAcc.map(r => r.Account_Id)])).filter(id => id && id.length >= 15);
        const chainList = Array.from(new Set(rowsChain.map(r => r.Account_Chain_Code))).filter(c => c && c.length > 0);

        if (accList.length === 0 && chainList.length === 0) return;

        // Batch account IDs in chunks of 100 to avoid SOQL query length limits
        for (let i = 0; i < accList.length; i += 100) {
            const chunkAccs = accList.slice(i, i + 100);
            const formattedAccs = chunkAccs.map(id => `'${id}'`).join(',');
            const formattedChains = chainList.map(c => `'${c.replace(/'/g, "\\'")}'`).join(',');

            const orderSoql = `
                SELECT AccountId, Chain_Code__c, System_Mode__c, EffectiveDate, Max_Order_Product_End_Date__c, CreatedDate 
                FROM Order 
                WHERE (AccountId IN (${formattedAccs}) OR Chain_Code__c IN (${formattedChains})) 
                  AND System_Mode__c != NULL 
                ORDER BY EffectiveDate DESC, CreatedDate DESC
            `;
            try {
                const uriPath = `/services/data/v60.0/query?q=${encodeURIComponent(orderSoql.trim())}`;
                const orderData = await fetchQueryBatch(accessToken, instanceUrl, uriPath);
                const records = orderData.records || [];
                const today = new Date().toISOString().slice(0, 10);

                const accModeMap = {};
                const chainModeMap = {};

                // 1st Pass: Active Orders Today (EffectiveDate <= Today <= Max_Order_Product_End_Date__c)
                for (const r of records) {
                    const accId = r.AccountId;
                    const chainCode = r.Chain_Code__c;
                    const isActive = r.EffectiveDate <= today && (!r.Max_Order_Product_End_Date__c || r.Max_Order_Product_End_Date__c >= today);

                    if (isActive) {
                        if (accId && !accModeMap[accId]) accModeMap[accId] = r.System_Mode__c;
                        if (chainCode && !chainModeMap[chainCode]) chainModeMap[chainCode] = r.System_Mode__c;
                    }
                }

                // 2nd Pass: Fallback to Latest Order if no active window match
                for (const r of records) {
                    const accId = r.AccountId;
                    const chainCode = r.Chain_Code__c;
                    if (accId && !accModeMap[accId]) accModeMap[accId] = r.System_Mode__c;
                    if (chainCode && !chainModeMap[chainCode]) chainModeMap[chainCode] = r.System_Mode__c;
                }

                for (const [accId, mode] of Object.entries(accModeMap)) {
                    await runDb(`UPDATE tasks SET System_Mode = ? WHERE Account_Id = ?`, [mode, accId]);
                }
                for (const [chainCode, mode] of Object.entries(chainModeMap)) {
                    await runDb(`UPDATE tasks SET System_Mode = ? WHERE Account_Chain_Code = ?`, [mode, chainCode]);
                }
            } catch (e) {
                console.warn(`[syncSystemModes warning]: ${e.message}`);
            }
        }
    } catch (err) {
        console.error(`[syncSystemModes error]: ${err.message}`);
    }
}

async function syncOnce(options = {}) {
    const isFullSync = typeof options === 'boolean' ? options : !!options.isFullSync;
    const startTime = Date.now();
    const timestamp = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
    const modeLabel = isFullSync ? 'Full Reconciliation' : 'Delta';

    try {
        await initializeDatabase();

        let lastSync = null;
        if (!isFullSync) {
            const meta = await getDb(`SELECT last_sync_time FROM sync_meta WHERE id = 1`);
            lastSync = meta ? meta.last_sync_time : null;
        }

        const currentSyncTimestamp = new Date().toISOString();

        console.log(`[${timestamp}] Initiating ${modeLabel} SOQL query (Last Sync: ${lastSync || 'None/Full'})...`);
        const { accessToken, instanceUrl } = await withRetry(() => getOrgAuth());

        const records = await fetchDeltaData(accessToken, instanceUrl, lastSync);
        let newlyInsertedCareTasks = [];

        if (records.length > 0) {
            newlyInsertedCareTasks = await processRecords(records);
        }

        // Fetch & sync System Mode for active accounts from Salesforce Order object
        try {
            const accsToSync = await allDb(`SELECT DISTINCT Account_Id FROM tasks WHERE Account_Id IS NOT NULL AND Account_Id != '' AND (System_Mode IS NULL OR System_Mode = '') LIMIT 200`);
            const accIds = accsToSync.map(a => a.Account_Id).filter(Boolean);
            if (accIds.length > 0) {
                await syncSystemModes(accessToken, instanceUrl, accIds);
            }
        } catch (sysModeErr) {
            console.warn(`[${timestamp}] ⚠️ System Mode sync warning: ${sysModeErr.message}`);
        }

        if (isFullSync && records.length > 0) {
            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            const fetchedTaskNums = new Set(records.map(r => getVal(r, 'Task_Number__c')).filter(Boolean));
            const allDbTasks = await allDb(`SELECT Task_Number, Completed_Date_Time FROM tasks`);
            const staleTaskNums = allDbTasks
                .filter(t => {
                    if (fetchedTaskNums.has(t.Task_Number)) return false;
                    if (t.Completed_Date_Time) {
                        try {
                            const compDate = new Date(t.Completed_Date_Time).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                            if (compDate === todayStr) return false;
                        } catch (e) {}
                    }
                    return true;
                })
                .map(t => t.Task_Number);

            if (staleTaskNums.length > 0) {
                console.log(`[${timestamp}] 🧹 Reconciliation Pruning: Deleting ${staleTaskNums.length} older completed/reassigned tasks from SQLite...`);
                for (let i = 0; i < staleTaskNums.length; i += 400) {
                    const chunk = staleTaskNums.slice(i, i + 400);
                    const placeholders = chunk.map(() => '?').join(',');
                    await runDb(`DELETE FROM tasks WHERE Task_Number IN (${placeholders})`, chunk);
                }
            }
        }

        // Save the new watermark timestamp
        await runDb(`INSERT OR REPLACE INTO sync_meta (id, last_sync_time) VALUES (1, ?)`, [currentSyncTimestamp]);

        // On Full Sync, seed teams_alert_logs with pre-existing CARE tasks so historical tasks don't trigger new alerts
        if (isFullSync) {
            const careTasksInDb = await allDb(`SELECT Task_Number FROM tasks WHERE UPPER(Assigned) LIKE '%CARE%' OR Assigned = 'Unassigned'`);
            for (const task of careTasksInDb) {
                await runDb(`INSERT OR REPLACE INTO teams_alert_logs (task_number) VALUES (?)`, [task.Task_Number]);
            }
        }

        // MS Teams Webhook dispatch for ONLY Actionable CARE tasks (Date is blank or Date <= today)
        if (!isFullSync) {
            const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
            const { getWebhookUrls, notifyCareTasksAlert } = require('./notifications');
            const { teamsUrl } = getWebhookUrls();

            if (teamsUrl && teamsUrl.startsWith('http')) {
                try {
                    // Query unnotified CARE tasks where Date IS NULL, empty, or Date <= todayStr
                    const unalertedCareTasks = await allDb(`
                        SELECT t.* FROM tasks t 
                        LEFT JOIN teams_alert_logs a ON t.Task_Number = a.task_number 
                        WHERE (UPPER(t.Assigned) LIKE '%CARE%' OR t.Assigned = 'Unassigned') 
                        AND (t.Date IS NULL OR t.Date = '' OR substr(t.Date, 1, 10) <= ?) 
                        AND a.task_number IS NULL 
                        LIMIT 10
                    `, [todayStr]);

                    if (unalertedCareTasks.length > 0) {
                        const res = await notifyCareTasksAlert(unalertedCareTasks, teamsUrl);
                        if (res && (res === true || res.success)) {
                            for (const task of unalertedCareTasks) {
                                await runDb(`INSERT OR REPLACE INTO teams_alert_logs (task_number) VALUES (?)`, [task.Task_Number]);
                            }
                            console.log(`[${timestamp}] 📢 Dispatched MS Teams Alert Card for ${unalertedCareTasks.length} Actionable CARE Task(s) (Date blank or <= ${todayStr})`);
                        }
                    }
                } catch (notifyErr) {
                    console.error(`[${timestamp}] MS Teams notification error:`, notifyErr.message);
                }
            }
        }

        // Severe Overdue (>24h) Escalation Alert Engine (EXCLUDES CARE Department Queue & Unassigned)
        if (!isFullSync) {
            try {
                const activeTasks = await allDb(`SELECT * FROM tasks WHERE Status NOT LIKE '%Complete%'`);
                const severeOverdue = activeTasks.filter(t => {
                    const assigned = t.Assigned || '';
                    const isCareOrUnassigned = assigned.toUpperCase().includes('CARE') || assigned === 'Unassigned';
                    if (isCareOrUnassigned) return false; // DO NOT alert severe overdue for CARE queue

                    const lmd = t.Last_Modified_Date || t.Date;
                    if (!lmd) return false;
                    const hours = (Date.now() - new Date(lmd).getTime()) / (1000 * 60 * 60);
                    t.Aging_Hours = hours;
                    return hours >= 24;
                });

                if (severeOverdue.length > 0) {
                    const { getWebhookUrls, notifySevereOverdueAlert } = require('./notifications');
                    const { teamsUrl } = getWebhookUrls();
                    const unnotifiedOverdue = [];
                    for (const task of severeOverdue) {
                        const logged = await getDb(`SELECT task_number FROM teams_alert_logs WHERE task_number = ?`, [`OVERDUE_${task.Task_Number}`]);
                        if (!logged) {
                            unnotifiedOverdue.push(task);
                        }
                    }

                    if (unnotifiedOverdue.length > 0 && teamsUrl && teamsUrl.startsWith('http')) {
                        const res = await notifySevereOverdueAlert(unnotifiedOverdue, teamsUrl);
                        if (res && (res === true || res.success)) {
                            for (const task of unnotifiedOverdue) {
                                await runDb(`INSERT OR REPLACE INTO teams_alert_logs (task_number) VALUES (?)`, [`OVERDUE_${task.Task_Number}`]);
                            }
                            console.log(`[${timestamp}] 🔥 Dispatched Severe Overdue (>24h) Escalation Alert for ${unnotifiedOverdue.length} Task(s)`);
                        }
                    }
                }
            } catch (overdueErr) {
                console.error(`[${timestamp}] Severe overdue escalation error:`, overdueErr.message);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[${timestamp}] SUCCESS: ${modeLabel} Synced ${records.length} records in ${duration}s -> SQLite DB`);
    } catch (err) {
        console.error(`[${timestamp}] ERROR: ${modeLabel} Sync failed:`, err.message);
    }
}

async function dispatchShiftSummary(shiftName, customWebhookUrl = null) {
    const { getWebhookUrls, notifyShiftSummaryAlert } = require('./notifications');
    const { shiftSummaryUrl } = getWebhookUrls();
    const targetUrl = customWebhookUrl || shiftSummaryUrl;
    if (!targetUrl || !targetUrl.startsWith('http')) {
        return { success: false, statusCode: 400, message: 'No valid Shift Summary Webhook URL configured.' };
    }

    try {
        let shiftRoster = {
            Morning: ["Manoj Shinde", "Omkar Chitnis", "Vinay Anavatti"],
            Afternoon: ["Afroz Khan", "Bipinchandra Khangar", "Kishore Fukate", "Omkar Shete", "Sandesh Shahapurkar", "Vishal Goyal"],
            Night: ["Saurabh Thakare", "Karteek Desai", "Swapnil Satpute", "Vikash Yadav"]
        };
        if (fs.existsSync('shift_config.json')) {
            try { shiftRoster = JSON.parse(fs.readFileSync('shift_config.json', 'utf8')); } catch (e) {}
        }

        let shiftNotes = '';
        if (fs.existsSync('shift_notes.json')) {
            try {
                const notesObj = JSON.parse(fs.readFileSync('shift_notes.json', 'utf8'));
                shiftNotes = notesObj[shiftName] || '';
            } catch (e) {}
        }

        const members = shiftRoster[shiftName] || [];
        const activeTasks = await allDb(`SELECT * FROM tasks`);

        let rosterActiveCount = 0;
        let rosterDueTodayCount = 0;
        let rosterOverdueCount = 0;
        let rosterCompletedTodayCount = 0;
        const memberDepth = [];

        const todayStr = new Date().toISOString().slice(0, 10);

        for (const member of members) {
            const memberActive = activeTasks.filter(t => t.Assigned === member && !String(t.Status || '').toLowerCase().includes('complete'));
            const memberOverdue = memberActive.filter(t => {
                const lmd = t.Last_Modified_Date || t.Date;
                if (!lmd) return false;
                const hours = (Date.now() - new Date(lmd).getTime()) / (1000 * 60 * 60);
                return hours >= 12;
            });
            const memberDueToday = memberActive.filter(t => String(t.Date || '').trim().slice(0, 10) === todayStr);
            const memberCompleted = activeTasks.filter(t => t.Assigned === member && String(t.Status || '').toLowerCase().includes('complete'));

            rosterActiveCount += memberActive.length;
            rosterDueTodayCount += memberDueToday.length;
            rosterOverdueCount += memberOverdue.length;
            rosterCompletedTodayCount += memberCompleted.length;

            memberDepth.push({
                name: member,
                active: memberActive.length,
                overdue: memberOverdue.length,
                completed: memberCompleted.length
            });
        }

        const shiftStats = {
            roster: members,
            activeCount: rosterActiveCount,
            dueTodayCount: rosterDueTodayCount,
            overdueCount: rosterOverdueCount,
            completedTodayCount: rosterCompletedTodayCount,
            memberDepth,
            shiftNotes
        };

        const res = await notifyShiftSummaryAlert(shiftName, shiftStats, targetUrl);
        console.log(`[Shift Summary] Dispatched 1-hour handover summary for ${shiftName} Shift to Microsoft Teams`);
        return res;
    } catch (err) {
        console.error(`[Shift Summary Error]:`, err.message);
        return { success: false, statusCode: 500, message: err.message };
    }
}

async function dispatchShiftStart(shiftName, customWebhookUrl = null) {
    const { getWebhookUrls, notifyShiftStartAlert } = require('./notifications');
    const { shiftSummaryUrl } = getWebhookUrls();
    const targetUrl = customWebhookUrl || shiftSummaryUrl;
    if (!targetUrl || !targetUrl.startsWith('http')) {
        return { success: false, statusCode: 400, message: 'No valid Shift Summary Webhook URL configured.' };
    }

    try {
        let shiftRoster = {
            Morning: ["Manoj Shinde", "Omkar Chitnis", "Vinay Anavatti"],
            Afternoon: ["Afroz Khan", "Bipinchandra Khangar", "Kishore Fukate", "Omkar Shete", "Sandesh Shahapurkar", "Vishal Goyal"],
            Night: ["Saurabh Thakare", "Karteek Desai", "Swapnil Satpute", "Vikash Yadav"]
        };
        if (fs.existsSync('shift_config.json')) {
            try { shiftRoster = JSON.parse(fs.readFileSync('shift_config.json', 'utf8')); } catch (e) {}
        }

        let shiftNotes = '';
        if (fs.existsSync('shift_notes.json')) {
            try {
                const notesObj = JSON.parse(fs.readFileSync('shift_notes.json', 'utf8'));
                shiftNotes = notesObj[shiftName] || '';
            } catch (e) {}
        }

        const members = shiftRoster[shiftName] || [];
        const activeTasks = await allDb(`SELECT * FROM tasks`);

        let rosterActiveCount = 0;
        let rosterDueTodayCount = 0;
        let rosterOverdueCount = 0;
        const memberDepth = [];

        const todayStr = new Date().toISOString().slice(0, 10);

        for (const member of members) {
            const memberActive = activeTasks.filter(t => t.Assigned === member && !String(t.Status || '').toLowerCase().includes('complete'));
            const memberOverdue = memberActive.filter(t => {
                const lmd = t.Last_Modified_Date || t.Date;
                if (!lmd) return false;
                const hours = (Date.now() - new Date(lmd).getTime()) / (1000 * 60 * 60);
                return hours >= 12;
            });
            const memberDueToday = memberActive.filter(t => String(t.Date || '').trim().slice(0, 10) === todayStr);

            rosterActiveCount += memberActive.length;
            rosterDueTodayCount += memberDueToday.length;
            rosterOverdueCount += memberOverdue.length;

            memberDepth.push({
                name: member,
                active: memberActive.length,
                overdue: memberOverdue.length
            });
        }

        const shiftStats = {
            roster: members,
            activeCount: rosterActiveCount,
            dueTodayCount: rosterDueTodayCount,
            overdueCount: rosterOverdueCount,
            memberDepth,
            shiftNotes
        };

        const res = await notifyShiftStartAlert(shiftName, shiftStats, targetUrl);
        console.log(`[Shift Start] Dispatched kickoff summary for ${shiftName} Shift to Microsoft Teams`);
        return res;
    } catch (err) {
        console.error(`[Shift Start Error]:`, err.message);
        return { success: false, statusCode: 500, message: err.message };
    }
}

module.exports = { syncOnce, initializeDatabase, dispatchShiftSummary, dispatchShiftStart };

// STRICT PM2 CHECK: Ensures only the background worker runs the cron schedule
if (process.env.name === 'soql-sync' || require.main === module) {

    // 1. HISTORICAL ARCHIVING CRON: Runs daily at 11:59 PM to push completed tasks to cold storage
    cron.schedule(ARCHIVE_CRON, async () => {
        console.log('Initiating Midnight Cold Storage Archiving...');
        try {
            await runDb(`INSERT OR IGNORE INTO tasks_archive SELECT *, CURRENT_TIMESTAMP FROM tasks WHERE Status LIKE '%Complete%'`);
            await runDb(`DELETE FROM tasks WHERE Status LIKE '%Complete%'`);
            console.log('Archive successful. Live table cleared of completed tasks.');
        } catch (err) {
            console.error('Archive failed:', err.message);
        }
    }, {
        timezone: "Asia/Kolkata"
    });

    // 2. RECONCILIATION CRON: Periodically does a full (non-delta) sync to catch any records missed due to clock skew or timezone edge cases
    cron.schedule(RECONCILIATION_CRON, async () => {
        console.log('Initiating Scheduled Full Reconciliation Sync...');
        await syncOnce({ isFullSync: true });
    }, {
        timezone: "Asia/Kolkata"
    });

    // 3. SHIFT START KICKOFF SUMMARY CRONS (At Shift Start Time in IST)
    // Morning Shift Start (7:00 AM IST)
    cron.schedule('0 7 * * *', () => dispatchShiftStart('Morning'), { timezone: "Asia/Kolkata" });

    // Afternoon Shift Start (2:00 PM IST)
    cron.schedule('0 14 * * *', () => dispatchShiftStart('Afternoon'), { timezone: "Asia/Kolkata" });

    // Night Shift Start (10:30 PM IST)
    cron.schedule('30 22 * * *', () => dispatchShiftStart('Night'), { timezone: "Asia/Kolkata" });

    // 4. SHIFT HANDOVER SUMMARY CRONS (1 Hour Before Shift End in IST)
    // Morning Shift (7:00 AM - 4:00 PM IST) -> 3:00 PM IST (15:00)
    cron.schedule('0 15 * * *', () => dispatchShiftSummary('Morning'), { timezone: "Asia/Kolkata" });

    // Afternoon Shift (2:00 PM - 11:00 PM IST) -> 10:00 PM IST (22:00)
    cron.schedule('0 22 * * *', () => dispatchShiftSummary('Afternoon'), { timezone: "Asia/Kolkata" });

    // Night Shift (10:30 PM - 7:00 AM IST) -> 6:00 AM IST (06:00)
    cron.schedule('0 6 * * *', () => dispatchShiftSummary('Night'), { timezone: "Asia/Kolkata" });

    // 5. REGULAR DELTA SYNC: Polls modified records every 2 minutes
    syncOnce({ isFullSync: false });
    cron.schedule(SYNC_CRON, () => syncOnce({ isFullSync: false }));

    console.log('--- Enterprise Delta & Reconciliation Engine Active ---');
    console.log(`Delta schedule: ${SYNC_CRON} | Reconciliation schedule: ${RECONCILIATION_CRON} | Archive schedule: ${ARCHIVE_CRON}`);
}
