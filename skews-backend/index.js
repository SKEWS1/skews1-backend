const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Inisialisasi Supabase Client dari Environment Variables Vercel
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Route Utama / Tes
app.get('/', (req, res) => {
  res.send('Server Backend Express & Supabase Berhasil Jalan!');
});

// Endpoint untuk Mengambil Data dari Supabase
app.get('/api/data', async (req, res) => {
  try {
    // Ubah 'nama_tabel_anda' sesuai nama tabel di Supabase Anda
    const { data, error } = await supabase
      .from('nama_tabel_anda') 
      .select('*');

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ error: 'Terjadi kesalahan server internal' });
  }
});

// Wajib untuk Vercel Serverless Deployment
module.exports = app;

// Jalankan server lokal jika tidak di-deploy ke Vercel (Opsional)
const PORT = process.env.PORT || 3000;
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
  });
}
