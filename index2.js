require('dotenv').config();
const Zkteco = require('zkteco-js');
const axios = require('axios');
const express = require('express');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const CLOUD_URL = process.env.CLOUD_URL;
const TENANT_ID = process.env.TENANT_ID;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;

// ---------- Device Config ----------
let devicesConfig = [];
try {
  devicesConfig = JSON.parse(process.env.DEVICES || '[]');
} catch (err) {
  console.error('❌ Invalid DEVICES JSON in .env');
}

// Backward compatibility with single device
if (devicesConfig.length === 0 && process.env.DEVICE_IP) {
  devicesConfig = [{
    ip: process.env.DEVICE_IP,
    sn: process.env.DEVICE_SN || 'UNKNOWN',
    password: 0
  }];
}

if (devicesConfig.length === 0) {
  console.error('❌ No devices configured. Set DEVICES or DEVICE_IP in .env');
  process.exit(1);
}

// Map: ip → { device, isConnected, sn, config, lastError }
const deviceMap = new Map();

console.log(`🚀 Gateway starting... ${devicesConfig.length} device(s) configured`);

// ---------- Core Functions ----------

async function connectToDevice(config) {
  const { ip, sn, port = 4370, password = 0, timeout = 15000 } = config;

  // Prevent multiple concurrent connect attempts for the same IP
  if (deviceMap.has(ip) && deviceMap.get(ip).connecting) {
    return;
  }

  const entry = deviceMap.get(ip) || { isConnected: false, sn, config };
  entry.connecting = true;
  deviceMap.set(ip, entry);

  try {
    console.log(`🔌 Connecting to ${ip}:${port} (SN: ${sn}) ...`);

    const device = new Zkteco(ip, port, timeout, password);
    await device.createSocket();
    await new Promise(r => setTimeout(r, 1500)); // small delay for ESSL devices

    // Update state
    entry.device = device;
    entry.isConnected = true;
    entry.connecting = false;
    entry.lastError = null;
    entry.lastConnectedAt = new Date();
    deviceMap.set(ip, entry);

    console.log(`✅ Connected → ${ip} (SN: ${sn})`);

    // Optional: get device name
    try {
      const name = await device.getDeviceName();
      console.log(`   Device name: ${name}`);
    } catch (_) {}

    // Real-time listener (per device)
    await device.getRealTimeLogs(async (log) => {
      console.log(`📍 [${sn}] Real-time punch:`, log);
      await sendToCloud(log, 'real-time', sn);
    });

  } catch (err) {
    entry.isConnected = false;
    entry.connecting = false;
    entry.lastError = err.message;
    deviceMap.set(ip, entry);

    console.error(`❌ Failed to connect ${ip}: ${err.message}`);
    // Auto reconnect after 10 seconds
    setTimeout(() => connectToDevice(config), 10000);
  }
}

async function sendToCloud(logs, source, deviceSN) {
  if (!logs) return;

  const logArray = Array.isArray(logs) ? logs : [logs];

  // Filter empty user_id
  const validLogs = logArray.filter(log => {
    const userId = log.userId || log.user_id;
    if (!userId || userId.toString().trim() === '') {
      console.log(`⛔ [${deviceSN}] Skipped empty user_id:`, log);
      return false;
    }
    return true;
  });

  if (validLogs.length === 0) {
    console.log(`⚠️ [${deviceSN}] No valid logs to send`);
    return;
  }

  const payload = validLogs.map(log => ({
    tenantId: TENANT_ID,
    deviceSN: deviceSN,
    employeeCode: log.userId || log.user_id,
    punchTime: log.attTime || log.record_time,
    verifyMode: log.verifyMode || log.state,
    inOutStatus: log.inOutMode || log.type,
    source
  }));

  try {
    await axios.post(`${CLOUD_URL}/service/api/attendance/push`, {
      logs: payload
    }, {
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
      timeout: 20000
    });

    console.log(`✅ [${deviceSN}] Sent ${payload.length} log(s) → cloud`);
  } catch (err) {
    console.error(`❌ [${deviceSN}] Cloud push failed:`, err.message);
  }
}

async function fullHistoricalSync(targetIp = null) {
  const devicesToSync = targetIp
    ? [deviceMap.get(targetIp)].filter(Boolean)
    : Array.from(deviceMap.values());

  for (const entry of devicesToSync) {
    if (!entry?.isConnected || !entry.device) {
      console.warn(`⚠️ Skipping historical sync – ${entry?.sn || 'unknown'} not connected`);
      continue;
    }

    const { device, sn } = entry;

    try {
      console.log(`🔄 [${sn}] Pulling historical logs...`);
      const result = await device.getAttendances();
      const logs = result.data || result || [];

      console.log(`📦 [${sn}] Fetched ${logs.length} logs`);

      // Batch send
      const BATCH_SIZE = 100;
      for (let i = 0; i < logs.length; i += BATCH_SIZE) {
        const batch = logs.slice(i, i + BATCH_SIZE);
        await sendToCloud(batch, 'historical', sn);
      }

      console.log(`✅ [${sn}] Historical sync completed`);
    } catch (err) {
      console.error(`❌ [${sn}] Historical sync failed:`, err.message);
    }
  }
}

// ---------- Connect all devices ----------
async function connectAll() {
  for (const config of devicesConfig) {
    // Don't await – connect in parallel
    connectToDevice(config);
  }
}

// ---------- Routes ----------
app.get('/health', (req, res) => {
  const status = Array.from(deviceMap.entries()).map(([ip, entry]) => ({
    ip,
    sn: entry.sn,
    connected: entry.isConnected,
    lastConnectedAt: entry.lastConnectedAt,
    lastError: entry.lastError || null
  }));

  res.json({
    status: 'ok',
    totalDevices: devicesConfig.length,
    connected: status.filter(d => d.connected).length,
    devices: status
  });
});

app.post('/sync-full', (req, res) => {
  fullHistoricalSync();
  res.json({ status: 'started', message: 'Full historical sync started for all devices' });
});

app.post('/sync-full/:ip', (req, res) => {
  const { ip } = req.params;
  if (!deviceMap.has(ip)) {
    return res.status(404).json({ error: 'Device not found' });
  }
  fullHistoricalSync(ip);
  res.json({ status: 'started', message: `Historical sync started for ${ip}` });
});

app.post('/reconnect/:ip', async (req, res) => {
  const { ip } = req.params;
  const config = devicesConfig.find(d => d.ip === ip);
  if (!config) {
    return res.status(404).json({ error: 'Device not found in config' });
  }
  connectToDevice(config);
  res.json({ status: 'reconnect_started', ip });
});

// ---------- Start ----------
connectAll();

// Initial historical sync after devices have time to connect
setTimeout(() => fullHistoricalSync(), 25000);

// Periodic historical sync every 30 minutes
cron.schedule('*/30 * * * *', () => {
  console.log('⏰ Cron: starting historical sync for all devices');
  fullHistoricalSync();
});

app.listen(5005, () => {
  console.log('🚀 Multi-device Gateway running on port 5005');
  console.log(`📡 Cloud URL: ${CLOUD_URL}`);
  console.log(`📟 Devices configured: ${devicesConfig.map(d => d.ip).join(', ')}`);
});