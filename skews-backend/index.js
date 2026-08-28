const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Inisialisasi Supabase Client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// 1. CLASS KALMAN FILTER (1D)
// ==========================================
class KalmanFilterGPS {
  constructor(processNoise = 1e-5, measurementNoise = 1e-2) {
    this.q = processNoise;      // Noise proses (Q)
    this.r = measurementNoise; // Noise pengukuran (R)
    this.p = 1.0;              // Error covariance (P)
  }

  // Menerima nilai mentah & nilai hasil filter sebelumnya (state)
  update(measurement, lastState) {
    let x = lastState !== null && lastState !== undefined ? lastState : measurement;

    // 1. Tahap Prediksi
    const pPrior = this.p + this.q;

    // 2. Tahap Koreksi / Update
    const kalmanGain = pPrior / (pPrior + this.r);
    x = x + kalmanGain * (measurement - x);
    this.p = (1 - kalmanGain) * pPrior;

    return x;
  }
}

const kfLat = new KalmanFilterGPS(1e-5, 1e-2);
const kfLng = new KalmanFilterGPS(1e-5, 1e-2);

// ==========================================
// 2. FUNGSI HITUNG PERGESERAN (HAVERSINE)
// ==========================================
function hitungPergeseran(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return 0;
  
  const R = 6371000; // Jari-jari bumi dalam meter
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  
  return Math.round((R * c) * 100) / 100; // Pembulatan 2 angka di belakang koma (meter)
}

// Route Utama
app.get('/', (req, res) => {
  res.send('EWS Longsor Backend Active & Running!');
});

// 1. GET: Ambil Data Sensor untuk Dashboard
app.get('/api/data', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('DATA_LOGS')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Terjadi kesalahan server internal' });
  }
});

// 2. POST: Terima Data dari Sensor / IoT EWS Longsor
app.post('/api/data', async (req, res) => {
  try {
    const { kemiringan_tanah, kelembaban_tanah, status_bahaya, latitude, longitude } = req.body;

    const currentRawLat = parseFloat(latitude) || 0;
    const currentRawLng = parseFloat(longitude) || 0;

    // A. Ambil data TERAKHIR untuk mendapatkan state Kalman Filter sebelumnya
    const { data: lastLog } = await supabase
      .from('DATA_LOGS')
      .select('filtered_lat, filtered_lng')
      .order('created_at', { ascending: false })
      .limit(1);

    const prevFilteredLat = lastLog && lastLog.length > 0 ? parseFloat(lastLog[0].filtered_lat) : null;
    const prevFilteredLng = lastLog && lastLog.length > 0 ? parseFloat(lastLog[0].filtered_lng) : null;

    // B. Proses filtering data GPS mentah
    const filteredLat = kfLat.update(currentRawLat, prevFilteredLat);
    const filteredLng = kfLng.update(currentRawLng, prevFilteredLng);

    // C. Ambil data PERTAMA di database sebagai Acuan Titik Awal (Baseline Location)
    let pergeseranMeter = 0;
    const { data: firstLog } = await supabase
      .from('DATA_LOGS')
      .select('filtered_lat, filtered_lng, latitude, longitude')
      .order('created_at', { ascending: true })
      .limit(1);

    if (firstLog && firstLog.length > 0) {
      // Gunakan koordinat baseline (pakai filtered jika ada, atau raw)
      const latAwal = parseFloat(firstLog[0].filtered_lat || firstLog[0].latitude);
      const lngAwal = parseFloat(firstLog[0].filtered_lng || firstLog[0].longitude);
      
      // Hitung jarak dari baseline menggunakan koordinat yang sudah di-filter
      pergeseranMeter = hitungPergeseran(latAwal, lngAwal, filteredLat, filteredLng);
    }

    // D. Deadband Threshold (Filter Pergeseran Semu / Noise Saat Alat Diam)
    // Jika pergeseran kurang dari 3 meter, paksa menjadi 0 meter
    if (pergeseranMeter < 3.0) {
      pergeseranMeter = 0;
    }

    // Validasi 3 Level Status (AMAN, SIAGA, BAHAYA)
    const validStatus = ['AMAN', 'SIAGA', 'BAHAYA'];
    const statusUpper = (status_bahaya || 'AMAN').toUpperCase();
    const status = validStatus.includes(statusUpper) ? statusUpper : 'AMAN';

    // E. Insert ke Database
    const { data, error } = await supabase
      .from('DATA_LOGS')
      .insert([
        {
          kemiringan_tanah: kemiringan_tanah || 0,
          kelembaban_tanah: kelembaban_tanah || 0,
          status_bahaya: status,
          latitude: currentRawLat,      // Koordinat Mentah GPS
          longitude: currentRawLng,    // Koordinat Mentah GPS
          filtered_lat: filteredLat,   // Koordinat Hasil Filter
          filtered_lng: filteredLng,   // Koordinat Hasil Filter
          pergeseran: pergeseranMeter
        }
      ])
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ success: true, message: 'Data EWS berhasil disimpan', data });
  } catch (err) {
    res.status(500).json({ error: 'Terjadi kesalahan server internal' });
  }
});

// Export untuk Vercel Serverless
module.exports = app;

// Listener Lokal
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`EWS Backend berjalan di port ${PORT}`));
        }// 1. GET: Ambil Data Sensor untuk Dashboard
app.get('/api/data', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('DATA_LOGS')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Terjadi kesalahan server internal' });
  }
});

// 2. POST: Terima Data dari Sensor / IoT EWS Longsor
app.post('/api/data', async (req, res) => {
  try {
    const { kemiringan_tanah, kelembaban_tanah, status_bahaya, latitude, longitude } = req.body;

    const currentLat = parseFloat(latitude) || 0;
    const currentLng = parseFloat(longitude) || 0;

    // Ambil data pertama di database untuk dijadikan Acuan Titik Awal (Baseline Location)
    let pergeseranMeter = 0;
    const { data: firstLog } = await supabase
      .from('DATA_LOGS')
      .select('latitude, longitude')
      .order('created_at', { ascending: true })
      .limit(1);

    if (firstLog && firstLog.length > 0) {
      const latAwal = parseFloat(firstLog[0].latitude);
      const lngAwal = parseFloat(firstLog[0].longitude);
      pergeseranMeter = hitungPergeseran(latAwal, lngAwal, currentLat, currentLng);
    }

    // Validasi 3 Level Status (AMAN, SIAGA, BAHAYA)
    const validStatus = ['AMAN', 'SIAGA', 'BAHAYA'];
    const statusUpper = (status_bahaya || 'AMAN').toUpperCase();
    const status = validStatus.includes(statusUpper) ? statusUpper : 'AMAN';

    // Insert ke Database
    const { data, error } = await supabase
      .from('DATA_LOGS')
      .insert([
        {
          kemiringan_tanah: kemiringan_tanah || 0,
          kelembaban_tanah: kelembaban_tanah || 0,
          status_bahaya: status,
          latitude: currentLat,
          longitude: currentLng,
          pergeseran: pergeseranMeter
        }
      ])
      .select();

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({ success: true, message: 'Data EWS berhasil disimpan', data });
  } catch (err) {
    res.status(500).json({ error: 'Terjadi kesalahan server internal' });
  }
});

// Export untuk Vercel Serverless
module.exports = app;

// Listener Lokal
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => console.log(`EWS Backend berjalan di port ${PORT}`));
}
