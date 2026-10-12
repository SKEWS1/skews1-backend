const crypto = require('node:crypto');

function sendJson(res, status, body) {
  res.setHeader(
    'Content-Type',
    'application/json; charset=utf-8'
  );

  return res.status(status).json(body);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }

  const aa = Buffer.from(a);
  const bb = Buffer.from(b);

  return (
    aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb)
  );
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      service: 'SKEWS Google Sheets API',
      endpoint: '/api/sensor',
      storage: 'Google Sheets only',
      supabase: 'disabled'
    });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');

    return sendJson(res, 405, {
      ok: false,
      error: 'Gunakan method POST'
    });
  }

  const expectedApiKey = process.env.ESP32_API_KEY;
  const suppliedApiKey = req.headers['x-api-key'];

  if (!expectedApiKey) {
    return sendJson(res, 500, {
      ok: false,
      error: 'ESP32_API_KEY belum diatur'
    });
  }

  if (!safeEqual(suppliedApiKey, expectedApiKey)) {
    return sendJson(res, 401, {
      ok: false,
      error: 'API key tidak valid'
    });
  }

  const scriptUrl = process.env.GOOGLE_APPS_SCRIPT_URL;
  const sheetsSecret = process.env.GOOGLE_SHEETS_SHARED_SECRET;

  if (!scriptUrl || !sheetsSecret) {
    return sendJson(res, 500, {
      ok: false,
      error: 'Environment Variables belum lengkap'
    });
  }

  if (
    !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec\/?$/
      .test(scriptUrl)
  ) {
    return sendJson(res, 500, {
      ok: false,
      error: 'URL Apps Script harus berakhir dengan /exec'
    });
  }

  let data = req.body;

  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch (_) {
      return sendJson(res, 400, {
        ok: false,
        error: 'JSON tidak valid'
      });
    }
  }

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Body harus berupa objek JSON'
    });
  }

  if (
    !data.device ||
    !data.timestamp ||
    Number.isNaN(new Date(data.timestamp).getTime())
  ) {
    return sendJson(res, 400, {
      ok: false,
      error: 'Device dan timestamp wajib valid'
    });
  }

  const payload = {
    ...data,
    secret: sheetsSecret
  };

  try {
    const response = await fetch(scriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      redirect: 'follow',
      signal: AbortSignal.timeout(20000)
    });

    const responseText = await response.text();

    let result;

    try {
      result = JSON.parse(responseText);
    } catch (_) {
      console.error(
        'Respons Apps Script bukan JSON:',
        response.status,
        responseText.slice(0, 300)
      );

      return sendJson(res, 502, {
        ok: false,
        spreadsheet: false,
        error: 'Respons Google Sheets tidak valid'
      });
    }

    if (!response.ok || result.ok !== true) {
      return sendJson(res, 502, {
        ok: false,
        spreadsheet: false,
        error: result.error || 'Gagal menulis Google Sheets'
      });
    }

    return sendJson(res, 200, {
      ok: true,
      spreadsheet: true,
      supabase: 'disabled',
      device: String(data.device),
      timestamp: new Date(data.timestamp).toISOString(),
      reason: data.reason || 'periodic',
      google_sheets: result
    });

  } catch (err) {
    console.error('Google Sheets request gagal:', err);

    return sendJson(res, 502, {
      ok: false,
      spreadsheet: false,
      error: 'Gagal menghubungi Google Apps Script'
    });
  }
};
