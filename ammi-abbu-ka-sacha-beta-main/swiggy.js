// Swiggy API Helper for Telegram Family Care Bot

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export async function requestSwiggyOtp(phone) {
  const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);
  
  if (cleanPhone.length !== 10) {
    throw new Error('Please enter a valid 10-digit Indian phone number.');
  }

  const url = 'https://www.swiggy.com/dapi/auth/sms-otp';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.swiggy.com',
        'Referer': 'https://www.swiggy.com/'
      },
      body: JSON.stringify({ mobile: cleanPhone })
    });

    const cookies = res.headers.get('set-cookie') || '';
    const data = await res.json().catch(() => ({}));

    if (res.status === 200 && data.statusCode === 0) {
      return { success: true, phone: cleanPhone, cookies, message: 'OTP sent successfully!' };
    } else {
      // Swiggy response message or geo-block
      const errorMsg = data.statusMessage || data.message || `Swiggy returned status ${res.status}`;
      return { success: false, phone: cleanPhone, message: errorMsg, isGeoBlocked: res.status === 403 };
    }
  } catch (err) {
    return { success: false, phone: cleanPhone, message: err.message };
  }
}

export async function verifySwiggyOtp(phone, otp, prevCookies = '') {
  const cleanPhone = String(phone).replace(/[^0-9]/g, '').slice(-10);
  const cleanOtp = String(otp).trim();

  const url = 'https://www.swiggy.com/dapi/auth/otp-verify';

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
        'Origin': 'https://www.swiggy.com',
        'Referer': 'https://www.swiggy.com/',
        'Cookie': prevCookies
      },
      body: JSON.stringify({ mobile: cleanPhone, otp: cleanOtp })
    });

    const newCookies = res.headers.get('set-cookie') || '';
    const data = await res.json().catch(() => ({}));

    if (res.status === 200 && data.statusCode === 0) {
      const userProfile = data.data?.user || {};
      return {
        success: true,
        phone: cleanPhone,
        sessionToken: newCookies || prevCookies,
        user: userProfile,
        message: 'Account verified and logged in successfully!'
      };
    } else {
      const errorMsg = data.statusMessage || data.message || `Verification failed (code ${res.status})`;
      return { success: false, message: errorMsg };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
