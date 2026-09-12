const { cdcClient } = require('./sf-cdc-client');

console.log('[CDC Daemon] Initializing Real-Time Push Sync Engine...');
cdcClient.start();

process.on('SIGINT', () => { cdcClient.stop(); process.exit(0); });
process.on('SIGTERM', () => { cdcClient.stop(); process.exit(0); });
