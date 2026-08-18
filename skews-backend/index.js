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

// Route Utama
app.get('/', (req, res) => {
  res.send('EWS Longsor Backend Active & Running!');
});

// 1. GET: Ambil Data Sensor untuk Dashboard Web
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
    const { kemiringan_tanah, kelembaban_tanah, status_bahaya, lokasi_alat } = req.body;

    // Validasi 3 Level Status (AMAN, SIAGA, BAHAYA)
    const validStatus = ['AMAN', 'SIAGA', 'BAHAYA'];
    const status = validStatus.includes(status_bahaya) ? status_bahaya : 'AMAN';

    const { data, error } = await supabase
      .from('DATA_LOGS')
      .insert([
        {
          kemiringan_tanah: kemiringan_tanah || 0,
          kelembaban_tanah: kelembaban_tanah || 0,
          status_bahaya: status,
          lokasi_alat: lokasi_alat || 'SKEWS'
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
