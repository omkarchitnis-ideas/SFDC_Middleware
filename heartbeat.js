const cron = require('node-cron');
const http = require('http');
const { URL } = require('url');
const { getOrgAuth } = require('./sf-client');
const { sendTeamsWebhook, buildAdaptiveCardMessage } = require('./notifications');

function checkHttpEndpoint(urlStr, timeoutMs = 4000) {
    return new Promise((resolve) => {
        try {
            const u = new URL(urlStr);
            const req = http.request({
                hostname: u.hostname,
                port: u.port,
                path: u.pathname + (u.search || ''),
                method: 'GET',
                timeout: timeoutMs
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        statusCode: res.statusCode,
                        data: data
                    });
                });
            });
            req.on('error', (err) => resolve({ ok: false, error: err.message }));
            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, error: 'Timeout' });
            });
            req.end();
        } catch (e) {
            resolve({ ok: false, error: e.message });
        }
    });
}

async function sendDailyHeartbeat(force = false) {
    const webhookUrl = process.env.TEAMS_MIDDLEWARE_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL;
    if (!webhookUrl) {
        console.log('[Heartbeat] No Teams webhook URL configured.');
        return { success: false, message: 'No webhook URL' };
    }

    console.log('[Heartbeat] Running morning health check across all microservices...');

    // 1. Check SFDC Token
    let sfdcStatus = '🔴 Offline';
    try {
        const auth = getOrgAuth(false);
        if (auth && auth.accessToken) {
            const remainingMins = Math.max(0, Math.floor((auth.tokenExpiration - Date.now()) / 60000));
            sfdcStatus = `🟢 Active (${remainingMins}m until refresh)`;
        }
    } catch (e) {
        sfdcStatus = `🔴 Error: ${e.message}`;
    }

    // 2. Check CMA Gateway (try host.docker.internal, then 172.27.210.162)
    let cmaStatus = '🔴 Offline';
    let cmaCheck = await checkHttpEndpoint('http://host.docker.internal:8555/api/internal/needs_cookie');
    if (!cmaCheck.ok) {
        cmaCheck = await checkHttpEndpoint('http://172.27.210.162:8555/api/internal/needs_cookie');
    }
    if (cmaCheck.ok) {
        try {
            const parsed = JSON.parse(cmaCheck.data);
            if (parsed.has_cookie) {
                cmaStatus = '🟢 Active (Session Valid)';
            } else {
                cmaStatus = '🟡 Session Refreshing';
            }
        } catch (_) {
            cmaStatus = '🟢 HTTP 200 OK';
        }
    }

    // 3. Check IM Dashboard Backend
    let backendStatus = '🔴 Offline';
    let backendCheck = await checkHttpEndpoint('http://host.docker.internal:4001/health');
    if (!backendCheck.ok) {
        backendCheck = await checkHttpEndpoint('http://172.27.210.162:4001/health');
    }
    if (backendCheck.ok) {
        backendStatus = '🟢 Healthy (Port 4001)';
    }

    const allHealthy = sfdcStatus.startsWith('🟢') && cmaStatus.startsWith('🟢');
    const color = allHealthy ? 'Good' : 'Warning';
    const bannerEmoji = allHealthy ? '💚' : '🟡';
    const timeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';
    const dateStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', month: 'short', day: 'numeric' });

    const body = [
        {
            type: 'Container',
            items: [
                {
                    type: 'TextBlock',
                    text: `${bannerEmoji} Daily Middleware Heartbeat • ${allHealthy ? 'All Systems Operational' : 'Degraded Services Detected'}`,
                    weight: 'Bolder',
                    size: 'Medium',
                    color: color
                },
                {
                    type: 'TextBlock',
                    text: `Morning status report for all IDeaS enterprise gateways and microservices.`,
                    isSubtle: true,
                    spacing: 'Small'
                }
            ]
        },
        {
            type: 'FactSet',
            facts: [
                { title: 'Date & Time:', value: `${dateStr}, ${timeStr}` },
                { title: 'SFDC Token Gateway (4000):', value: sfdcStatus },
                { title: 'CMA SQL Gateway (8555):', value: cmaStatus },
                { title: 'IM Dashboard API (4001):', value: backendStatus },
                { title: 'Workstation Host:', value: '172.27.210.162' }
            ],
            spacing: 'Medium'
        }
    ];

    const payload = {
        type: 'message',
        attachments: [
            {
                contentType: 'application/vnd.microsoft.card.adaptive',
                content: {
                    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                    type: 'AdaptiveCard',
                    version: '1.4',
                    body: body
                }
            }
        ]
    };

    console.log('[Heartbeat] Dispatching morning heartbeat card to Teams...');
    return await sendTeamsWebhook(webhookUrl, payload);
}

function initHeartbeatScheduler() {
    // Schedule every day at 09:00 AM IST (Asia/Kolkata)
    cron.schedule('0 9 * * *', async () => {
        console.log('[Cron] 09:00 AM IST trigger reached. Sending daily middleware heartbeat...');
        try {
            await sendDailyHeartbeat();
        } catch (e) {
            console.error('[Cron] Failed to send daily heartbeat:', e);
        }
    }, {
        scheduled: true,
        timezone: 'Asia/Kolkata'
    });

    console.log('[Heartbeat] Daily heartbeat scheduler initialized for 09:00 AM IST (Asia/Kolkata).');
}

module.exports = {
    initHeartbeatScheduler,
    sendDailyHeartbeat
};
