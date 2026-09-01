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
// SUPABASE
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('SUPABASE_URL atau SUPABASE_KEY belum diatur!');
}

const supabase = createClient(
  supabaseUrl,
  supabaseKey
);

// ==========================================
// KALMAN FILTER GPS 1D
// ==========================================
class KalmanFilterGPS {
  constructor(processNoise = 1e-5, measurementNoise = 1e-2) {
    this.q = processNoise;
    this.r = measurementNoise;
    this.p = 1.0;
  }

  update(measurement, lastState) {
    let x =
      lastState !== null && lastState !== undefined
        ? lastState
        : measurement;

    const pPrior = this.p + this.q;

    const kalmanGain =
      pPrior / (pPrior + this.r);

    x = x + kalmanGain * (measurement - x);

    this.p = (1 - kalmanGain) * pPrior;

    return x;
  }
}

const kfLat = new KalmanFilterGPS(1e-5, 1e-2);
const kfLng = new KalmanFilterGPS(1e-5, 1e-2);

// ==========================================
// HAVERSINE
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

  const R = 6371000;

  const dLat =
    (lat2 - lat1) * Math.PI / 180;

  const dLon =
    (lon2 - lon1) * Math.PI / 180;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;

  const c =
    2 * Math.atan2(
      Math.sqrt(a),
      Math.sqrt(1 - a)
    );

  return Math.round((R * c) * 100) / 100;
}

// ==========================================
// ROUTE UTAMA
// ==========================================
app.get('/', (req, res) => {
  res.send('EWS Longsor Backend Active & Running!');
});

// ==========================================
// GET DATA SENSOR
// ==========================================
app.get('/api/data', async (req, res) => {

  try {

    const { data, error } = await supabase
      .from('DATA_LOGS')
      .select('*')
      .order('created_at', {
        ascending: false
      })
      .limit(50);

    if (error) {
      return res.status(400).json({
        error: error.message
      });
    }

    res.status(200).json(data);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: 'Terjadi kesalahan server internal'
    });

  }
});

// ==========================================
// POST DATA DARI ESP32
// ==========================================
app.post('/api/data', async (req, res) => {

  try {

    const {
      kemiringan_tanah,
      kelembaban_tanah,
      status_bahaya,
      latitude,
      longitude
    } = req.body;

    // ======================================
    // DATA GPS MENTAH
    // ======================================
    const currentRawLat =
      parseFloat(latitude) || 0;

    const currentRawLng =
      parseFloat(longitude) || 0;

    // ======================================
    // AMBIL DATA TERAKHIR
    // ======================================
    const { data: lastLog } = await supabase
      .from('DATA_LOGS')
      .select(
        'filtered_lat, filtered_lng'
      )
      .order('created_at', {
        ascending: false
      })
      .limit(1);

    const prevFilteredLat =
      lastLog &&
      lastLog.length > 0
        ? parseFloat(lastLog[0].filtered_lat)
        : null;

    const prevFilteredLng =
      lastLog &&
      lastLog.length > 0
        ? parseFloat(lastLog[0].filtered_lng)
        : null;

    // ======================================
    // KALMAN FILTER
    // ======================================
    const filteredLat =
      kfLat.update(
        currentRawLat,
        prevFilteredLat
      );

    const filteredLng =
      kfLng.update(
        currentRawLng,
        prevFilteredLng
      );

    // ======================================
    // AMBIL TITIK AWAL
    // ======================================
    let pergeseranMeter = 0;

    const { data: firstLog } = await supabase
      .from('DATA_LOGS')
      .select(
        'filtered_lat, filtered_lng, latitude, longitude'
      )
      .order('created_at', {
        ascending: true
      })
      .limit(1);

    if (
      firstLog &&
      firstLog.length > 0
    ) {

      const latAwal =
        parseFloat(
          firstLog[0].filtered_lat ??
          firstLog[0].latitude
        );

      const lngAwal =
        parseFloat(
          firstLog[0].filtered_lng ??
          firstLog[0].longitude
        );

      pergeseranMeter =
        hitungPergeseran(
          latAwal,
          lngAwal,
          filteredLat,
          filteredLng
        );
    }

    // ======================================
    // DEADBAND 3 METER
    // ======================================
    if (pergeseranMeter < 3.0) {
      pergeseranMeter = 0;
    }

    // ======================================
    // VALIDASI STATUS
    // ======================================
    const validStatus = [
      'AMAN',
      'SIAGA',
      'BAHAYA'
    ];

    const statusUpper =
      (status_bahaya || 'AMAN')
        .toString()
        .toUpperCase();

    const status =
      validStatus.includes(statusUpper)
        ? statusUpper
        : 'AMAN';

    // ======================================
    // SIMPAN KE SUPABASE
    // ======================================
    const { data, error } = await supabase
      .from('DATA_LOGS')
      .insert([
        {
          kemiringan_tanah:
            kemiringan_tanah || 0,

          kelembaban_tanah:
            kelembaban_tanah || 0,

          status_bahaya:
            status,

          latitude:
            currentRawLat,

          longitude:
            currentRawLng,

          filtered_lat:
            filteredLat,

          filtered_lng:
            filteredLng,

          pergeseran:
            pergeseranMeter
        }
      ])
      .select();

    if (error) {

      console.error(error);

      return res.status(400).json({
        error: error.message
      });
    }

    res.status(201).json({
      success: true,
      message: 'Data EWS berhasil disimpan',
      data
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: 'Terjadi kesalahan server internal'
    });

  }
});

// ==========================================
// EXPORT UNTUK VERCEL
// ==========================================
module.exports = app;

// ==========================================
// LOCAL DEVELOPMENT
// ==========================================
const PORT = process.env.PORT || 3000;

if (process.env.NODE_ENV !== 'production') {

  app.listen(PORT, () => {
    console.log(
      `EWS Backend berjalan di port ${PORT}`
    );
  });

}
