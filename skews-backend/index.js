const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json());

// ==========================================
// SUPABASE CONFIGURATION
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL atau SUPABASE_KEY belum diatur di Environment Variables!');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ==========================================
// KALMAN FILTER GPS 1D CLASS
// ==========================================
class KalmanFilterGPS {
  constructor(processNoise = 1e-5, measurementNoise = 1e-2) {
    this.q = processNoise;
    this.r = measurementNoise;
    this.p = 1.0;
  }

  update(measurement, lastState) {
    let x = (lastState !== null && lastState !== undefined) ? lastState : measurement;
    const pPrior = this.p + this.q;
    const kalmanGain = pPrior / (pPrior + this.r);
    x = x + kalmanGain * (measurement - x);
    this.p = (1 - kalmanGain) * pPrior;
    return x;
  }
}

// ==========================================
// HAVERSINE FORMULA (Menghitung Pergeseran)
// ==========================================
function hitungPergeseran(lat1, lon1, lat2, lon2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lon1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lon2)
  ) {
    return 0;
  }

  const R = 6371000; // Jari-jari bumi (meter)
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round((R * c) * 100) / 100; // Pergeseran dalam meter
}

// ==========================================
// ROUTE UTAMA
// ==========================================
app.get('/', (req, res) => {
  res.send('EWS Longsor Backend Active & Running!');
});

// ==========================================
// GET DATA SENSOR (Untuk Dashboard Frontend)
// ==========================================
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
    console.error('Get Data Error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server internal' });
  }
});

// ==========================================
// POST DATA DARI ESP32
// ==========================================
app.post('/api/data', async (req, res) => {
  try {
    const kemiringan = req.body.tilt ?? req.body.kemiringan_tanah ?? 0;
    const kelembaban = req.body.soil ?? req.body.kelembaban_tanah ?? 0;
    const statusRaw  = req.body.status ?? req.body.status_bahaya ?? 'AMAN';
    const rawLat     = req.body.lat ?? req.body.latitude ?? 0;
    const rawLng     = req.body.lng ?? req.body.longitude ?? 0;

    const currentRawLat = parseFloat(rawLat) || 0;
    const currentRawLng = parseFloat(rawLng) || 0;

    // 1. Ambil data koordinat terakhir dari Supabase untuk Kalman Filter
    const { data: lastLog } = await supabase
      .from('DATA_LOGS')
      .select('latitude, longitude')
      .order('created_at', { ascending: false })
      .limit(1);

    const prevLat = (lastLog && lastLog.length > 0) ? parseFloat(lastLog[0].latitude) : null;
    const prevLng = (lastLog && lastLog.length > 0) ? parseFloat(lastLog[0].longitude) : null;

    // Process ke Kalman Filter
    const kfLat = new KalmanFilterGPS(1e-5, 1e-2);
    const kfLng = new KalmanFilterGPS(1e-5, 1e-2);

    const filteredLat = kfLat.update(currentRawLat, prevLat);
    const filteredLng = kfLng.update(currentRawLng, prevLng);

    // 2. Hitung Pergeseran dari titik awal (Baseline Record)
    let pergeseranMeter = 0;

    const { data: firstLog } = await supabase
      .from('DATA_LOGS')
      .select('latitude, longitude')
      .order('created_at', { ascending: true })
      .limit(1);

    if (firstLog && firstLog.length > 0) {
      const latAwal = parseFloat(firstLog[0].latitude);
      const lngAwal = parseFloat(firstLog[0].longitude);

      pergeseranMeter = hitungPergeseran(
        latAwal,
        lngAwal,
        filteredLat,
        filteredLng
      );
    }

    // Deadband 5 cm (0.05 m)
    if (pergeseranMeter < 0.05) {
      pergeseranMeter = 0;
    }

    // 3. Validasi Status
    const validStatus = ['AMAN', 'SIAGA', 'BAHAYA'];
    const statusUpper = statusRaw.toString().toUpperCase();
    const status = validStatus.includes(statusUpper) ? statusUpper : 'AMAN';

    // 4. Simpan Langsung Koordinat Kalman ke kolom latitude & longitude
    const { data, error } = await supabase
      .from('DATA_LOGS')
      .insert([
        {
          kemiringan_tanah: parseFloat(kemiringan),
          kelembaban_tanah: parseFloat(kelembaban),
          status_bahaya: status,
          latitude: filteredLat,    // <-- Langsung menyimpan hasil Kalman Filter
          longitude: filteredLng,  // <-- Langsung menyimpan hasil Kalman Filter
          pergeseran: pergeseranMeter
        }
      ])
      .select();

    if (error) {
      console.error('Supabase Insert Error:', error);
      return res.status(400).json({ error: error.message });
    }

    res.status(201).json({
      success: true,
      message: 'Data EWS berhasil disimpan',
      data
    });

  } catch (err) {
    console.error('Post Data Error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan server internal' });
  }
});

// ==========================================
// EXPORT & LOCAL DEVELOPMENT
// ==========================================
module.exports = app;

const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`EWS Backend berjalan di port ${PORT}`);
  });
}
