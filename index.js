require('dotenv').config();
const Zkteco = require('zkteco-js');
const axios = require('axios');
const express = require('express');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const CLOUD_URL = process.env.CLOUD_URL;
const TENANT_ID = process.env.TENANT_ID;
const ACCESS_KEY = process.env.ACCESS_KEY;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const DEVICES_API_URL = process.env.DEVICES_API_URL || `${CLOUD_URL}/service/api/devices/${TENANT_ID}/${ACCESS_KEY}`;
const DEVICE_IP = process.env.DEVICE_IP;

// ---------- Local storage for last sync ----------
const DATA_DIR = path.join(__dirname, 'data');
const SYNC_STATE_FILE = path.join(DATA_DIR, 'sync-state.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadSyncState() {
  try {
    if (fs.existsSync(SYNC_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(SYNC_STATE_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('⚠️ Failed to load sync-state.json:', err.message);
  }
  return {};
}

function saveSyncState(state) {
  try {
    fs.writeFileSync(SYNC_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('❌ Failed to save sync-state.json:', err.message);
  }
}

let syncState = loadSyncState(); // { [deviceSN]: { lastSN: number, updatedAt: "..." } }

// ---------- Device runtime state ----------
const deviceMap = new Map();

console.log('🚀 Multi-device Gateway starting...');
console.log(`📡 Cloud URL: ${CLOUD_URL}`);
console.log(`📟 Devices API: ${DEVICES_API_URL}`);

// ---------- Fetch devices from your backend ----------
async function fetchDevicesFromAPI() {
  try {
    const res = await axios.get(DEVICES_API_URL, {
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
      timeout: 15000,
      params: { tenantId: TENANT_ID }
    });

    console.log("res devices", res.data);

    const devices = res.data.devices || res.data || [];

    console.log(`📥 Received ${devices.length} device(s) from API`);
    // return devices.map(d => ({
    //   ip: d.ipAddress || d.deviceIp,
    //   sn: d.deviceSerialNumber || d.deviceSN || d.serialNumber,
    //   port: d.port || 4370,
    //   password: d.password ?? 0,
    //   device_id: d.id
    // })).filter(d => d.ip && d.sn);
    return devices.map(d => ({
      ip: d.ipAddress || d.deviceIp,
      sn: d.deviceSerialNumber || d.deviceSN || d.serialNumber,
      port: d.port || 4370,
      password: d.password ?? 0,
      device_id: d.id,
      logsCount: d.logsCount ?? null
    })).filter(d => d.ip && d.sn);

  } catch (err) {
    console.error('❌ Failed to fetch devices from API:', err.message);
    return [];
  }
}

// ---------- Connection management ----------
async function connectToDevice(config) {
  const { ip, sn, port = 4370, password = 0, timeout = 15000, device_id } = config;

  console.log("config", config);


  if (deviceMap.has(ip) && deviceMap.get(ip).connecting) return;

  const entry = deviceMap.get(ip) || { isConnected: false, sn, config };
  entry.connecting = true;
  entry.sn = sn;
  entry.config = config;
  deviceMap.set(ip, entry);

  try {
    console.log(`🔌 Connecting → ${ip}:${port} (SN: ${sn})`);

    const device = new Zkteco(ip, port, timeout, password);
    await device.createSocket();
    await new Promise(r => setTimeout(r, 1500));

    console.log("entry", entry);


    entry.device = device;
    entry.isConnected = true;
    entry.connecting = false;
    entry.lastError = null;
    entry.lastConnectedAt = new Date();
    deviceMap.set(ip, entry);

    console.log(`✅ Connected → ${ip} (SN: ${sn})`);

    // // Real-time listener
    // await device.getRealTimeLogs(async (log) => {
    //   console.log(`📍 [${sn}] Real-time:`, log?.user_id || log?.userId, log?.attTime || log?.record_time);
    //   await processAndSendLogs([log], 'real-time', sn, device_id);
    // });

    // Real-time listener
    await device.getRealTimeLogs(async (log) => {
      console.log(`📍 [${sn}] Real-time:`, log?.user_id || log?.userId, log?.attTime || log?.record_time);
      await processAndSendLogs([log], 'real-time', sn, device_id, config.logsCount);
    });

  } catch (err) {
    entry.isConnected = false;
    entry.connecting = false;
    entry.lastError = err.message;
    deviceMap.set(ip, entry);

    console.error(`❌ Connect failed ${ip}: ${err.message}`);
    setTimeout(() => connectToDevice(config), 12000);
  }
}

async function disconnectDevice(ip) {
  const entry = deviceMap.get(ip);
  if (!entry) return;

  try {
    if (entry.device && typeof entry.device.disconnect === 'function') {
      await entry.device.disconnect();
    }
  } catch (_) { }

  deviceMap.delete(ip);
  console.log(`🔌 Disconnected device ${ip}`);
}

// ---------- Core: process + filter + BATCH send (100 records) ----------





// ---------- Core: process + filter + BATCH send (100 records) ----------
async function processAndSendLogs(logs, source, deviceSN, device_id, logsCount = null) {
  if (!logs || logs.length === 0) return;

  const logArray = Array.isArray(logs) ? logs : [logs];

  // 1. Filter empty user_id
  let validLogs = logArray.filter(log => {
    const userId = log.userId || log.user_id;
    return userId && userId.toString().trim() !== '';
  });

  if (validLogs.length === 0) return;

  // 2. Filter by last known SN — ONLY if logsCount is NOT null
  const lastInfo = syncState[deviceSN];

  if (logsCount != null && lastInfo?.lastSN != null) {
    const lastSN = Number(lastInfo.lastSN);

    // validLogs = validLogs.filter(log => {
    //   const currentSN = Number(log.sn);
    //   return !isNaN(currentSN) && currentSN > lastSN;
    // });

    const filteredLogs = [];
    for (const log of validLogs) {
      const currentSN = Number(log.sn);

      if (!isNaN(currentSN) && currentSN > lastSN) {
        filteredLogs.push(log);
      }
    }

    validLogs = filteredLogs;

    if (validLogs.length === 0) {
      console.log(`⏭️  [${deviceSN}] No new logs after last SN (${lastInfo.lastSN})`);
      return;
    }
  } else {
    console.log(`📋 [${deviceSN}] logsCount is null → sending ALL logs (no SN filter)`);
  }

  // 3. Sort by SN ascending
  // validLogs.sort((a, b) => Number(a.sn) - Number(b.sn));
  for (let i = 1; i < validLogs.length; i++) {
    const current = validLogs[i];
    const currentSn = Number(current.sn);

    let j = i - 1;

    while (j >= 0 && Number(validLogs[j].sn) > currentSn) {
      validLogs[j + 1] = validLogs[j];
      j--;
    }

    validLogs[j + 1] = current;
  }

  console.log(`📤 [${deviceSN}] Preparing to send ${validLogs.length} log(s) in batches of 100...`);

  // 4. Send in batches of 100
  const BATCH_SIZE = 100;
  let totalSent = 0;


  for (let i = 0; i < validLogs.length; i += BATCH_SIZE) {
    const batch = validLogs.slice(i, i + BATCH_SIZE);

    const payload = batch.map(log => ({
      tenantId: TENANT_ID,
      deviceSN,
      employeeCode: log.userId || log.user_id,
      punchTime: formatDate(log.attTime || log.record_time) ,
      verifyMode: log.verifyMode || log.type,
      inOutStatus: log.inOutMode || log.state,
      source,
      deviceId: device_id,
      sn: log.sn,
    }));

    console.log("payload", payload);
    

    const lastLogIndex = payload.length - 1;

    try {
      await axios.post(`${CLOUD_URL}/service/api/attendance/push`, {
        logs: payload
      }, {
        headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
        timeout: 30000
      });

     await axios.put(`${CLOUD_URL}/service/api/update/logsCount`, {
        logsCount: payload[lastLogIndex].sn, deviceId: device_id
      }, {
        headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
        timeout: 30000
      });

      totalSent += batch.length;
      console.log(`✅ [${deviceSN}] Batch sent: ${batch.length} records (Total: ${totalSent}/${validLogs.length})`);

      // Always update lastSN after successful batch
      const highestSN = batch.reduce((max, log) => {
        const s = Number(log.sn);
        return (!isNaN(s) && s > max) ? s : max;
      }, lastInfo?.lastSN || 0);

      if (highestSN > 0) {
        syncState[deviceSN] = {
          lastSN: highestSN,
          updatedAt: new Date().toISOString()
        };
        saveSyncState(syncState);
      }

      if (i + BATCH_SIZE < validLogs.length) {
        await new Promise(r => setTimeout(r, 300));
      }

    } catch (err) {
      console.error(`❌ [${deviceSN}] Batch failed (${batch.length} records):`, err.message);
      break;
    }
  }

  if (totalSent > 0) {
    console.log(`🎉 [${deviceSN}] Successfully pushed ${totalSent} log(s)`);
  }
}

// ---------- Historical sync ----------
async function fullHistoricalSync(targetIp = null) {
  const entries = targetIp
    ? [deviceMap.get(targetIp)].filter(Boolean)
    : Array.from(deviceMap.values());

  for (const entry of entries) {
    if (!entry?.isConnected || !entry.device) continue;

    console.log("entry aaa", entry);


    const { device, sn } = entry;

    try {
      console.log(`🔄 [${sn}] Pulling logs...`);
      const result = await device.getAttendances();
      const logs = result.data || result || [];

      console.log(`📦 [${sn}] Device returned ${logs.length} total logs`);
      // await processAndSendLogs(logs, 'historical', sn, entry.config.device_id);
      await processAndSendLogs(logs, 'historical', sn, entry.config.device_id, entry.config.logsCount);

    } catch (err) {
      console.error(`❌ [${sn}] Historical pull failed:`, err.message);
    }
  }
}

// ---------- Sync device list with API ----------
async function syncDeviceList() {
  const apiDevices = await fetchDevicesFromAPI();

  const apiIps = new Set(apiDevices.map(d => d.ip));

  // Connect new devices
  for (const config of apiDevices) {
    if (!deviceMap.has(config.ip) || !deviceMap.get(config.ip).isConnected) {
      connectToDevice(config);
    }
  }

  // Disconnect removed devices
  for (const [ip] of deviceMap) {
    if (!apiIps.has(ip)) {
      console.log(`🗑️  Device ${ip} removed from API → disconnecting`);
      await disconnectDevice(ip);
    }
  }
}

// ---------- Routes ----------
app.get('/health', (req, res) => {
  const devices = Array.from(deviceMap.entries()).map(([ip, e]) => ({
    ip,
    sn: e.sn,
    connected: e.isConnected,
    lastConnectedAt: e.lastConnectedAt,
    lastError: e.lastError,
    lastSN: syncState[e.sn]?.lastSN || null          // ← changed
  }));

  res.json({
    status: 'ok',
    connectedCount: devices.filter(d => d.connected).length,
    totalTracked: devices.length,
    devices
  });
});

app.post('/sync-full', (req, res) => {
  fullHistoricalSync();
  res.json({ status: 'started' });
});

app.post('/sync-full/:ip', (req, res) => {
  fullHistoricalSync(req.params.ip);
  res.json({ status: 'started', ip: req.params.ip });
});

app.get('/sync-state', (req, res) => {
  res.json(syncState);
});

app.delete('/sync-state/:sn', (req, res) => {
  delete syncState[req.params.sn];
  saveSyncState(syncState);
  res.json({ status: 'cleared', sn: req.params.sn });
});

// ---------- Boot ----------
(async () => {
  await syncDeviceList();

  // Refresh device list every 5 minutes
  setInterval(syncDeviceList, 5 * 60 * 1000);

  // Initial historical after devices connect
  setTimeout(() => fullHistoricalSync(), 20000);

  // Periodic historical every 30 minutes
  cron.schedule('*/30 * * * *', () => {
    console.log('⏰ Cron historical sync');
    fullHistoricalSync();
  });
})();

app.listen(5005, () => {
  console.log('🚀 Gateway running on port 5005');
});

function formatDate(dateString) {
  const date = new Date(dateString);

  const pad = (num) => String(num).padStart(2, '0');

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
         `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// const input = "Wed Aug 19 2026 13:19:14 GMT+0530 (India Standard Time)";

// console.log(formatDate(input));
// 2026-08-19 13:19:14


// async function processAndSendLogs(logs, source, deviceSN, device_id) {
//   if (!logs || logs.length === 0) return;

//   const logArray = Array.isArray(logs) ? logs : [logs];

//   // 1. Filter empty user_id
//   let validLogs = logArray.filter(log => {
//     const userId = log.userId || log.user_id;
//     return userId && userId.toString().trim() !== '';
//   });

//   if (validLogs.length === 0) return;

//   // 2. Filter by last known punch time (incremental)
//   const lastInfo = syncState[deviceSN];
//   if (lastInfo?.lastPunchTime) {
//     const lastTime = new Date(lastInfo.lastPunchTime).getTime();
//     validLogs = validLogs.filter(log => {
//       const punchTime = new Date(log.attTime || log.record_time).getTime();
//       return punchTime > lastTime;
//     });
//   }

//   if (validLogs.length === 0) {
//     console.log(`⏭️  [${deviceSN}] No new logs after last sync (${lastInfo?.lastPunchTime || 'none'})`);
//     return;
//   }

//   // 3. Sort by punch time ascending (very important)
//   validLogs.sort((a, b) => {
//     const t1 = new Date(a.attTime || a.record_time).getTime();
//     const t2 = new Date(b.attTime || b.record_time).getTime();
//     return t1 - t2;
//   });
// ////
//   console.log(`📤 [${deviceSN}] Preparing to send ${validLogs.length} new log(s) in batches of 100...`);

//   // 4. Send in batches of 100
//   const BATCH_SIZE = 100;
//   let totalSent = 0;

//   for (let i = 0; i < validLogs.length; i += BATCH_SIZE) {
//     const batch = validLogs.slice(i, i + BATCH_SIZE);

//     console.log("batch", batch);


//     const payload = batch.map(log => ({
//       tenantId: TENANT_ID,
//       deviceSN,
//       employeeCode: log.userId || log.user_id,
//       punchTime: log.attTime || log.record_time,
//       verifyMode: log.verifyMode || log.type,
//       inOutStatus: log.inOutMode || log.state,
//       source,
//       deviceId: device_id,
//     }));


//     try {
//       await axios.post(`${CLOUD_URL}/service/api/attendance/push`, {
//         logs: payload
//       }, {
//         headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
//         timeout: 30000
//       });

//       totalSent += batch.length;
//       console.log(`✅ [${deviceSN}] Batch sent: ${batch.length} records (Total: ${totalSent}/${validLogs.length})`);

//       // Update lastPunchTime after every successful batch
//       const newestInBatch = batch.reduce((latest, log) => {
//         const t = new Date(log.attTime || log.record_time).getTime();
//         return t > latest ? t : latest;
//       }, 0);

//       if (newestInBatch > 0) {
//         syncState[deviceSN] = {
//           lastPunchTime: new Date(newestInBatch).toISOString(),
//           updatedAt: new Date().toISOString()
//         };
//         saveSyncState(syncState);
//       }

//       // Small delay between batches (prevents overwhelming the server)
//       if (i + BATCH_SIZE < validLogs.length) {
//         await new Promise(r => setTimeout(r, 300));
//       }

//     } catch (err) {
//       console.error(`❌ [${deviceSN}] Batch failed (${batch.length} records):`, err.message);

//       // Stop further batches on error.
//       // Next run will continue from the last successfully saved punch time.
//       break;
//     }
//   }

//   if (totalSent > 0) {
//     console.log(`🎉 [${deviceSN}] Successfully pushed ${totalSent} log(s)`);
//   }
// }


// sample log format
//  {
//     sn: 671,
//     user_id: '201701',
//     record_time: 'Fri May 03 2024 18:26:15 GMT+0530 (India Standard Time)',
//     type: 1,
//     state: 0,
//     ip: '192.168.1.114'
//   }





// async function processAndSendLogs(logs, source, deviceSN, device_id) {
//   if (!logs || logs.length === 0) return;

//   const logArray = Array.isArray(logs) ? logs : [logs];

//   // 1. Filter empty user_id
//   let validLogs = logArray.filter(log => {
//     const userId = log.userId || log.user_id;
//     return userId && userId.toString().trim() !== '';
//   });

//   if (validLogs.length === 0) return;

//   // 2. Filter by last known SN (instead of time)
//   const lastInfo = syncState[deviceSN];
//   if (lastInfo?.lastSN != null) {
//     const lastSN = Number(lastInfo.lastSN);

//     validLogs = validLogs.filter(log => {
//       const currentSN = Number(log.sn);
//       return !isNaN(currentSN) && currentSN > lastSN;
//     });
//   }

//   if (validLogs.length === 0) {
//     console.log(`⏭️  [${deviceSN}] No new logs after last SN (${lastInfo?.lastSN ?? 'none'})`);
//     return;
//   }

//   // 3. Sort by SN ascending (very important)
//   // validLogs.sort((a, b) => {
//   //   return Number(a.sn) - Number(b.sn);
//   // });

//   for (let i = 0; i < validLogs.length - 1; i++) {
//     let minIndex = i;

//     for (let j = i + 1; j < validLogs.length; j++) {
//       if (Number(validLogs[j].sn) < Number(validLogs[minIndex].sn)) {
//         minIndex = j;
//       }
//     }

//     if (minIndex !== i) {
//       const temp = validLogs[i];
//       validLogs[i] = validLogs[minIndex];
//       validLogs[minIndex] = temp;
//     }
//   }

//   console.log(`📤 [${deviceSN}] Preparing to send ${validLogs.length} new log(s) in batches of 100...`);

//   // 4. Send in batches of 100
//   const BATCH_SIZE = 100;
//   let totalSent = 0;

//   for (let i = 0; i < validLogs.length; i += BATCH_SIZE) {
//     const batch = validLogs.slice(i, i + BATCH_SIZE);

//     const payload = batch.map(log => ({
//       tenantId: TENANT_ID,
//       deviceSN,
//       employeeCode: log.userId || log.user_id,
//       punchTime: log.attTime || log.record_time,
//       verifyMode: log.verifyMode || log.type,
//       inOutStatus: log.inOutMode || log.state,
//       source,
//       deviceId: device_id,
//       sn: log.sn, // optional: also send the sn to cloud if you want
//     }));

//     try {
//       await axios.post(`${CLOUD_URL}/service/api/attendance/push`, {
//         logs: payload
//       }, {
//         headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
//         timeout: 30000
//       });

//       totalSent += batch.length;
//       console.log(`✅ [${deviceSN}] Batch sent: ${batch.length} records (Total: ${totalSent}/${validLogs.length})`);

//       // Update lastSN after every successful batch (use the highest sn in this batch)
//       const highestSN = batch.reduce((max, log) => {
//         const s = Number(log.sn);
//         return (!isNaN(s) && s > max) ? s : max;
//       }, lastInfo?.lastSN || 0);

//       if (highestSN > 0) {
//         syncState[deviceSN] = {
//           lastSN: highestSN,
//           updatedAt: new Date().toISOString()
//         };
//         saveSyncState(syncState);
//       }

//       // Small delay between batches
//       if (i + BATCH_SIZE < validLogs.length) {
//         await new Promise(r => setTimeout(r, 300));
//       }

//     } catch (err) {
//       console.error(`❌ [${deviceSN}] Batch failed (${batch.length} records):`, err.message);
//       // Stop further batches on error. Next run will continue from last successfully saved SN.
//       break;
//     }
//   }

//   if (totalSent > 0) {
//     console.log(`🎉 [${deviceSN}] Successfully pushed ${totalSent} log(s)`);
//   }
// }