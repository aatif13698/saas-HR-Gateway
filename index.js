// index.js  (Gateway)
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
  device = new Zkteco(DEVICE_IP, 4370, 10000, 4000);   // ← Correct parameters

  console.log("device", device);
  

  try {
    console.log(`🔌 Connecting to ${DEVICE_IP}:4370 ...`);
    await device.createSocket();
    await new Promise(r => setTimeout(r, 1500));   // small delay needed

    isConnected = true;
    console.log(`✅ SUCCESS: Connected to SilkBio-101TC`);

    // Real-time listener
    await device.getRealTimeLogs(async (log) => {
      console.log('📍 Real-time punch:', log);
      await sendToCloud(log, 'real-time');
    });

  } catch (err) {
    console.log("err", err);
    
    isConnected = false;
    console.error(`❌ Connection failed to ${DEVICE_IP}:4370`);
    console.error(`   Error: ${err.message}`);
    // setTimeout(connectToDevice, 10000);
  }
}

async function sendToCloud(log, source) {
  try {
    await axios.post(`${CLOUD_URL}/api/attendance/push`, {
      tenantId: TENANT_ID,
      deviceSN: DEVICE_SN,
      employeeCode: log.userId,
      punchTime: log.attTime,
      verifyMode: log.verifyMode,
      inOutStatus: log.inOutMode,
      source: source
    }, {
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
      timeout: 10000
    });
  } catch (err) {
    console.error('❌ Cloud push failed:', err.message);
  }
}

async function fullHistoricalSync() {
  if (!isConnected) return console.warn('⚠️ Device not connected. Skipping sync.');

  console.log('🔄 Pulling ALL historical logs...');
  try {
    const result = await device.getAttendances();
    const logs = result.data || result;
    console.log(`📦 Fetched ${logs.length} logs`);

    for (const log of logs) {
      await sendToCloud(log, 'historical');
    }
    console.log('✅ Historical sync completed');
  } catch (err) {
    console.error('❌ Historical sync failed:', err.message);
  }
}

// API routes
app.post('/sync-full', (req, res) => { fullHistoricalSync(); res.json({ status: 'started' }); });
app.get('/health', (req, res) => res.json({ status: 'ok', connected: isConnected, deviceIP: DEVICE_IP }));

// Start
connectToDevice();
setTimeout(fullHistoricalSync, 20000);
cron.schedule('*/30 * * * *', fullHistoricalSync);

app.listen(8080, () => {
  console.log('🚀 Gateway running on port 5005');
  console.log(`📡 Cloud URL: ${CLOUD_URL}`);
});