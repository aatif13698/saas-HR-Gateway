

require('dotenv').config();
const Zkteco = require('zkteco-js');
const axios = require('axios');
const express = require('express');
const cron = require('node-cron');

const app = express();

const DEVICE_IP = process.env.DEVICE_IP;
const CLOUD_URL = process.env.CLOUD_URL;
const TENANT_ID = process.env.TENANT_ID;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const DEVICE_SN = process.env.DEVICE_SN;

let device;
let isConnected = false;

console.log(`🚀 Gateway starting... Targeting device: ${DEVICE_IP}`);

async function connectToDevice() {
  // Correct parameters for SilkBio-101TC
  device = new Zkteco(DEVICE_IP, 4370, 15000, 0);   // timeout + password=0



  try {
    console.log(`🔌 Attempting connection to ${DEVICE_IP}:4370 ...`);
    await device.createSocket();
    await new Promise(r => setTimeout(r, 2000));   // extra delay for ESSL

    isConnected = true;

    // console.log("device", device);

    console.log(`✅ SUCCESS: Connected to SilkBio-101TC at ${DEVICE_IP}`);

    const name = await device.getDeviceName();

    // console.log("name", name);


    // Real-time listener
    await device.getRealTimeLogs(async (log) => {
      console.log('📍 Real-time punch received:', log);
      // await sendToCloud(log, 'real-time');
    });

  } catch (err) {
    isConnected = false;
    console.error(`❌ Connection failed to ${DEVICE_IP}:4370`);
    console.error(`   Full Error:`, err);
    console.error(`   Hint: Make sure ADMS/Cloud Server is OFF on the device`);
    setTimeout(connectToDevice, 10000);
  }
}




async function sendToCloud(logs, source) {
  if (!logs || logs.length === 0) return;

  try {
    // Convert single log to array if needed
    const logArray = Array.isArray(logs) ? logs : [logs];

    // === FILTER OUT EMPTY USER_ID LOGS ===
    const validLogs = logArray.filter(log => {
      const userId = log.userId || log.user_id;

      // Skip if userId is empty, null, undefined, or empty string
      if (!userId || userId.toString().trim() === "") {
        console.log("⛔ Skipped log with empty user_id:", log);
        return false;
      }
      return true;
    });

    if (validLogs.length === 0) {
      console.log("⚠️ All logs had empty user_id. Nothing to send.");
      return;
    }

    if (validLogs.length < logArray.length) {
      console.log(`🔍 Skipped ${logArray.length - validLogs.length} logs with empty user_id`);
    }

    // === Create payload for valid logs only ===
    const payload = validLogs.map(log => ({
      tenantId: TENANT_ID,
      deviceSN: DEVICE_SN,
      employeeCode: log.userId || log.user_id,
      punchTime: log.attTime || log.record_time,
      verifyMode: log.verifyMode || log.state,
      inOutStatus: log.inOutMode || log.type,
      source: source
    }));

    // Send batch to cloud
    await axios.post(`${CLOUD_URL}/service/api/attendance/push`, {
      logs: payload
    }, {
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
      timeout: 15000
    });

    console.log(`✅ Successfully sent ${payload.length} valid logs to cloud`);

  } catch (err) {
    console.error('❌ Cloud batch push failed:', err.message);
  }
}


async function fullHistoricalSync() {
  if (!isConnected) return console.warn('⚠️ Device not connected. Skipping sync.');

  console.log('🔄 Pulling ALL historical logs...');
  try {
    const result = await device.getAttendances();
    const logs = result.data || result;

    console.log(`📦 Fetched ${logs.length} logs from device`);

    // Send in batches of 100 (adjust as needed)
    const BATCH_SIZE = 100;
    for (let i = 0; i < logs.length; i += BATCH_SIZE) {
      const batch = logs.slice(i, i + BATCH_SIZE);
      await sendToCloud(batch, 'historical');
    }

    console.log('✅ Historical sync completed (batched)');
  } catch (err) {
    console.error('❌ Historical sync failed:', err.message);
  }
}


// async function sendToCloud(log, source) {
//   try {
//     console.log("log", log);
//     console.log("source", source);

//     await axios.post(`${CLOUD_URL}/service/api/attendance/push`, {
//       tenantId: TENANT_ID,
//       deviceSN: DEVICE_SN,
//       employeeCode: log.user_id,
//       punchTime: log.record_time,
//       verifyMode: log.state,
//       inOutStatus: log.type,
//       source: source
//     }, {
//       headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
//       timeout: 10000
//     });
//   } catch (err) {
//     console.error('❌ Cloud push failed:', err.message);
//   }
// }

// async function fullHistoricalSync() {
//   if (!isConnected) return console.warn('⚠️ Device not connected. Skipping sync.');

//   console.log('🔄 Pulling ALL historical logs...');
//   try {
//     const result = await device.getAttendances();
//     const logs = result.data || result;
//     console.log(`📦 Fetched ${logs.length} logs`);

//     console.log("logs", logs);

//     console.log("last", logs[0]);

//     const filteredLogs = logs?.filter((log) => {
//       if (log?.user_id) {
//         return log
//       }
//     });

//     console.log("filteredLogs", filteredLogs);
//     await sendToCloud(logs[0], 'historical');

//     // for (const log of logs) {
//     // await sendToCloud(log, 'historical');
//     // }
//     console.log('✅ Historical sync completed');
//   } catch (err) {
//     console.error('❌ Historical sync failed:', err.message);
//   }
// }



// API routes
app.post('/sync-full', (req, res) => { fullHistoricalSync(); res.json({ status: 'started' }); });
app.get('/health', (req, res) => res.json({ status: 'ok', connected: isConnected, deviceIP: DEVICE_IP }));

// Start
connectToDevice();
setTimeout(fullHistoricalSync, 20000);
cron.schedule('*/30 * * * *', fullHistoricalSync);

app.listen(5005, () => {
  console.log('🚀 Gateway running on port 5005');
  console.log(`📡 Cloud URL: ${CLOUD_URL}`);
});