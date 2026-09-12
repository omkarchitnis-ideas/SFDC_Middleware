const fs = require('fs');
const https = require('https');
const { URL } = require('url');

const SF_BASE_URL = process.env.SF_INSTANCE_URL || 'https://ideas-sas.lightning.force.com';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://172.27.210.162:5001';

const DEFAULT_USER_EMAILS = {
    'Omkar Chitnis': 'omkar.chitnis@ideas.com',
    'Manoj Shinde': 'manoj.shinde@ideas.com',
    'Sandesh Shahapurkar': 'sandesh.shahapurkar@ideas.com',
    'Vinay Anavatti': 'vinay.anavatti@ideas.com',
    'Saurabh Thakare': 'saurabh.thakare@ideas.com',
    'Afroz Khan': 'afroz.khan@ideas.com',
    'Swapnil Satpute': 'swapnil.satpute@ideas.com',
    'Vishal Goyal': 'vishal.goyal@ideas.com',
    'Vikash Yadav': 'vikash.yadav@ideas.com',
    'Karteek Desai': 'karteek.desai@ideas.com',
    'Kishore Fukate': 'kishore.fukate@ideas.com',
    'Omkar Shete': 'omkar.shete@ideas.com',
    'Bipinchandra Khangar': 'bipinchandra.khangar@ideas.com'
};

/**
 * Returns configured MS Teams webhook URLs with file fallback and environment priority.
 */
function getWebhookUrls() {
    let teamsUrl = process.env.TEAMS_WEBHOOK_URL || 'https://defaultb1c14d5c362545b3a4309552373a0c.2f.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/90cfbbf0586d422496aa8d0302fd8b0f/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=a1smtDot_igsI6vEQphkNhgBlNebRBkQZkzqnJd-Zow';
    let shiftSummaryUrl = process.env.TEAMS_SHIFT_SUMMARY_WEBHOOK_URL || process.env.SHIFT_SUMMARY_WEBHOOK_URL || '';

    if (fs.existsSync('teams_config.json')) {
        try {
            const cfg = JSON.parse(fs.readFileSync('teams_config.json', 'utf8'));
            if (cfg.teamsWebhookUrl) teamsUrl = cfg.teamsWebhookUrl;
            if (cfg.shiftSummaryWebhookUrl) shiftSummaryUrl = cfg.shiftSummaryWebhookUrl;
        } catch (e) {}
    }

    if (!shiftSummaryUrl) {
        shiftSummaryUrl = teamsUrl;
    }

    return { teamsUrl, shiftSummaryUrl };
}

/**
 * Returns the mapping of team member names to corporate emails for real MS Teams @mentions.
 */
function getUserEmailMap() {
    let emailMap = { ...DEFAULT_USER_EMAILS };
    if (fs.existsSync('teams_config.json')) {
        try {
            const cfg = JSON.parse(fs.readFileSync('teams_config.json', 'utf8'));
            if (cfg.userEmails && typeof cfg.userEmails === 'object') {
                emailMap = { ...emailMap, ...cfg.userEmails };
            }
        } catch (e) {}
    }
    return emailMap;
}

/**
 * Resolves a team member's corporate email.
 */
function getUserEmail(name) {
    if (!name || name === 'Unassigned' || name.toUpperCase().includes('CARE')) return null;
    const map = getUserEmailMap();
    if (map[name]) return map[name];

    const lower = name.toLowerCase().trim();
    for (const [k, v] of Object.entries(map)) {
        if (k.toLowerCase().trim() === lower) return v;
    }

    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) {
        return `${parts[0].toLowerCase()}.${parts[parts.length - 1].toLowerCase()}@ideas.com`;
    }
    return null;
}

/**
 * Registers an @mention in the Adaptive Card entities list and returns the <at>Name</at> tag.
 */
function registerMention(name, entitiesList) {
    if (!name || name === 'Unassigned' || name.toUpperCase().includes('CARE')) {
        return `**${name}**`;
    }
    const email = getUserEmail(name);
    if (!email) {
        return `**@${name}**`;
    }

    if (Array.isArray(entitiesList)) {
        if (!entitiesList.some(e => e.mentioned && (e.mentioned.id === email || e.mentioned.name === name))) {
            entitiesList.push({
                type: 'mention',
                text: `<at>${name}</at>`,
                mentioned: {
                    id: email,
                    name: name
                }
            });
        }
    }
    return `<at>${name}</at>`;
}

/**
 * Sends an HTTP POST request to Microsoft Teams / Power Automate Incoming Webhook URL.
 */
async function sendTeamsWebhook(webhookUrl, cardPayload) {
    const { teamsUrl } = getWebhookUrls();
    const targetUrl = webhookUrl || teamsUrl;
    if (!targetUrl || !targetUrl.startsWith('http')) {
        return { success: false, statusCode: 400, message: 'No valid Webhook URL provided or configured.' };
    }

    try {
        const parsedUrl = new URL(targetUrl);
        const postData = JSON.stringify(cardPayload);

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        return new Promise((resolve) => {
            const req = https.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    const ok = res.statusCode >= 200 && res.statusCode < 300;
                    resolve({
                        success: ok,
                        statusCode: res.statusCode,
                        message: ok ? 'Alert successfully dispatched to Microsoft Teams!' : `HTTP ${res.statusCode}: ${body || 'Webhook request failed'}`
                    });
                });
            });
            req.on('error', (err) => {
                console.error('[MS Teams Webhook Error]:', err.message);
                resolve({ success: false, statusCode: 500, message: `Network error: ${err.message}` });
            });
            req.write(postData);
            req.end();
        });
    } catch (err) {
        console.error('[MS Teams Webhook Exception]:', err.message);
        return { success: false, statusCode: 400, message: `Invalid Webhook URL format: ${err.message}` };
    }
}

/**
 * Helper to build clickable SFDC links.
 */
function getCaseLink(caseNum, caseId) {
    if (!caseNum || caseNum === '—') return '—';
    if (caseId) {
        return `[Case ${caseNum}](${SF_BASE_URL}/lightning/r/Case/${caseId}/view)`;
    }
    return `**Case ${caseNum}**`;
}

function getTaskLink(taskNum, taskId) {
    if (!taskNum || taskNum === '—') return '—';
    if (taskId) {
        return `[Task ${taskNum}](${SF_BASE_URL}/lightning/r/Task/${taskId}/view)`;
    }
    return `**Task ${taskNum}**`;
}

function getSubjectLine(caseNum, caseId, taskNum, taskId, subject) {
    const cLink = getCaseLink(caseNum, caseId);
    const tLink = getTaskLink(taskNum, taskId);
    return `${cLink} / ${tLink} : ${subject || 'No Subject'}`;
}

/**
 * Helper to build standardized Adaptive Card messages with MS Teams mentions support.
 */
function buildAdaptiveCardMessage({ body, entities = [], actions = [] }) {
    return {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                contentUrl: null,
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    msteams: {
                        width: 'Full',
                        entities: entities
                    },
                    body: body,
                    actions: actions.length > 0 ? actions : [
                        {
                            type: 'Action.OpenUrl',
                            title: '📊 Open IM Dashboard',
                            url: DASHBOARD_URL
                        },
                        {
                            type: 'Action.OpenUrl',
                            title: '🔗 Open Salesforce Org',
                            url: SF_BASE_URL
                        }
                    ]
                }
            }
        ]
    };
}

/**
 * Formats and dispatches Task Assignment Alerts for CARE Department to MS Teams with real mentions.
 */
async function notifyNewCareTasksAlert(newTasks, webhookUrl = '') {
    if (!newTasks || newTasks.length === 0) {
        return { success: false, statusCode: 400, message: 'No newly inserted tasks provided for alert.' };
    }

    const { teamsUrl } = getWebhookUrls();
    const targetUrl = webhookUrl || teamsUrl;

    const count = newTasks.length;
    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    const entities = [];

    const firstTask = newTasks[0];
    const firstCaseNum = firstTask.Case_Number || firstTask['Case Number'] || '—';
    const firstTaskNum = firstTask.Task_Number || firstTask['Task Number'] || '—';
    const firstCaseId = firstTask.Case_Id || firstTask.case_id;
    const firstTaskId = firstTask.Task_Id || firstTask.task_id;
    const firstSubject = firstTask.Subject || 'No Subject';

    const primarySubjectLine = getSubjectLine(firstCaseNum, firstCaseId, firstTaskNum, firstTaskId, firstSubject);

    const factList = [
        { title: '📌 First Task', value: primarySubjectLine },
        { title: '🕒 Timestamp', value: timeStr },
        { title: '📊 Total CARE Tasks', value: `${count} pending in queue` }
    ];

    const body = [
        {
            type: 'Container',
            style: 'attention',
            items: [
                {
                    type: 'TextBlock',
                    text: `🚨 NEW CARE QUEUE TASK ALERT (${count} Task${count > 1 ? 's' : ''})`,
                    weight: 'Bolder',
                    size: 'Medium',
                    color: 'Attention'
                },
                {
                    type: 'TextBlock',
                    text: `⚡ **IM Real-Time Alert Engine** • Action Required`,
                    isSubtle: true,
                    spacing: 'None'
                }
            ]
        },
        {
            type: 'FactSet',
            facts: factList
        }
    ];

    // Detailed task list container
    const taskItems = [];
    newTasks.slice(0, 5).forEach((t, i) => {
        const caseNum = t.Case_Number || t['Case Number'] || '—';
        const taskNum = t.Task_Number || t['Task Number'] || '—';
        const caseId = t.Case_Id || t.case_id;
        const taskId = t.Task_Id || t.task_id;
        const subject = t.Subject || 'No Subject';
        const property = t.Property_Name || t['Property Name'] || 'N/A';
        const chain = t.Account_Chain_Code || t['Account Chain Code'] || 'N/A';
        const assigned = t.Assigned || 'CARE Department';

        const line = getSubjectLine(caseNum, caseId, taskNum, taskId, subject);
        const ownerMention = registerMention(assigned, entities);

        taskItems.push({
            type: 'TextBlock',
            text: `**#${i + 1}** ${line}\n• *Property*: 🏢 **${property}** (\`${chain}\`)\n• *Queue*: ${ownerMention}`,
            wrap: true,
            spacing: 'Small'
        });
    });

    if (taskItems.length > 0) {
        body.push({
            type: 'Container',
            items: taskItems
        });
    }

    if (count > 5) {
        body.push({
            type: 'TextBlock',
            text: `*+${count - 5} more newly inserted tasks pinned in IM Dashboard*`,
            isSubtle: true,
            italic: true
        });
    }

    const payload = buildAdaptiveCardMessage({ body, entities });
    return await sendTeamsWebhook(targetUrl, payload);
}

/**
 * Formats and dispatches Automated Shift Handover Summary to MS Teams with REAL @mentions for roster members.
 */
async function notifyShiftSummaryAlert(shiftName, shiftStats, webhookUrl = '') {
    const { shiftSummaryUrl } = getWebhookUrls();
    const targetUrl = webhookUrl || shiftSummaryUrl;

    const shiftEmojis = {
        Morning: '🌅',
        Afternoon: '☀️',
        Night: '🌙'
    };
    const shiftHours = {
        Morning: '7:00 AM – 4:00 PM IST (Handover generated at 3:00 PM IST)',
        Afternoon: '2:00 PM – 11:00 PM IST (Handover generated at 10:00 PM IST)',
        Night: '10:30 PM – 7:00 AM IST (Handover generated at 6:00 AM IST)'
    };

    const emoji = shiftEmojis[shiftName] || '📋';
    const hoursText = shiftHours[shiftName] || 'Shift Handover';
    const entities = [];

    const uniqueRoster = Array.from(new Set(shiftStats.roster || []));
    const rosterMentions = uniqueRoster.map(m => registerMention(m, entities)).join(', ') || 'None assigned';

    const facts = [
        { title: '👥 On-Duty Roster', value: rosterMentions },
        { title: '📊 Active Shift Queue', value: `${shiftStats.activeCount || 0} active tasks pending` },
        { title: '📅 Scheduled Due Today', value: `${shiftStats.dueTodayCount || 0} due today` },
        { title: '🚨 Severe Overdue', value: `${shiftStats.overdueCount || 0} severe overdue` },
        { title: '✅ Resolved Today', value: `${shiftStats.completedTodayCount || 0} completed by roster` }
    ];

    const body = [
        {
            type: 'Container',
            style: 'emphasis',
            items: [
                {
                    type: 'TextBlock',
                    text: `${emoji} ${shiftName.toUpperCase()} SHIFT • 1-HOUR HANDOVER SUMMARY`,
                    weight: 'Bolder',
                    size: 'Medium'
                },
                {
                    type: 'TextBlock',
                    text: `🕒 **Shift Window**: ${hoursText}`,
                    isSubtle: true,
                    spacing: 'None'
                }
            ]
        },
        {
            type: 'FactSet',
            facts: facts
        }
    ];

    // Shift Leader Remarks
    if (shiftStats.shiftNotes && shiftStats.shiftNotes.trim()) {
        body.push({
            type: 'Container',
            style: 'warning',
            items: [
                {
                    type: 'TextBlock',
                    text: '📝 **Shift Leader Remarks**',
                    weight: 'Bolder'
                },
                {
                    type: 'TextBlock',
                    text: `*"${shiftStats.shiftNotes.trim()}"*`,
                    wrap: true,
                    italic: true
                }
            ]
        });
    }

    // Member depth details
    if (shiftStats.memberDepth && shiftStats.memberDepth.length > 0) {
        const seenMembers = new Set();
        const uniqueMemberDepth = shiftStats.memberDepth.filter(m => {
            if (!m.name || seenMembers.has(m.name)) return false;
            seenMembers.add(m.name);
            return true;
        });
        const memberFacts = uniqueMemberDepth.map(m => {
            const mMention = registerMention(m.name, entities);
            return {
                title: mMention,
                value: `📁 **${m.active}** Active | 🚨 **${m.overdue}** Overdue | ✅ **${m.completed}** Resolved`
            };
        });

        body.push({
            type: 'TextBlock',
            text: '👤 **Member Workload & Resolution Depth**',
            weight: 'Bolder',
            spacing: 'Medium'
        });
        body.push({
            type: 'FactSet',
            facts: memberFacts
        });
    }

    const payload = buildAdaptiveCardMessage({ body, entities });
    return await sendTeamsWebhook(targetUrl, payload);
}

/**
 * Formats and dispatches Shift Start Kickoff Summary to MS Teams with REAL @mentions.
 */
async function notifyShiftStartAlert(shiftName, shiftStats, webhookUrl = '') {
    const { shiftSummaryUrl } = getWebhookUrls();
    const targetUrl = webhookUrl || shiftSummaryUrl;

    const shiftEmojis = {
        Morning: '🌅',
        Afternoon: '☀️',
        Night: '🌙'
    };
    const shiftHours = {
        Morning: '7:00 AM – 4:00 PM IST (Shift Kickoff at 7:00 AM IST)',
        Afternoon: '2:00 PM – 11:00 PM IST (Shift Kickoff at 2:00 PM IST)',
        Night: '10:30 PM – 7:00 AM IST (Shift Kickoff at 10:30 PM IST)'
    };

    const emoji = shiftEmojis[shiftName] || '🚀';
    const hoursText = shiftHours[shiftName] || 'Shift Kickoff';
    const entities = [];

    const uniqueRoster = Array.from(new Set(shiftStats.roster || []));
    const rosterMentions = uniqueRoster.map(m => registerMention(m, entities)).join(', ') || 'None assigned';

    const facts = [
        { title: '👥 On-Duty Shift Team', value: rosterMentions },
        { title: '📊 Starting Active Queue', value: `${shiftStats.activeCount || 0} active tasks pending` },
        { title: '📅 Scheduled Today', value: `${shiftStats.dueTodayCount || 0} due today` },
        { title: '🚨 Severe Overdue', value: `${shiftStats.overdueCount || 0} severe overdue` }
    ];

    const body = [
        {
            type: 'Container',
            style: 'good',
            items: [
                {
                    type: 'TextBlock',
                    text: `${emoji} ${shiftName.toUpperCase()} SHIFT KICKOFF BRIEFING`,
                    weight: 'Bolder',
                    size: 'Medium',
                    color: 'Good'
                },
                {
                    type: 'TextBlock',
                    text: `🚀 **Shift Period**: ${hoursText}`,
                    isSubtle: true,
                    spacing: 'None'
                }
            ]
        },
        {
            type: 'FactSet',
            facts: facts
        }
    ];

    if (shiftStats.shiftNotes && shiftStats.shiftNotes.trim()) {
        body.push({
            type: 'Container',
            style: 'accent',
            items: [
                {
                    type: 'TextBlock',
                    text: '📝 **Shift Leader Remarks & Instructions**',
                    weight: 'Bolder'
                },
                {
                    type: 'TextBlock',
                    text: `*"${shiftStats.shiftNotes.trim()}"*`,
                    wrap: true,
                    italic: true
                }
            ]
        });
    }

    if (shiftStats.memberDepth && shiftStats.memberDepth.length > 0) {
        const seenMembers = new Set();
        const uniqueMemberDepth = shiftStats.memberDepth.filter(m => {
            if (!m.name || seenMembers.has(m.name)) return false;
            seenMembers.add(m.name);
            return true;
        });
        const memberFacts = uniqueMemberDepth.map(m => {
            const mMention = registerMention(m.name, entities);
            return {
                title: mMention,
                value: `📁 **${m.active}** Starting Active | 🚨 **${m.overdue}** Pending Overdue`
            };
        });

        body.push({
            type: 'TextBlock',
            text: '👤 **Initial Workload Allocation per Member**',
            weight: 'Bolder',
            spacing: 'Medium'
        });
        body.push({
            type: 'FactSet',
            facts: memberFacts
        });
    }

    const payload = buildAdaptiveCardMessage({ body, entities });
    return await sendTeamsWebhook(targetUrl, payload);
}

/**
 * Formats and dispatches Severe Overdue (>24h) Escalation Alerts to MS Teams with REAL @mentions for task owners.
 */
async function notifySevereOverdueAlert(overdueTasks, webhookUrl = '') {
    if (!overdueTasks || overdueTasks.length === 0) {
        return { success: false, statusCode: 400, message: 'No severe overdue member tasks provided.' };
    }

    const { teamsUrl } = getWebhookUrls();
    const targetUrl = webhookUrl || teamsUrl;

    const count = overdueTasks.length;
    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    const entities = [];

    const body = [
        {
            type: 'Container',
            style: 'attention',
            items: [
                {
                    type: 'TextBlock',
                    text: `🔥 SEVERE OVERDUE ESCALATION (>24 Hours)`,
                    weight: 'Bolder',
                    size: 'Medium',
                    color: 'Attention'
                },
                {
                    type: 'TextBlock',
                    text: `⚠️ **IM Escalation Engine** • High Priority Action Required`,
                    isSubtle: true,
                    spacing: 'None'
                }
            ]
        },
        {
            type: 'FactSet',
            facts: [
                { title: '🚨 Total Overdue Tasks', value: `${count} Task(s) Lying Unhandled > 24 Hours` },
                { title: '🕒 Escalation Time', value: timeStr }
            ]
        }
    ];

    const taskItems = [];
    overdueTasks.slice(0, 5).forEach((t, i) => {
        const cNum = t.Case_Number || t['Case Number'] || '—';
        const tNum = t.Task_Number || t['Task Number'] || '—';
        const cId = t.Case_Id || t.case_id;
        const tId = t.Task_Id || t.task_id;
        const subj = t.Subject || 'No Subject';
        const prop = t.Property_Name || t['Property Name'] || 'N/A';
        const chain = t.Account_Chain_Code || t['Account Chain Code'] || 'N/A';
        const assigned = t.Assigned || 'Unassigned';
        const aging = t.Aging_Hours ? `${Math.round(t.Aging_Hours)} hrs` : '> 24 hrs';

        const line = getSubjectLine(cNum, cId, tNum, tId, subj);
        const ownerMention = registerMention(assigned, entities);

        taskItems.push({
            type: 'TextBlock',
            text: `**#${i + 1}** ${line}\n• *Assigned Owner*: ${ownerMention}\n• *Aging*: ⏳ **${aging} unhandled**\n• *Property*: 🏢 **${prop}** (\`${chain}\`)`,
            wrap: true,
            spacing: 'Small'
        });
    });

    if (taskItems.length > 0) {
        body.push({
            type: 'Container',
            items: taskItems
        });
    }

    if (count > 5) {
        body.push({
            type: 'TextBlock',
            text: `*+${count - 5} more severe overdue tasks in IM Dashboard*`,
            isSubtle: true,
            italic: true
        });
    }

    const payload = buildAdaptiveCardMessage({ body, entities });
    return await sendTeamsWebhook(targetUrl, payload);
}

/**
 * Formats and dispatches Middleware Alert Cards to MS Teams.
 */
const _sfdcAlertHistory = {};
const SFDC_COOLDOWN_MS = 300000; // 5 mins

async function notifyMiddlewareAlert(title, message, severity = 'INFO', details = {}, force = false) {
    const middlewareUrl = process.env.TEAMS_MIDDLEWARE_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL;
    if (!middlewareUrl) return { success: false, message: 'No webhook URL configured' };

    const alertKey = `SFDC:${title}:${severity}`;
    const now = Date.now();
    if (!force && _sfdcAlertHistory[alertKey] && (now - _sfdcAlertHistory[alertKey] < SFDC_COOLDOWN_MS)) {
        return { success: true, message: 'Suppressed duplicate alert' };
    }
    _sfdcAlertHistory[alertKey] = now;

    let color = 'Accent';
    let emoji = 'ℹ️';
    const sev = severity.toUpperCase();
    if (sev === 'CRITICAL' || sev === 'ERROR') {
        color = 'Attention';
        emoji = '🔴';
    } else if (sev === 'WARNING') {
        color = 'Warning';
        emoji = '🟡';
    } else if (sev === 'SUCCESS') {
        color = 'Good';
        emoji = '🟢';
    }

    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    const facts = [
        { title: 'Service:', value: 'SFDC Middleware' },
        { title: 'Severity:', value: sev },
        { title: 'Timestamp:', value: timeStr }
    ];
    if (details && typeof details === 'object') {
        for (const [k, v] of Object.entries(details)) {
            facts.push({ title: `${k}:`, value: String(v) });
        }
    }

    const body = [
        {
            type: 'Container',
            items: [
                {
                    type: 'TextBlock',
                    text: `${emoji} [SFDC Middleware] ${title}`,
                    weight: 'Bolder',
                    size: 'Medium',
                    color: color
                },
                {
                    type: 'TextBlock',
                    text: message,
                    wrap: true,
                    spacing: 'Small'
                }
            ]
        },
        {
            type: 'FactSet',
            facts: facts,
            spacing: 'Medium'
        }
    ];

    const payload = buildAdaptiveCardMessage({ body, entities: [] });
    return await sendTeamsWebhook(middlewareUrl, payload);
}

module.exports = {
    getWebhookUrls,
    getUserEmailMap,
    getUserEmail,
    sendTeamsWebhook,
    notifyCareTasksAlert: notifyNewCareTasksAlert,
    notifyNewCareTasksAlert,
    notifyShiftSummaryAlert,
    notifyShiftStartAlert,
    notifySevereOverdueAlert,
    notifyMiddlewareAlert
};


