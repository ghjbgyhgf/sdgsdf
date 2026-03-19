require("dotenv").config();
const admin = require("firebase-admin");
const { TonClient, WalletContractV5R1, internal, toNano } = require("@ton/ton");
const { mnemonicToWalletKey } = require("@ton/crypto");
const TelegramBot = require('node-telegram-bot-api');

process.stdin.resume();
process.on('SIGTERM', () => { console.log('⚠️ SIGTERM - IGNORING'); });
process.on('SIGINT',  () => { console.log('⚠️ SIGINT - IGNORING');  });

setInterval(() => {
  console.log('💓 BOT ALIVE - ' + new Date().toISOString());
  const fs = require('fs');
  try { fs.writeFileSync('/tmp/bot-alive.txt', Date.now().toString()); } catch(e) {}
}, 20000);

// ==========================
// 🔹 Logging
// ==========================
let logCounter = 0;
function smartLog(...args) { if (++logCounter <= 50) console.log(...args); }
setInterval(() => { logCounter = 0; }, 60000);

// ==========================
// 🔹 إعدادات الأدمن
// ==========================
const ADMIN_CHAT_ID = "6970148965";

// ==========================
// 🔹 إعدادات المعالجة
// ==========================
const MAX_RETRIES         = 3;
const RETRY_DELAY         = 10000;

// ─── وضع المعالجة: 'batch' أو 'single' ──────
// batch  = إرسال حتى 10 سحوبات في معاملة واحدة
// single = إرسال كل سحب منفرداً بالترتيب
let PROCESSING_MODE       = 'batch'; // القيمة الافتراضية

// ─── إعدادات Batch ──────────────────────────
let BATCH_SIZE            = 10;   // عدد السحوبات في كل دفعة (قابل للتغيير)
const BATCH_FLUSH_SECONDS = 30;   // أرسل ما تبقى كل 30 ثانية حتى لو < BATCH_SIZE
const BATCH_BETWEEN_DELAY = 3000; // تأخير 3 ثواني بين كل دفعتين (لتجنب rate limit)

// ─── إعدادات Single ─────────────────────────
let SINGLE_DELAY_MS       = 3000; // تأخير بين كل سحب وآخر في وضع Single

let MAX_WITHDRAWAL_AMOUNT = 10;
let MIN_WITHDRAWAL_AMOUNT = 0.5;
let MAX_BALANCE_BUFFER    = 0.1;
let BAMBOO_TO_TON_RATE    = 10000;
let DAILY_LIMIT           = 2;    // الحد الأقصى للسحوبات اليومية لكل مستخدم
let DAILY_COOLDOWN_HOURS  = 24;   // ساعات الانتظار بعد تجاوز الحد اليومي
let systemPaused          = false;

// ==========================
// 🔹 دالة تقريب المبلغ
// ==========================
function roundAmount(amount) {
  try {
    const n = typeof amount === 'string' ? parseFloat(amount) : Number(amount);
    if (isNaN(n) || n <= 0) return 0;
    const r = Math.floor(n * 1000) / 1000;
    return r < 0.001 ? 0.001 : r;
  } catch { return 0.001; }
}

// ==========================
// 🔹 Firebase
// ==========================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error("❌ FIREBASE_SERVICE_ACCOUNT missing"); process.exit(1); }
try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    databaseURL: process.env.FIREBASE_DB_URL,
  });
  console.log("✅ Firebase connected");
} catch (e) { console.error("❌ Firebase error:", e.message); process.exit(1); }
const db = admin.database();

// ==========================
// 🔹 TON Client
// ==========================
if (!process.env.TON_API_KEY) { console.error("❌ TON_API_KEY missing"); process.exit(1); }
const client = new TonClient({
  endpoint: "https://toncenter.com/api/v2/jsonRPC",
  apiKey: process.env.TON_API_KEY,
});

// ==========================
// 🔹 متغيرات المحفظة
// ==========================
let walletContract = null;
let walletKey      = null;
let walletAddress  = null;
let isProcessing   = false;
const processingQueue = new Set();
let botInstance    = null;

// ==========================
// 🔹 إنشاء المحفظة
// ==========================
async function getWallet() {
  if (walletContract && walletKey && walletAddress)
    return { contract: walletContract, key: walletKey, address: walletAddress };
  const mnemonic = process.env.TON_MNEMONIC.split(" ");
  const key      = await mnemonicToWalletKey(mnemonic);
  const wallet   = WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey });
  const contract = client.open(wallet);
  const address  = contract.address.toString();
  walletContract = contract; walletKey = key; walletAddress = address;
  console.log("✅ Wallet loaded:", address.substring(0, 10) + "...");
  return { contract, key, address };
}

async function getWalletBalance() {
  try {
    const { contract } = await getWallet();
    return Number(await contract.getBalance()) / 1e9;
  } catch (e) { console.log(`❌ getWalletBalance: ${e.message}`); return 0; }
}

// ==========================
// 🔹 فحص الحظر
// ==========================
async function isWalletBanned(address) {
  try {
    const snap = await db.ref(`bannedWallets/${address.replace(/[.$#[\]/]/g, '_')}`).once("value");
    return snap.exists();
  } catch { return false; }
}

async function isUserBanned(userId) {
  try {
    const snap = await db.ref(`bannedUsers/${userId}`).once("value");
    return snap.exists();
  } catch { return false; }
}

// ==========================
// 🔹 فحص عدد السحوبات اليومية
// ==========================
async function getUserDailyWithdrawalCount(userId) {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const snap = await db.ref("withdrawQueue")
      .orderByChild("userId").equalTo(userId).once("value");
    if (!snap.exists()) return 0;
    let count = 0;
    snap.forEach(child => {
      const d = child.val();
      const ts = d.ts || d.timestamp || 0;
      const status = d.status || '';
      if (ts >= startOfDay.getTime() && ['paid', 'processing', 'pending', 'awaiting_approval'].includes(status)) {
        count++;
      }
    });
    return count;
  } catch (e) { console.log(`❌ getUserDailyWithdrawalCount: ${e.message}`); return 0; }
}

// ==========================
// 🔹 إشعار الأدمن بطلب موافقة
// ==========================
async function sendAdminApprovalRequest(botInstance, withdrawId, data, dailyCount) {
  const roundedAmount = roundAmount(data.ton);
  const userId        = data.userId || 'unknown';
  const address       = data.address || '—';
  const amountCoins   = data.amt || 0;
  const requestTime   = new Date(data.ts || Date.now()).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });

  const text =
    `⚠️ <b>سحب يحتاج موافقة</b>\n\n` +
    `👤 User: <code>${userId}</code>\n` +
    `📅 عدد السحوبات اليوم: <b>${dailyCount}</b> (تجاوز الحد المسموح)\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: <code>${withdrawId}</code>\n` +
    `💰 المبلغ: <b>${roundedAmount} TON</b>\n` +
    `🪙 Bamboo: <b>${Number(amountCoins).toLocaleString()}</b>\n` +
    `📬 المحفظة:\n<code>${address}</code>\n` +
    `🕐 الوقت: ${requestTime} UTC\n` +
    `━━━━━━━━━━━━━━━━\n\n` +
    `هل توافق على هذا السحب؟`;

  try {
    await botInstance.sendMessage(ADMIN_CHAT_ID, text, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ موافقة — ادفع الآن", callback_data: `approve_wd:${withdrawId}` },
          { text: "❌ رفض — إلغاء",        callback_data: `reject_wd:${withdrawId}`  },
        ]]
      }
    });
    console.log(`📨 Approval request sent for ${withdrawId}`);
  } catch (e) { console.log(`❌ sendAdminApprovalRequest: ${e.message}`); }
}

async function checkSufficientBalance(requiredAmount) {
  const balance = await getWalletBalance();
  return {
    sufficient: balance >= (requiredAmount + MAX_BALANCE_BUFFER),
    balance, required: requiredAmount
  };
}

// ==========================
// 🔹 دالة مساعدة للرد على الأدمن
// ==========================
async function adminReply(bot, chatId, text, extra = {}) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  } catch (e) { console.log(`❌ adminReply: ${e.message}`); }
}

// ==========================
// 🔹 التحقق من تأكيد المعاملة (للـ Batch)
// ==========================
async function confirmBatchTransaction(expectedSeqno, maxWaitMs = 120000) {
  const start = Date.now();
  console.log(`🔍 Waiting for batch seqno ${expectedSeqno + 1} to confirm...`);

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 4000));
    try {
      const { contract } = await getWallet();
      const currentSeqno = await contract.getSeqno();
      if (currentSeqno > expectedSeqno) {
        console.log(`✅ Batch seqno advanced: ${expectedSeqno} → ${currentSeqno}`);
        return { confirmed: true, reason: 'seqno_advanced' };
      }
    } catch (e) { console.log(`⚠️ seqno check error: ${e.message}`); }
  }

  return { confirmed: false, reason: 'seqno_timeout' };
}

// ==========================
// 🔹 إشعار المستخدم
// ==========================
async function sendUserNotification(chatId, amountTon, amountCoins, txHash) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || !chatId) return false;
  const txLink  = txHash ? `https://tonscan.org/tx/${encodeURIComponent(txHash)}` : null;
  const caption =
    `🐼 <b>Panda Treasury Released!</b>\n\nWithdrawal Successful ✅\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `💰 <b>Amount:</b> ${amountTon.toFixed(6)} TON\n` +
    `🪙 <b>Bamboo Used:</b> ${Number(amountCoins).toLocaleString()}\n` +
    (txHash ? `🔑 <b>TxID:</b> <code>${txHash}</code>\n` : ``) +
    `━━━━━━━━━━━━━━━━\n\n` +
    `The panda warriors have delivered your reward from the Bamboo Empire treasury.\n\n` +
    `Thank you for being part of Panda Bamboo Factory. 🎋`;
  const keys = [];
  if (txLink) keys.push({ text: "🔍 View TX", url: txLink });
  keys.push({ text: "🐼 Open App", url: "https://t.me/PandaBamboBot?startapp=" });
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: "https://i.supaimg.com/ec27537b-aa6a-42cf-8ba1-d6850eeea36d/7c71ad42-e22a-4e4d-86a4-a636b8b7d3a1.jpg",
        caption, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [keys] }
      }),
    });
    const data = await res.json();
    if (data.ok) { console.log(`✅ User notified: ${chatId}`); return true; }
    console.log(`❌ Telegram: ${data.description}`); return false;
  } catch (e) { console.log(`❌ sendUserNotification: ${e.message}`); return false; }
}

// ==========================
// 🔹 إشعار قناة المدفوعات
// ==========================
function maskUserId(userId) {
  const uid = String(userId || 'Unknown');
  if (uid.length <= 4) return uid;
  const start = Math.ceil(uid.length / 3);
  const end   = Math.floor(uid.length / 4);
  return uid.substring(0, start) + '***' + uid.substring(uid.length - end);
}

async function sendChannelNotification(items, txHash) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  const txLink   = txHash ? `https://tonscan.org/tx/${encodeURIComponent(txHash)}` : null;
  const totalTON = items.reduce((s, i) => s + i.roundedAmount, 0);

  // سطر لكل مستخدم
  const userLines = items.map((item, idx) => {
    const masked = maskUserId(item.userId);
    return `${idx + 1}. 👤 <code>${masked}</code> — <b>${item.roundedAmount.toFixed(4)} TON</b>`;
  }).join('\n');

  const caption =
    `🐼 <b>Bamboo Withdrawal Successful!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${userLines}\n\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `👥 Users paid: <b>${items.length}</b>\n` +
    `💰 Total: <b>${totalTON.toFixed(4)} TON</b>\n` +
    (txLink ? `🔗 <a href="${txLink}">View TX on TONScan</a>` : ``);

  const keys = [];
  if (txLink) keys.push({ text: "🔍 View TX", url: txLink });
  keys.push({ text: "🐼 Open App", url: "https://t.me/PandaBamboBot?startapp=" });
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: "@PandaBambooPayouts",
        photo: "https://i.supaimg.com/ec27537b-aa6a-42cf-8ba1-d6850eeea36d/7c71ad42-e22a-4e4d-86a4-a636b8b7d3a1.jpg",
        caption, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [keys] }
      }),
    });
    const d = await res.json();
    if (d.ok) console.log(`✅ Channel notified — ${items.length} users`);
    else console.log(`❌ Channel notification failed: ${d.description}`);
  } catch (e) { console.log(`❌ sendChannelNotification: ${e.message}`); }
}

// ==========================
// 🔹 تحديث wdHistory
// ==========================
async function updateUserWdHistory(userId, wdId, txHash, amountTon) {
  if (!userId || !wdId) return;
  try {
    await db.ref(`users/${userId}/wdHistory/${wdId}`).update({
      status:      "paid",
      txHash:      txHash || null,
      sentAmount:  amountTon,
      paidAt:      Date.now(),
    });
    console.log(`✅ wdHistory updated: users/${userId}/wdHistory/${wdId}`);
  } catch (e) { console.log(`❌ updateUserWdHistory: ${e.message}`); }
}

// ==========================
// 🔹 التحقق من صلاحية السحب قبل إدراجه في الدفعة
// ==========================
async function validateWithdrawal(withdrawId, data) {
  // تحقق من البيانات
  if (!data?.address || !data?.ton) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "failed", error: "Invalid data", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  const roundedAmount = roundAmount(data.ton);
  const userId        = data.userId || null;
  const wdId          = data.wdId   || withdrawId;

  // تحقق من العنوان — فحص شامل
  const addr = String(data.address || '').trim();

  // العنوان الصحيح: يبدأ بـ EQ أو UQ، طوله 48 حرف بالضبط، أحرف base64url فقط
  const validPrefix  = addr.startsWith("EQ") || addr.startsWith("UQ");
  const validLength  = addr.length === 48;
  // base64url: A-Z a-z 0-9 + - _ (لا يوجد @ # $ % إلخ)
  const validChars   = /^[A-Za-z0-9+/\-_=]+$/.test(addr);
  // اكتشاف التكرار: وجود EQ أو UQ بعد الحرف الأول
  const duplicated   = addr.indexOf("EQ", 2) !== -1 || addr.indexOf("UQ", 2) !== -1;
  const hasSpaces    = addr.includes(' ');

  let addrError = null;
  if (!validPrefix)  addrError = `Invalid prefix (expected EQ/UQ, got ${addr.substring(0,2)})`;
  else if (duplicated) addrError = `Duplicated address — two addresses merged`;
  else if (!validLength) addrError = `Invalid length: ${addr.length} (expected 48)`;
  else if (!validChars)  addrError = `Invalid characters in address`;
  else if (hasSpaces)    addrError = `Address contains spaces`;

  if (addrError) {
    console.log(`❌ Bad address [${withdrawId}]: ${addrError} | ${addr.substring(0, 30)}...`);
    await db.ref(`withdrawQueue/${withdrawId}`).update({
      status: "cancelled", error: addrError, updatedAt: Date.now()
    });
    if (userId && wdId) {
      await db.ref(`users/${userId}/wdHistory/${wdId}`)
        .update({ status: "cancelled", updatedAt: Date.now() }).catch(() => {});
    }
    if (botInstance) {
      await botInstance.sendMessage(ADMIN_CHAT_ID,
        `⚠️ <b>عنوان محفظة فاسد — تم إلغاء الطلب</b>

` +
        `🆔 ID: <code>${withdrawId}</code>
` +
        `👤 User: <code>${userId || '?'}</code>
` +
        `❌ السبب: ${addrError}
` +
        `📬 العنوان:
<code>${addr.substring(0, 80)}</code>`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }
    return { valid: false, skip: true };
  }
  // استخدم العنوان المنظّف
  data.address = addr;

  // فحص حظر المستخدم
  if (userId && await isUserBanned(userId)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "User is banned", updatedAt: Date.now() });
    if (wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  // فحص حظر المحفظة
  if (await isWalletBanned(data.address)) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", error: "Wallet is banned", updatedAt: Date.now() });
    if (userId && wdId) await db.ref(`users/${userId}/wdHistory/${wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
    return { valid: false, skip: true };
  }

  // انتظار موافقة الأدمن
  if (data.status === 'awaiting_approval') {
    return { valid: false, skip: false }; // تجاهل مؤقتاً فقط
  }

  // فحص الحد اليومي — انتظار 24 ساعة بدون طلب موافقة
  if (userId) {
    const dailyCount = await getUserDailyWithdrawalCount(userId);
    if (dailyCount >= DAILY_LIMIT) {
      // احسب متى يحق للمستخدم السحب مرة أخرى
      const cooldownMs  = DAILY_COOLDOWN_HOURS * 60 * 60 * 1000;
      const unlockTime  = (data.ts || Date.now()) + cooldownMs;
      const unlockStr   = new Date(unlockTime).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false });
      await db.ref(`withdrawQueue/${withdrawId}`).update({
        status:    "awaiting_approval",
        updatedAt: Date.now(),
        holdReason: `تجاوز الحد اليومي (${dailyCount}/${DAILY_LIMIT}) — سيُدفع تلقائياً بعد ${DAILY_COOLDOWN_HOURS}ساعة`,
        unlockAt:  unlockTime,
      });
      console.log(`⏳ Daily limit — ${withdrawId} queued until ${unlockStr} UTC`);
      return { valid: false, skip: false };
    }
  }

  // فحص الحدود (max/min)
  if (roundedAmount > MAX_WITHDRAWAL_AMOUNT) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", error: `Exceeds max ${MAX_WITHDRAWAL_AMOUNT} TON — waiting`, updatedAt: Date.now() });
    return { valid: false, skip: false };
  }
  if (roundedAmount < MIN_WITHDRAWAL_AMOUNT) {
    await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", error: `Below min ${MIN_WITHDRAWAL_AMOUNT} TON — waiting`, updatedAt: Date.now() });
    return { valid: false, skip: false };
  }

  // المبلغ ضمن الحدود — امسح أي error قديم من رفض سابق
  await db.ref(`withdrawQueue/${withdrawId}`).update({ error: null, lastError: null, updatedAt: Date.now() }).catch(() => {});
  return { valid: true, roundedAmount, userId, wdId };
}

// ==========================
// 🔹 إرسال دفعة Batch (الدالة الرئيسية الجديدة)
//    items = [{ id, data, roundedAmount, userId, wdId, amountCoins }]
// ==========================
async function sendBatchTransfer(items, attempt = 0) {
  const MAX_BATCH_RETRIES = 2;
  const batchIds = items.map(i => i.id).join(', ');
  const totalTON = items.reduce((s, i) => s + i.roundedAmount, 0);

  console.log(`\n${'='.repeat(50)}`);
  console.log(`📦 BATCH TRANSFER | ${items.length} items | ${totalTON.toFixed(4)} TON total`);
  console.log(`   IDs: ${batchIds}`);
  console.log(`${'='.repeat(50)}`);

  // فحص الرصيد الكلي للدفعة
  const balanceCheck = await checkSufficientBalance(totalTON);
  if (!balanceCheck.sufficient) {
    console.log(`⏭️ Insufficient balance for batch: ${balanceCheck.balance.toFixed(3)} TON < ${totalTON.toFixed(3)} TON`);
    // أرجع كل السحوبات لـ pending
    for (const item of items) {
      processingQueue.delete(item.id);
      await db.ref(`withdrawQueue/${item.id}`).update({
        status: "pending", updatedAt: Date.now(),
        lastError: `Insufficient balance: ${balanceCheck.balance.toFixed(3)} TON`
      }).catch(() => {});
    }
    return { success: false, reason: 'insufficient_balance' };
  }

  try {
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();

    // ─── بناء قائمة الرسائل مع عزل أي عنوان فاسد ───────
    const validMessages = [];
    const invalidItems  = [];

    for (const item of items) {
      try {
        const msg = internal({
          to:     item.data.address,
          value:  toNano(item.roundedAmount.toFixed(3)),
          bounce: false,
        });
        validMessages.push({ item, msg });
      } catch (addrErr) {
        // العنوان فاسد — ألغِ هذا الطلب فوراً
        const reason = addrErr.message || 'Invalid address';
        console.log(`❌ Bad address — cancelling ${item.id}: ${reason}`);
        invalidItems.push({ item, reason });
        await db.ref(`withdrawQueue/${item.id}`).update({
          status: "cancelled", updatedAt: Date.now(),
          error: `Bad address: ${reason}`,
        }).catch(() => {});
        if (item.userId && item.wdId) {
          await db.ref(`users/${item.userId}/wdHistory/${item.wdId}`)
            .update({ status: "cancelled", updatedAt: Date.now() }).catch(() => {});
        }
        processingQueue.delete(item.id);
      }
    }

    // إشعار الأدمن بالعناوين الفاسدة (دفعة واحدة)
    if (invalidItems.length > 0 && botInstance) {
      const lines = invalidItems.map(x =>
        `• <code>${x.item.id}</code> | 👤 <code>${x.item.userId || '?'}</code>\n` +
        `  📬 <code>${String(x.item.data.address).substring(0, 60)}</code>\n` +
        `  ❌ ${x.reason}`
      ).join('\n\n');
      await botInstance.sendMessage(ADMIN_CHAT_ID,
        `⚠️ <b>${invalidItems.length} عنوان فاسد — تم إلغاؤها تلقائياً</b>\n\n${lines}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    // لو كل العناوين فاسدة — توقف
    if (validMessages.length === 0) {
      console.log(`🚫 Batch cancelled — all addresses invalid`);
      return { success: false, reason: 'all_invalid' };
    }

    // أعد بناء items بالعناوين الصحيحة فقط
    const cleanItems = validMessages.map(x => x.item);
    const messages   = validMessages.map(x => x.msg);
    const cleanTotal = cleanItems.reduce((s, i) => s + i.roundedAmount, 0);
    console.log(`📦 Building batch: ${cleanItems.length}/${items.length} valid (${invalidItems.length} cancelled) | ${cleanTotal.toFixed(4)} TON`);

    // فحص الرصيد مجدداً بعد حذف الفاسدة
    const recheck = await checkSufficientBalance(cleanTotal);
    if (!recheck.sufficient) {
      for (const item of cleanItems) {
        processingQueue.delete(item.id);
        await db.ref(`withdrawQueue/${item.id}`).update({
          status: "pending", updatedAt: Date.now(),
          lastError: `Insufficient balance: ${recheck.balance.toFixed(3)} TON`,
        }).catch(() => {});
      }
      return { success: false, reason: 'insufficient_balance' };
    }

    // تأخير صغير قبل الإرسال
    await new Promise(r => setTimeout(r, 1000));

    // إرسال كل الرسائل الصحيحة في معاملة واحدة
    await contract.sendTransfer({ secretKey: key.secretKey, seqno, messages });

    console.log(`📤 Batch submitted — seqno: ${seqno} | ${cleanItems.length} msgs | attempt: ${attempt + 1}`);

    // انتظار تأكيد الـ seqno (حتى 120 ثانية)
    const confirmation = await confirmBatchTransaction(seqno, 120000);

    if (!confirmation.confirmed) {
      // TIMEOUT — لا نعيد الإرسال لأن الفلوس ممكن تكون راحت
      console.log(`⚠️ Batch TIMEOUT — seqno ${seqno} not advanced. Marking as needs_review.`);
      for (const item of cleanItems) {
        await db.ref(`withdrawQueue/${item.id}`).update({
          status: "needs_review", updatedAt: Date.now(),
          lastError: `Batch timeout — seqno ${seqno} — verify manually`,
          batchSeqno: seqno,
        }).catch(() => {});
        processingQueue.delete(item.id);
      }
      // إشعار الأدمن
      if (botInstance) {
        await botInstance.sendMessage(ADMIN_CHAT_ID,
          `⚠️ <b>Batch Timeout</b>\n\n` +
          `${cleanItems.length} سحوبات تحتاج مراجعة يدوية\n` +
          `Seqno: <code>${seqno}</code>\n\n` +
          `IDs:\n${cleanItems.map(i => `• <code>${i.id}</code>`).join('\n')}`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return { success: false, reason: 'timeout', seqno };
    }

    // ✅ الدفعة نجحت — جيب hash من آخر معاملة
    let batchTxHash = null;
    try {
      const txRes  = await fetch(
        `https://toncenter.com/api/v2/getTransactions?address=${walletAddress}&limit=5`,
        { headers: { "X-API-Key": process.env.TON_API_KEY } }
      );
      const txData = await txRes.json();
      batchTxHash = txData.result?.[0]?.transaction_id?.hash || null;
    } catch (e) { console.log(`⚠️ Could not fetch batch tx hash: ${e.message}`); }

    console.log(`✅ Batch confirmed | hash: ${batchTxHash ? batchTxHash.substring(0, 14) + '...' : 'N/A'}`);

    // تحديث Firebase لكل سحب في الدفعة
    const updatePromises = cleanItems.map(async (item) => {
      try {
        await db.ref(`withdrawQueue/${item.id}`).update({
          status:      "paid",
          updatedAt:   Date.now(),
          completedAt: Date.now(),
          txHash:      batchTxHash || null,
          sentAmount:  item.roundedAmount,
          batchSize:   cleanItems.length,
        });
        await updateUserWdHistory(item.userId, item.wdId, batchTxHash, item.roundedAmount);
        processingQueue.delete(item.id);
        console.log(`   ✅ Marked paid: ${item.id}`);
      } catch (e) {
        console.log(`   ❌ Failed to update ${item.id}: ${e.message}`);
      }
    });
    await Promise.all(updatePromises);

    // إشعارات المستخدمين — كل مستخدم على حدة مع retry
    for (const item of cleanItems) {
      const sent = await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, batchTxHash);
      if (!sent) {
        await new Promise(r => setTimeout(r, 2000));
        await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, batchTxHash);
      }
    }
    // إشعار القناة بكل المستخدمين في رسالة واحدة
    await sendChannelNotification(cleanItems, batchTxHash).catch(() => {});

    console.log(`🎉 Batch complete: ${cleanItems.length} paid${invalidItems.length > 0 ? ` (${invalidItems.length} cancelled — bad address)` : ''}`);
    return { success: true, txHash: batchTxHash, count: cleanItems.length };

  } catch (error) {
    const msg = error.message;
    console.log(`❌ Batch attempt ${attempt + 1} failed: ${msg}`);

    const isNetworkError = msg.includes('500') || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('network');

    if (isNetworkError && attempt < MAX_BATCH_RETRIES) {
      const waitSec = 20 * (attempt + 1);
      console.log(`🔁 Network error — retrying batch in ${waitSec}s (attempt ${attempt + 2})`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return sendBatchTransfer(items, attempt + 1);
    }

    // فشل نهائي — أرجع السحوبات الصحيحة لـ pending (الفاسدة اتلغت بالفعل)
    const revertList = (typeof cleanItems !== 'undefined') ? cleanItems : items;
    console.log(`🔴 Batch FINAL FAIL — reverting ${revertList.length} items to pending`);
    for (const item of revertList) {
      await db.ref(`withdrawQueue/${item.id}`).update({
        status:    "pending",
        updatedAt: Date.now(),
        lastError: `Batch failed (attempt ${attempt + 1}): ${msg}`,
        attempts:  (item.data.attempts || 0) + 1,
      }).catch(() => {});
      processingQueue.delete(item.id);
    }

    // إشعار الأدمن
    if (botInstance) {
      await botInstance.sendMessage(ADMIN_CHAT_ID,
        `🔴 <b>Batch Failed</b>\n\n` +
        `${items.length} سحوبات فشلت وأُعيدت لـ pending\n\n` +
        `<i>${msg.substring(0, 300)}</i>\n\n` +
        `IDs:\n${items.map(i => `• <code>${i.id}</code>`).join('\n')}`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    }

    return { success: false, reason: 'error', error: msg };
  }
}

// ==========================
// 🔹 إرسال سحب واحد (Single mode)
// ==========================
async function sendSingleTransfer(item, attempt = 0) {
  const MAX_SINGLE_RETRIES = 3;
  console.log(`
${'─'.repeat(40)}`);
  console.log(`💸 SINGLE TRANSFER | ${item.id} | ${item.roundedAmount} TON → ${item.data.address.substring(0,10)}...`);

  const balanceCheck = await checkSufficientBalance(item.roundedAmount);
  if (!balanceCheck.sufficient) {
    processingQueue.delete(item.id);
    await db.ref(`withdrawQueue/${item.id}`).update({
      status: "pending", updatedAt: Date.now(),
      lastError: `Insufficient balance: ${balanceCheck.balance.toFixed(3)} TON`,
    }).catch(() => {});
    return { success: false, reason: 'insufficient_balance' };
  }

  try {
    const { contract, key } = await getWallet();
    const seqno = await contract.getSeqno();

    await new Promise(r => setTimeout(r, 1000));
    await contract.sendTransfer({
      secretKey: key.secretKey,
      seqno,
      messages: [internal({ to: item.data.address, value: toNano(item.roundedAmount.toFixed(3)), bounce: false })]
    });
    console.log(`📤 Single submitted — seqno: ${seqno} | attempt: ${attempt + 1}`);

    const confirmation = await confirmBatchTransaction(seqno, 90000);
    if (!confirmation.confirmed) {
      console.log(`⚠️ Single TIMEOUT — seqno ${seqno}`);
      await db.ref(`withdrawQueue/${item.id}`).update({
        status: "needs_review", updatedAt: Date.now(),
        lastError: `Single timeout — seqno ${seqno} — verify manually`,
      }).catch(() => {});
      processingQueue.delete(item.id);
      if (botInstance) {
        await botInstance.sendMessage(ADMIN_CHAT_ID,
          `⚠️ <b>Single Timeout</b>\n\n<code>${item.id}</code>\nSeqno: <code>${seqno}</code>\nراجع يدوياً`,
          { parse_mode: 'HTML' }
        ).catch(() => {});
      }
      return { success: false, reason: 'timeout' };
    }

    // جيب الـ hash
    let txHash = null;
    try {
      const txRes  = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${walletAddress}&limit=3`,
        { headers: { "X-API-Key": process.env.TON_API_KEY } });
      const txData = await txRes.json();
      txHash = txData.result?.[0]?.transaction_id?.hash || null;
    } catch(e) {}

    await db.ref(`withdrawQueue/${item.id}`).update({
      status: "paid", updatedAt: Date.now(), completedAt: Date.now(),
      txHash: txHash || null, sentAmount: item.roundedAmount, batchSize: 1,
    });
    await updateUserWdHistory(item.userId, item.wdId, txHash, item.roundedAmount);
    processingQueue.delete(item.id);
    console.log(`✅ Single paid: ${item.id} | hash: ${txHash ? txHash.substring(0,12)+'...' : 'N/A'}`);

    // إشعار المستخدم مع retry
    const sent = await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, txHash);
    if (!sent) {
      await new Promise(r => setTimeout(r, 2000));
      await sendUserNotification(item.userId, item.roundedAmount, item.amountCoins, txHash);
    }
    await sendChannelNotification([item], txHash).catch(() => {});
    return { success: true, txHash };

  } catch (error) {
    const msg = error.message;
    console.log(`❌ Single attempt ${attempt + 1} failed: ${msg}`);
    const isNetwork = msg.includes('500') || msg.toLowerCase().includes('timeout') || msg.toLowerCase().includes('network');
    if (isNetwork && attempt < MAX_SINGLE_RETRIES) {
      const waitSec = 15 * (attempt + 1);
      console.log(`🔁 Retrying single in ${waitSec}s`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      return sendSingleTransfer(item, attempt + 1);
    }
    await db.ref(`withdrawQueue/${item.id}`).update({
      status: "pending", updatedAt: Date.now(),
      lastError: `Single failed (${attempt + 1}): ${msg}`,
      attempts: (item.data.attempts || 0) + 1,
    }).catch(() => {});
    processingQueue.delete(item.id);
    return { success: false, reason: 'error', error: msg };
  }
}

// ==========================
// 🔹 معالجة السحوبات المعلقة — نظام Batch الجديد
// ==========================
async function processPendingWithdrawals() {
  if (systemPaused) { console.log("⏸️ Paused — skipping"); return; }
  if (isProcessing)  { console.log("⚠️ Already processing — skipping"); return; }

  try {
    isProcessing = true;

    // ─── أولاً: افتح الطلبات التي انتهت مدة الانتظار (24h) ──
    await unlockExpiredDailyLimits();

    const snapshot    = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
    const withdrawals = snapshot.val();
    if (!withdrawals) { console.log("📭 No pending withdrawals"); isProcessing = false; return; }

    const list = Object.entries(withdrawals)
      .filter(([id]) => !processingQueue.has(id))
      .map(([id, d]) => ({ id, data: d, timestamp: d.ts || d.timestamp || 0 }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (!list.length) { console.log("📭 All pending already in processingQueue"); isProcessing = false; return; }

    const mode = PROCESSING_MODE;
    console.log(`\n📋 ${list.length} pending | Mode: ${mode.toUpperCase()} | BatchSize: ${BATCH_SIZE}`);

    // ─── المرحلة 1: التحقق من كل السحوبات ──────────────
    const validItems = [];
    for (const { id, data } of list) {
      processingQueue.add(id);
      const validation = await validateWithdrawal(id, data);

      if (!validation.valid) {
        processingQueue.delete(id);
        continue;
      }

      // ─── قفل ذري في Firebase ──
      let locked = false;
      await db.ref(`withdrawQueue/${id}`).transaction((current) => {
        if (!current || current.status !== "pending") return;
        locked = true;
        return { ...current, status: "processing", updatedAt: Date.now(), attempts: (current.attempts || 0) + 1 };
      });

      if (!locked) {
        console.log(`⏭️ ${id} already taken — skipping`);
        processingQueue.delete(id);
        continue;
      }

      validItems.push({
        id, data,
        roundedAmount: validation.roundedAmount,
        userId:        validation.userId,
        wdId:          validation.wdId,
        amountCoins:   data.amt || 0,
      });
    }

    if (!validItems.length) {
      console.log("📭 No valid withdrawals after checks");
      isProcessing = false;
      return;
    }

    const totalTON = validItems.reduce((s, i) => s + i.roundedAmount, 0);

    // ─── المرحلة 2: إرسال حسب الوضع ──────────────────
    if (mode === 'batch') {
      // ── Batch mode ──
      const batchCount = Math.ceil(validItems.length / BATCH_SIZE);
      console.log(`\n🚀 BATCH | ${validItems.length} items → ${batchCount} batch(es) | ${totalTON.toFixed(4)} TON`);
      for (let b = 0; b < batchCount; b++) {
        const batch = validItems.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
        console.log(`\n▶️ Batch ${b + 1}/${batchCount} (${batch.length} items)...`);
        await sendBatchTransfer(batch);
        if (b < batchCount - 1) {
          console.log(`⏳ Waiting ${BATCH_BETWEEN_DELAY / 1000}s...`);
          await new Promise(r => setTimeout(r, BATCH_BETWEEN_DELAY));
        }
      }
    } else {
      // ── Single mode ──
      console.log(`\n🚀 SINGLE | ${validItems.length} items | ${totalTON.toFixed(4)} TON | delay: ${SINGLE_DELAY_MS/1000}s`);
      for (let i = 0; i < validItems.length; i++) {
        if (systemPaused) { console.log("⏸ Paused mid-single — stopping"); break; }
        console.log(`\n▶️ Single ${i + 1}/${validItems.length}: ${validItems[i].id}`);
        await sendSingleTransfer(validItems[i]);
        if (i < validItems.length - 1) {
          await new Promise(r => setTimeout(r, SINGLE_DELAY_MS));
        }
      }
    }

  } catch (e) {
    console.log(`❌ processPendingWithdrawals: ${e.message}`);
  } finally {
    isProcessing = false;
    console.log("✅ processPendingWithdrawals cycle done");
  }
}

// ==========================
// 🔹 فتح الطلبات المعلقة التي انتهت مدة الانتظار
// ==========================
async function unlockExpiredDailyLimits() {
  try {
    const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value");
    const items = snap.val();
    if (!items) return;
    const now = Date.now();
    let unlocked = 0;
    for (const [id, d] of Object.entries(items)) {
      // فقط الطلبات التي تجاوزت وقت الفتح (unlockAt)
      if (d.unlockAt && now >= d.unlockAt) {
        await db.ref(`withdrawQueue/${id}`).update({
          status: "pending", updatedAt: now,
          holdReason: null, unlockAt: null,
          lastError: null,
        });
        unlocked++;
        console.log(`🔓 Unlocked daily-limit withdrawal: ${id}`);
      }
    }
    if (unlocked > 0) console.log(`🔓 Unlocked ${unlocked} daily-limit withdrawals`);
  } catch (e) { console.log(`❌ unlockExpiredDailyLimits: ${e.message}`); }
}

// ==========================
// 🔹 بوت الترحيب + أوامر الأدمن
// ==========================
function startWelcomeBot() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) { console.log("⚠️ TELEGRAM_BOT_TOKEN missing"); return; }

  const bot = new TelegramBot(botToken, { polling: true });
  botInstance = bot;

  const isAdmin = (msg) => msg.chat.id.toString() === ADMIN_CHAT_ID;
  const unauth  = async (msg) => await bot.sendMessage(msg.chat.id, "⛔ Unauthorized");

  // ─── /start ───────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId    = msg.chat.id;
    const firstName = msg.from.first_name || "Warrior";
    console.log(`👋 /start: ${chatId}`);
    await adminReply(bot, chatId,
      `Hey ${firstName}! 👋 You've just joined the coolest virtual factory on Telegram.\n\n` +
      `🎁 <b>Your starter pack is ready:</b>\n• 200 Coins — free to withdraw right away\n• 100 Bamboo/day — free mining starts immediately\n\n` +
      `⚙️ <b>How it works:</b>\n1️⃣ Mine — Bamboo accumulates in your tank automatically\n2️⃣ Exchange — Convert Bamboo → Coins in Finance\n3️⃣ Withdraw — Send Coins to your TON wallet 💎\n\n` +
      `🚀 <b>Boost your earnings:</b>\n— Buy machines from the Market to increase daily output\n— Complete Tasks for bonus Bamboo & Coins\n— Invite friends and earn 20% commission on their purchases`,
      { reply_markup: { inline_keyboard: [
        [{ text: "🐼 Open App", url: "https://t.me/PandaBamboBot?startapp=" }],
        [{ text: "📢 News", url: "https://t.me/PandaMiningNews" }, { text: "💸 Payouts", url: "https://t.me/PandaBambooPayouts" }]
      ]}}
    );
  });

  // ─── /help ────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    if (!isAdmin(msg)) return;
    await adminReply(bot, msg.chat.id,
      `🐼 <b>Panda Bamboo — لوحة الأدمن</b>\n` +
      `${'═'.repeat(32)}\n\n` +

      `📊 <b>المعلومات والمراقبة</b>\n` +
      `/balance — رصيد محفظة TON\n` +
      `/queue — قائمة الانتظار\n` +
      `/pending_reasons — تفاصيل المعلقة مع الأسباب\n` +
      `/stats — إحصائيات كاملة\n` +
      `/mode — الوضع الحالي (Batch/Single)\n\n` +

      `⚙️ <b>إعدادات السحب</b>\n` +
      `/setmax [TON] — الحد الأقصى للسحب\n` +
      `/setmin [TON] — الحد الأدنى للسحب\n` +
      `/setrate [رقم] — سعر Bamboo→TON\n` +
      `/setdaily [رقم] — الحد اليومي للمستخدم\n` +
      `/setcooldown [ساعات] — مدة الانتظار بعد تجاوز الحد\n\n` +

      `📦 <b>نظام المعالجة</b>\n` +
      `/setmode batch — تفعيل نظام الباتش\n` +
      `/setmode single — تفعيل النظام الفردي\n` +
      `/setbatchsize [رقم] — حجم الدفعة (1-4)\n` +
      `/setsingledelay [ثواني] — التأخير بين كل سحب في Single\n` +
      `/batchstatus — حالة نظام المعالجة\n\n` +

      `🔧 <b>التحكم</b>\n` +
      `/process — تشغيل المعالجة يدوياً\n` +
      `/pause — إيقاف المعالجة\n` +
      `/resume — استئناف المعالجة\n` +
      `/clearqueue — إلغاء جميع السحوبات المعلقة\n` +
      `/retryall — إعادة محاولة السحوبات الفاشلة\n\n` +

      `👤 <b>إدارة المستخدمين</b>\n` +
      `/banuser [userId] — حظر مستخدم\n` +
      `/unbanuser [userId] — رفع حظر مستخدم\n` +
      `/banwallet [address] — حظر محفظة\n` +
      `/unwallet [address] — رفع حظر محفظة\n` +
      `/userinfo [userId] — معلومات مستخدم\n\n` +

      `🕵️ <b>كشف التلاعب</b>\n` +
      `/check_suspicious — كشف محافظ مشتركة (+3 مستخدمين)\n` +
      `/reject_suspicious — رفض وحظر جميع المشبوهين\n`
    );
  });

  // ─── /balance ─────────────────────────────────────────
  bot.onText(/\/balance/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const b = await getWalletBalance();
    await adminReply(bot, msg.chat.id, `💰 <b>Wallet Balance:</b> ${b.toFixed(6)} TON\n📬 <code>${walletAddress || 'not loaded'}</code>`);
  });

  // ─── /queue ───────────────────────────────────────────
  bot.onText(/\/queue/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
      const count = snap.exists() ? Object.keys(snap.val()).length : 0;
      const totalTON = snap.exists()
        ? Object.values(snap.val()).reduce((s, d) => s + roundAmount(d.ton), 0).toFixed(4)
        : '0';
      await adminReply(bot, msg.chat.id,
        `📋 <b>Queue Status</b>\n\n` +
        `⏳ Pending: <b>${count}</b> withdrawals\n` +
        `💰 Total: <b>${totalTON} TON</b>\n\n` +
        `📦 Batch size: <b>${BATCH_SIZE}</b> per batch\n` +
        `⚡ Est. batches needed: <b>${Math.ceil(count / BATCH_SIZE)}</b>`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /mode ────────────────────────────────────────────
  bot.onText(/\/mode/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const modeIcon = PROCESSING_MODE === 'batch' ? '📦' : '💸';
    await adminReply(bot, msg.chat.id,
      `${modeIcon} <b>وضع المعالجة الحالي: ${PROCESSING_MODE.toUpperCase()}</b>\n\n` +
      (PROCESSING_MODE === 'batch'
        ? `📦 Batch: يجمع حتى <b>${BATCH_SIZE}</b> سحوبات في معاملة واحدة\n⏳ تأخير بين الدفعات: <b>${BATCH_BETWEEN_DELAY/1000}s</b>`
        : `💸 Single: يرسل كل سحب منفرداً\n⏳ تأخير بين كل سحب: <b>${SINGLE_DELAY_MS/1000}s</b>`) +
      `\n\n🔄 Processing: <b>${isProcessing ? '✅ يعمل' : '⏹ متوقف'}</b>` +
      `\n⏸ Paused: <b>${systemPaused ? 'نعم ⏸' : 'لا ✅'}</b>` +
      `\n🔒 في القائمة: <b>${processingQueue.size}</b>`
    );
  });

  // ─── /batchstatus ─────────────────────────────────────
  bot.onText(/\/batchstatus/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snapP = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
      const snapA = await db.ref("withdrawQueue").orderByChild("status").equalTo("awaiting_approval").once("value");
      const pendingCount  = snapP.exists() ? Object.keys(snapP.val()).length : 0;
      const approvalCount = snapA.exists() ? Object.keys(snapA.val()).length : 0;
      const modeIcon = PROCESSING_MODE === 'batch' ? '📦' : '💸';
      await adminReply(bot, msg.chat.id,
        `${modeIcon} <b>حالة نظام المعالجة</b>\n\n` +
        `🔀 الوضع: <b>${PROCESSING_MODE.toUpperCase()}</b>\n` +
        `🔢 حجم الدفعة: <b>${BATCH_SIZE}</b>\n` +
        `⏱ Flush كل: <b>${BATCH_FLUSH_SECONDS}s</b>\n` +
        `⏳ تأخير بين دفعات: <b>${BATCH_BETWEEN_DELAY/1000}s</b>\n` +
        `💸 تأخير Single: <b>${SINGLE_DELAY_MS/1000}s</b>\n\n` +
        `📋 Pending: <b>${pendingCount}</b>\n` +
        `⏳ Awaiting approval: <b>${approvalCount}</b>\n` +
        `🔄 Processing now: <b>${isProcessing ? 'نعم' : 'لا'}</b>\n` +
        `⏸ Paused: <b>${systemPaused ? 'نعم ⏸' : 'لا ✅'}</b>\n` +
        `🔒 In processingQueue: <b>${processingQueue.size}</b>\n\n` +
        `📅 الحد اليومي: <b>${DAILY_LIMIT}</b> سحوبات\n` +
        `⏰ Cooldown: <b>${DAILY_COOLDOWN_HOURS}</b> ساعة`
      );
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /stats ───────────────────────────────────────────
  bot.onText(/\/stats/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val() || {};
      const counts = { pending: 0, processing: 0, paid: 0, failed: 0, bounced: 0, cancelled: 0, awaiting_approval: 0, needs_review: 0 };
      let totalPaid = 0;
      Object.values(items).forEach(d => {
        counts[d.status] = (counts[d.status] || 0) + 1;
        if (d.status === 'paid') totalPaid += roundAmount(d.ton);
      });
      const bal = await getWalletBalance();
      const modeIcon = PROCESSING_MODE === 'batch' ? '📦' : '💸';
      await adminReply(bot, msg.chat.id,
        `📊 <b>إحصائيات الوضع الحالي</b>\n\n` +
        `✅ مدفوعة: <b>${counts.paid}</b> (${totalPaid.toFixed(3)} TON)\n` +
        `⏳ Pending: <b>${counts.pending}</b>\n` +
        `🔄 Processing: <b>${counts.processing}</b>\n` +
        `⏸ Awaiting (daily): <b>${counts.awaiting_approval}</b>\n` +
        `🔴 Bounced: <b>${counts.bounced}</b>\n` +
        `❌ Failed: <b>${counts.failed}</b>\n` +
        `🔍 Needs review: <b>${counts.needs_review}</b>\n` +
        `🚫 Cancelled: <b>${counts.cancelled}</b>\n\n` +
        `💰 رصيد المحفظة: <b>${bal.toFixed(4)} TON</b>\n\n` +
        `${'─'.repeat(28)}\n` +
        `${modeIcon} الوضع: <b>${PROCESSING_MODE.toUpperCase()}</b> | حجم الدفعة: <b>${BATCH_SIZE}</b>\n` +
        `📈 Max: <b>${MAX_WITHDRAWAL_AMOUNT}</b> | Min: <b>${MIN_WITHDRAWAL_AMOUNT}</b> TON\n` +
        `📅 الحد اليومي: <b>${DAILY_LIMIT}</b> سحوبات | Cooldown: <b>${DAILY_COOLDOWN_HOURS}h</b>\n` +
        `💱 Rate: <b>1 TON = ${BAMBOO_TO_TON_RATE} Bamboo</b>\n` +
        `⏸ Paused: <b>${systemPaused ? 'نعم' : 'لا'}</b>`
      );
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /setmax ──────────────────────────────────────────
  bot.onText(/\/setmax (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    MAX_WITHDRAWAL_AMOUNT = v;
    await adminReply(bot, msg.chat.id, `✅ الحد الأقصى: <b>${v} TON</b>\n🔄 جاري إعادة معالجة الطلبات المعلقة...`);
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /setmin ──────────────────────────────────────────
  bot.onText(/\/setmin (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    MIN_WITHDRAWAL_AMOUNT = v;
    await adminReply(bot, msg.chat.id, `✅ الحد الأدنى: <b>${v} TON</b>\n🔄 جاري إعادة معالجة الطلبات المعلقة...`);
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /setrate ─────────────────────────────────────────
  bot.onText(/\/setrate (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    BAMBOO_TO_TON_RATE = v;
    await adminReply(bot, msg.chat.id, `✅ السعر: <b>1 TON = ${v} Bamboo</b>`);
  });

  // ─── /setdaily ────────────────────────────────────────
  bot.onText(/\/setdaily (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
    if (isNaN(v) || v < 1) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح (1 على الأقل)"); return; }
    DAILY_LIMIT = v;
    await adminReply(bot, msg.chat.id, `✅ الحد اليومي: <b>${v}</b> سحوبات لكل مستخدم`);
  });

  // ─── /setcooldown ─────────────────────────────────────
  bot.onText(/\/setcooldown (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v <= 0) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح"); return; }
    DAILY_COOLDOWN_HOURS = v;
    await adminReply(bot, msg.chat.id, `✅ مدة الانتظار: <b>${v}</b> ساعة بعد تجاوز الحد اليومي`);
  });

  // ─── /setmode ─────────────────────────────────────────
  bot.onText(/\/setmode (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const m = match[1].trim().toLowerCase();
    if (m !== 'batch' && m !== 'single') {
      await adminReply(bot, msg.chat.id, "❌ الوضع يجب أن يكون: <b>batch</b> أو <b>single</b>"); return;
    }
    PROCESSING_MODE = m;
    const icon = m === 'batch' ? '📦' : '💸';
    await adminReply(bot, msg.chat.id,
      `${icon} تم التبديل إلى وضع <b>${m.toUpperCase()}</b>\n\n` +
      (m === 'batch'
        ? `يجمع حتى <b>${BATCH_SIZE}</b> سحوبات في معاملة واحدة`
        : `يرسل كل سحب منفرداً بتأخير <b>${SINGLE_DELAY_MS/1000}s</b>`)
    );
  });

  // ─── /setbatchsize ────────────────────────────────────
  bot.onText(/\/setbatchsize (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseInt(match[1]);
    if (isNaN(v) || v < 1 || v > 4) {
      await adminReply(bot, msg.chat.id, "❌ حجم الدفعة يجب أن يكون بين 1 و4 (حد TON للمعاملة الواحدة)"); return;
    }
    BATCH_SIZE = v;
    await adminReply(bot, msg.chat.id, `✅ حجم الدفعة: <b>${v}</b> سحوبات في المعاملة الواحدة`);
  });

  // ─── /setsingledelay ──────────────────────────────────
  bot.onText(/\/setsingledelay (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const v = parseFloat(match[1]);
    if (isNaN(v) || v < 1) { await adminReply(bot, msg.chat.id, "❌ رقم غير صحيح (ثانية واحدة على الأقل)"); return; }
    SINGLE_DELAY_MS = v * 1000;
    await adminReply(bot, msg.chat.id, `✅ تأخير Single: <b>${v}</b> ثانية بين كل سحب`);
  });

  // ─── /clearqueue ──────────────────────────────────────
  bot.onText(/\/clearqueue/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات pending"); return; }
      const count = Object.keys(items).length;
      const updates = {};
      Object.keys(items).forEach(id => { updates[`${id}/status`] = "cancelled"; updates[`${id}/updatedAt`] = Date.now(); updates[`${id}/holdReason`] = "إلغاء جماعي من الأدمن"; });
      await db.ref("withdrawQueue").update(updates);
      await adminReply(bot, msg.chat.id, `🗑 تم إلغاء <b>${count}</b> سحب من القائمة`);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /retryall ────────────────────────────────────────
  bot.onText(/\/retryall/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").equalTo("failed").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات failed"); return; }
      const count = Object.keys(items).length;
      const updates = {};
      Object.keys(items).forEach(id => { updates[`${id}/status`] = "pending"; updates[`${id}/updatedAt`] = Date.now(); updates[`${id}/lastError`] = null; updates[`${id}/attempts`] = 0; });
      await db.ref("withdrawQueue").update(updates);
      await adminReply(bot, msg.chat.id, `🔄 تمت إعادة <b>${count}</b> سحب فاشل للمعالجة`);
      setTimeout(() => processPendingWithdrawals(), 1000);
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /banuser ─────────────────────────────────────────
  bot.onText(/\/banuser (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match[1].trim();
    await db.ref(`bannedUsers/${userId}`).set({ bannedAt: Date.now(), by: 'admin' });
    await adminReply(bot, msg.chat.id, `🚫 تم حظر المستخدم <code>${userId}</code>`);
  });

  // ─── /unbanuser ───────────────────────────────────────
  bot.onText(/\/unbanuser (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match[1].trim();
    await db.ref(`bannedUsers/${userId}`).remove();
    await adminReply(bot, msg.chat.id, `✅ تم رفع حظر المستخدم <code>${userId}</code>`);
  });

  // ─── /banwallet ───────────────────────────────────────
  bot.onText(/\/banwallet (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const addr = match[1].trim();
    const key  = addr.replace(/[.$#[\]/]/g, '_');
    await db.ref(`bannedWallets/${key}`).set({ address: addr, bannedAt: Date.now(), reason: 'يدوي من الأدمن' });
    await adminReply(bot, msg.chat.id, `🚫 تم حظر المحفظة:\n<code>${addr}</code>`);
  });

  // ─── /unwallet ────────────────────────────────────────
  bot.onText(/\/unwallet (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const addr = match[1].trim();
    const key  = addr.replace(/[.$#[\]/]/g, '_');
    await db.ref(`bannedWallets/${key}`).remove();
    await adminReply(bot, msg.chat.id, `✅ تم رفع حظر المحفظة:\n<code>${addr}</code>`);
  });

  // ─── /userinfo ────────────────────────────────────────
  bot.onText(/\/userinfo (.+)/, async (msg, match) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    const userId = match[1].trim();
    try {
      const [bannedSnap, wdSnap] = await Promise.all([
        db.ref(`bannedUsers/${userId}`).once("value"),
        db.ref("withdrawQueue").orderByChild("userId").equalTo(userId).once("value"),
      ]);
      const isBanned  = bannedSnap.exists();
      const wdItems   = wdSnap.val() || {};
      const allWds    = Object.values(wdItems);
      const paid      = allWds.filter(d => d.status === 'paid');
      const pending   = allWds.filter(d => ['pending','awaiting_approval','processing'].includes(d.status));
      const cancelled = allWds.filter(d => d.status === 'cancelled');
      const totalPaid = paid.reduce((s, d) => s + roundAmount(d.ton), 0);
      const wallets   = [...new Set(allWds.map(d => d.address).filter(Boolean))];

      let text =
        `👤 <b>معلومات المستخدم</b>\n` +
        `🆔 ID: <code>${userId}</code>\n` +
        `🚫 محظور: <b>${isBanned ? 'نعم ❌' : 'لا ✅'}</b>\n\n` +
        `📊 <b>السحوبات</b>\n` +
        `✅ مدفوعة: <b>${paid.length}</b> (${totalPaid.toFixed(3)} TON)\n` +
        `⏳ معلقة: <b>${pending.length}</b>\n` +
        `🚫 ملغاة: <b>${cancelled.length}</b>\n\n` +
        `📬 <b>المحافظ المستخدمة (${wallets.length})</b>\n`;
      wallets.slice(0, 5).forEach(w => { text += `• <code>${w}</code>\n`; });
      if (wallets.length > 5) text += `... و${wallets.length - 5} أخرى\n`;

      const keyboard = [];
      if (!isBanned) keyboard.push([{ text: "🚫 حظر المستخدم", callback_data: `ban_user:${userId}` }]);
      else           keyboard.push([{ text: "✅ رفع الحظر", callback_data: `unban_user:${userId}` }]);

      await adminReply(bot, msg.chat.id, text, { reply_markup: { inline_keyboard: keyboard } });
    } catch(e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /pause & /resume ─────────────────────────────────
  bot.onText(/\/pause/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    systemPaused = true;
    await adminReply(bot, msg.chat.id, "⏸ System paused");
  });

  bot.onText(/\/resume/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    systemPaused = false;
    await adminReply(bot, msg.chat.id, "▶️ System resumed");
    setTimeout(() => processPendingWithdrawals(), 1000);
  });

  // ─── /process ─────────────────────────────────────────
  bot.onText(/\/process/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    await adminReply(bot, msg.chat.id, "🔄 Starting batch processing...");
    setTimeout(() => processPendingWithdrawals(), 500);
  });

  // ─── /check_suspicious ────────────────────────────────
  // يفحص السحوبات المعلقة ويكشف المحافظ المشتركة بين أكثر من 3 مستخدمين مختلفين
  bot.onText(/\/check_suspicious/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      await adminReply(bot, msg.chat.id, "🔍 جاري فحص السحوبات المعلقة بحثاً عن التلاعب...");

      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات في القائمة"); return; }

      // تجميع: محفظة → Set من userIds
      const walletUsers = {}; // { address: { userIds: Set, withdrawIds: [] } }

      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'processing'].includes(status)) return;
        if (!d.address || !d.userId) return;

        const addr = d.address;
        if (!walletUsers[addr]) walletUsers[addr] = { userIds: new Set(), withdrawIds: [], totalTon: 0 };
        walletUsers[addr].userIds.add(String(d.userId));
        walletUsers[addr].withdrawIds.push(id);
        walletUsers[addr].totalTon += roundAmount(d.ton);
      });

      // فلترة: فقط المحافظ التي استخدمها أكثر من 3 مستخدمين
      const suspicious = Object.entries(walletUsers)
        .filter(([, v]) => v.userIds.size > 3)
        .sort((a, b) => b[1].userIds.size - a[1].userIds.size);

      if (!suspicious.length) {
        await adminReply(bot, msg.chat.id,
          `✅ <b>لم يتم اكتشاف أي نشاط مشبوه</b>\n\nلا توجد محفظة استخدمها أكثر من 3 مستخدمين في السحوبات المعلقة.`
        );
        return;
      }

      let text = `🚨 <b>محافظ مشبوهة — تعدد حسابات</b>\n`;
      text += `اكتُشفت <b>${suspicious.length}</b> محفظة مشتركة بين أكثر من 3 مستخدمين\n`;
      text += `${'━'.repeat(32)}\n\n`;

      for (let i = 0; i < suspicious.length; i++) {
        const [addr, data] = suspicious[i];
        const shortAddr = addr.substring(0, 6) + '...' + addr.substring(addr.length - 4);
        const userList  = [...data.userIds].join(', ');
        text +=
          `🔴 <b>محفظة ${i + 1}</b>\n` +
          `📬 <code>${addr}</code>\n` +
          `👥 عدد المستخدمين: <b>${data.userIds.size}</b>\n` +
          `🆔 المستخدمون: <code>${userList}</code>\n` +
          `📋 طلبات معلقة: <b>${data.withdrawIds.length}</b>\n` +
          `💰 إجمالي مطلوب: <b>${data.totalTon.toFixed(3)} TON</b>\n\n`;

        // إذا الرسالة طويلة — أرسلها وابدأ رسالة جديدة
        if (text.length > 3000 && i < suspicious.length - 1) {
          await adminReply(bot, msg.chat.id, text, {
            reply_markup: { inline_keyboard: [[
              { text: "🚫 رفض جميع المشبوهين", callback_data: "reject_all_suspicious" }
            ]]}
          });
          text = `🚨 <b>تابع — محافظ مشبوهة</b>\n\n`;
        }
      }

      text += `${'━'.repeat(32)}\n`;
      text += `⚡ استخدم /reject_suspicious لرفض جميع طلباتهم دفعةً واحدة`;

      await adminReply(bot, msg.chat.id, text, {
        reply_markup: { inline_keyboard: [[
          { text: "🚫 رفض جميع المشبوهين الآن", callback_data: "reject_all_suspicious" }
        ]]}
      });

    } catch (e) { await adminReply(bot, msg.chat.id, `❌ خطأ: ${e.message}`); }
  });

  // ─── /reject_suspicious ───────────────────────────────
  // يرفض جميع طلبات السحب المعلقة للمستخدمين المشبوهين (محفظة مشتركة > 3)
  bot.onText(/\/reject_suspicious/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      await adminReply(bot, msg.chat.id, "🔍 جاري تحليل البيانات وتنفيذ الرفض...");

      const snap  = await db.ref("withdrawQueue").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات"); return; }

      // تجميع المحافظ المشبوهة
      const walletUsers = {};
      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'processing'].includes(status)) return;
        if (!d.address || !d.userId) return;
        const addr = d.address;
        if (!walletUsers[addr]) walletUsers[addr] = { userIds: new Set(), entries: [] };
        walletUsers[addr].userIds.add(String(d.userId));
        walletUsers[addr].entries.push({ id, ...d });
      });

      // جمع كل الطلبات والمستخدمين المشبوهين
      const suspiciousUserIds = new Set();
      const suspiciousWallets = new Set();
      Object.entries(walletUsers).forEach(([addr, v]) => {
        if (v.userIds.size > 3) {
          suspiciousWallets.add(addr);
          v.userIds.forEach(uid => suspiciousUserIds.add(uid));
        }
      });

      if (!suspiciousUserIds.size) {
        await adminReply(bot, msg.chat.id, "✅ لا يوجد مستخدمون مشبوهون للرفض");
        return;
      }

      // رفض جميع طلبات هؤلاء المستخدمين (المعلقة فقط)
      let rejectedCount = 0;
      const rejectPromises = [];

      Object.entries(items).forEach(([id, d]) => {
        const status = d.status || '';
        if (!['pending', 'awaiting_approval', 'processing'].includes(status)) return;
        if (!suspiciousUserIds.has(String(d.userId))) return;

        rejectPromises.push(
          db.ref(`withdrawQueue/${id}`).update({
            status:    "cancelled",
            updatedAt: Date.now(),
            holdReason: `مرفوض تلقائياً — تعدد حسابات (محفظة مشتركة مع ${walletUsers[d.address]?.userIds.size || '?'} مستخدمين)`,
          }).then(async () => {
            if (d.userId && d.wdId) {
              await db.ref(`users/${d.userId}/wdHistory/${d.wdId}`).update({
                status: "cancelled", updatedAt: Date.now()
              }).catch(() => {});
            }
            rejectedCount++;
          }).catch(() => {})
        );
      });

      await Promise.all(rejectPromises);

      // تسجيل المحافظ المشبوهة في bannedWallets تلقائياً
      const banPromises = [];
      suspiciousWallets.forEach(addr => {
        const key = addr.replace(/[.$#[\]/]/g, '_');
        banPromises.push(
          db.ref(`bannedWallets/${key}`).set({
            address:   addr,
            reason:    "تعدد حسابات — كشف تلقائي",
            bannedAt:  Date.now(),
            userCount: walletUsers[addr]?.userIds.size || 0,
          }).catch(() => {})
        );
      });
      await Promise.all(banPromises);

      await adminReply(bot, msg.chat.id,
        `✅ <b>تم تنفيذ الرفض الجماعي</b>\n\n` +
        `${'━'.repeat(30)}\n` +
        `🚫 طلبات مرفوضة: <b>${rejectedCount}</b>\n` +
        `👥 مستخدمون متأثرون: <b>${suspiciousUserIds.size}</b>\n` +
        `📬 محافظ محظورة: <b>${suspiciousWallets.size}</b>\n` +
        `${'━'.repeat(30)}\n\n` +
        `🔒 تم حظر المحافظ المشبوهة تلقائياً في <code>bannedWallets</code>\n` +
        `🆔 المستخدمون: <code>${[...suspiciousUserIds].join(', ')}</code>`
      );

    } catch (e) { await adminReply(bot, msg.chat.id, `❌ خطأ: ${e.message}`); }
  });

  // ─── Callback: رفض جميع المشبوهين بضغطة زر ──────────
  // (يُعيد توجيه لنفس منطق /reject_suspicious)
  bot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== ADMIN_CHAT_ID) return;
    if (query.data === 'reject_all_suspicious') {
      await bot.answerCallbackQuery(query.id, { text: "🔄 جاري تنفيذ الرفض..." });
      // نفّذ نفس منطق reject_suspicious مباشرة
      await bot.sendMessage(ADMIN_CHAT_ID, "/reject_suspicious");
    }
  });

  // ─── Callback: موافقة / رفض السحب ────────────────────
  bot.on('callback_query', async (query) => {
    if (query.message.chat.id.toString() !== ADMIN_CHAT_ID) return;
    const data   = query.data || '';
    const chatId = query.message.chat.id;
    const msgId  = query.message.message_id;

    // ── حظر / رفع حظر مستخدم من /userinfo ──
    if (data.startsWith('ban_user:')) {
      const uid = data.replace('ban_user:', '').trim();
      await db.ref(`bannedUsers/${uid}`).set({ bannedAt: Date.now(), by: 'admin' });
      await bot.answerCallbackQuery(query.id, { text: `🚫 تم حظر ${uid}` });
      await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "✅ رفع الحظر", callback_data: `unban_user:${uid}` }]] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }

    if (data.startsWith('unban_user:')) {
      const uid = data.replace('unban_user:', '').trim();
      await db.ref(`bannedUsers/${uid}`).remove();
      await bot.answerCallbackQuery(query.id, { text: `✅ تم رفع حظر ${uid}` });
      await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: "🚫 حظر المستخدم", callback_data: `ban_user:${uid}` }]] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
    }

    // ── إعادة معالجة ──
    if (data.startsWith('reprocess_wd:')) {
      const withdrawId = data.replace('reprocess_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ السحب غير موجود!" }); return; }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", updatedAt: Date.now(), lastError: null });
        await bot.editMessageText(
          query.message.text + `\n\n🔄 <b>تمت إعادة الإضافة للمعالجة</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await bot.answerCallbackQuery(query.id, { text: "🔄 تمت إعادة الإضافة للقائمة" });
        setTimeout(() => processPendingWithdrawals(), 1000);
      } catch (e) {
        await bot.answerCallbackQuery(query.id, { text: `❌ خطأ: ${e.message}` });
      }
    }

    // ── موافقة ──
    if (data.startsWith('approve_wd:')) {
      const withdrawId = data.replace('approve_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ السحب غير موجود!" }); return; }
        if (wd.status !== 'awaiting_approval') {
          await bot.answerCallbackQuery(query.id, { text: `⚠️ الحالة الحالية: ${wd.status}` });
          return;
        }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "pending", approvedByAdmin: true, updatedAt: Date.now(), holdReason: null });
        await bot.editMessageText(
          query.message.text + `\n\n✅ <b>تمت الموافقة</b> — جاري الدفع...`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await bot.answerCallbackQuery(query.id, { text: "✅ تمت الموافقة — سيتم الدفع الآن" });
        console.log(`✅ Admin approved: ${withdrawId}`);
        setTimeout(() => processPendingWithdrawals(), 1000);
      } catch (e) {
        await bot.answerCallbackQuery(query.id, { text: `❌ خطأ: ${e.message}` });
        console.log(`❌ approve_wd error: ${e.message}`);
      }
    }

    // ── رفض ──
    if (data.startsWith('reject_wd:')) {
      const withdrawId = data.replace('reject_wd:', '').trim();
      try {
        const snap = await db.ref(`withdrawQueue/${withdrawId}`).once("value");
        const wd   = snap.val();
        if (!wd) { await bot.answerCallbackQuery(query.id, { text: "❌ السحب غير موجود!" }); return; }
        if (wd.status !== 'awaiting_approval') {
          await bot.answerCallbackQuery(query.id, { text: `⚠️ الحالة الحالية: ${wd.status}` });
          return;
        }
        await db.ref(`withdrawQueue/${withdrawId}`).update({ status: "cancelled", updatedAt: Date.now(), holdReason: "رُفض من الأدمن" });
        if (wd.userId && wd.wdId) {
          await db.ref(`users/${wd.userId}/wdHistory/${wd.wdId}`).update({ status: "cancelled", updatedAt: Date.now() });
        }
        await bot.editMessageText(
          query.message.text + `\n\n❌ <b>تم الرفض والإلغاء</b>`,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } }
        );
        await bot.answerCallbackQuery(query.id, { text: "❌ تم رفض وإلغاء السحب" });
        console.log(`❌ Admin rejected: ${withdrawId}`);
      } catch (e) {
        await bot.answerCallbackQuery(query.id, { text: `❌ خطأ: ${e.message}` });
        console.log(`❌ reject_wd error: ${e.message}`);
      }
    }
  });

  // ─── /pending_reasons ─────────────────────────────────
  bot.onText(/\/pending_reasons/, async (msg) => {
    if (!isAdmin(msg)) { await unauth(msg); return; }
    try {
      const snap  = await db.ref("withdrawQueue").orderByChild("status").once("value");
      const items = snap.val();
      if (!items) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات"); return; }

      const held = Object.entries(items)
        .map(([id, d]) => ({ id, ...d }))
        .filter(w => ['pending', 'awaiting_approval'].includes(w.status))
        .sort((a, b) => (a.ts || 0) - (b.ts || 0));

      if (!held.length) { await adminReply(bot, msg.chat.id, "📭 لا توجد سحوبات معلقة حالياً"); return; }

      const CHUNK = 15;
      for (let i = 0; i < held.length; i += CHUNK) {
        const chunk = held.slice(i, i + CHUNK);
        let text = i === 0
          ? `📋 <b>السحوبات المعلقة (${held.length})</b>\n\n`
          : `📋 <b>تابع... (${i + 1}–${Math.min(i + CHUNK, held.length)})</b>\n\n`;

        chunk.forEach((w, idx) => {
          const ton    = roundAmount(w.ton);
          const time   = w.ts ? new Date(w.ts).toLocaleString('en-GB', { timeZone: 'UTC', hour12: false }) : '—';
          const status = w.status === 'awaiting_approval' ? '⏳ بانتظار موافقة' : '🔄 pending';
          let reason = '—';
          if (w.holdReason)  reason = w.holdReason;
          else if (w.lastError) reason = w.lastError;
          else if (w.error)     reason = w.error;
          else if (w.status === 'awaiting_approval') reason = 'تجاوز الحد اليومي';
          else if (ton > MAX_WITHDRAWAL_AMOUNT)      reason = `يتجاوز الحد الأقصى (${MAX_WITHDRAWAL_AMOUNT} TON)`;
          else if (ton < MIN_WITHDRAWAL_AMOUNT)      reason = `أقل من الحد الأدنى (${MIN_WITHDRAWAL_AMOUNT} TON)`;

          text +=
            `${i + idx + 1}. ${status}\n` +
            `   🆔 <code>${w.id}</code>\n` +
            `   👤 User: <code>${w.userId || '?'}</code>\n` +
            `   💰 ${ton} TON | 🪙 ${Number(w.amt || 0).toLocaleString()}\n` +
            `   ⚠️ السبب: ${reason}\n` +
            `   🕐 ${time} UTC\n\n`;
        });

        await adminReply(bot, msg.chat.id, text);
        if (i + CHUNK < held.length) await new Promise(r => setTimeout(r, 500));
      }
    } catch (e) { await adminReply(bot, msg.chat.id, `❌ ${e.message}`); }
  });

  bot.on('polling_error', () => {});
  console.log("✅ Bot running with all admin commands + Batch system");
}

// ==========================
// 🔹 استرداد السحوبات العالقة
// ==========================
setInterval(async () => {
  if (systemPaused) return;
  try {
    const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("processing").once("value");
    const items = snap.val();
    if (!items) return;
    const stuckThreshold = Date.now() - 5 * 60 * 1000;
    let recovered = 0;
    for (const [id, data] of Object.entries(items)) {
      if ((data.updatedAt || 0) < stuckThreshold) {
        await db.ref(`withdrawQueue/${id}`).update({
          status: "pending", updatedAt: Date.now(),
          lastError: "Recovered from stuck processing state",
        });
        processingQueue.delete(id);
        console.log(`♻️ Recovered stuck withdrawal: ${id}`);
        recovered++;
      }
    }
    if (recovered > 0) {
      console.log(`♻️ Recovered ${recovered} stuck — triggering re-process`);
      setTimeout(() => processPendingWithdrawals(), 2000);
    }
  } catch (e) { console.log(`❌ stuckRecovery: ${e.message}`); }
}, 2 * 60 * 1000);

// ==========================
// 🔹 Flush Timer (كل 30 ثانية — يعالج الدفعات الجزئية)
// ==========================
setInterval(async () => {
  if (!systemPaused && !isProcessing) {
    const snap = await db.ref("withdrawQueue").orderByChild("status").equalTo("pending").once("value").catch(() => null);
    if (snap && snap.exists()) {
      console.log(`⏰ Flush timer — running batch process`);
      processPendingWithdrawals();
    }
  }
}, BATCH_FLUSH_SECONDS * 1000);

// ==========================
// 🔹 Start
// ==========================
console.log("\n" + "=".repeat(50));
console.log("🐼 PANDA BAMBOO WITHDRAWAL BOT — BATCH MODE");
console.log("=".repeat(50));
console.log(`FIREBASE: ${process.env.FIREBASE_SERVICE_ACCOUNT ? '✅' : '❌'}`);
console.log(`TON_API_KEY: ${process.env.TON_API_KEY ? '✅' : '❌'}`);
console.log(`TON_MNEMONIC: ${process.env.TON_MNEMONIC ? '✅' : '❌'}`);
console.log(`TELEGRAM_BOT_TOKEN: ${process.env.TELEGRAM_BOT_TOKEN ? '✅' : '❌'}`);
console.log(`📦 Batch size: ${BATCH_SIZE} | Flush: ${BATCH_FLUSH_SECONDS}s | Between batches: ${BATCH_BETWEEN_DELAY / 1000}s`);

startWelcomeBot();

getWallet().then(async () => {
  const b = await getWalletBalance();
  console.log(`💰 Wallet balance: ${b.toFixed(4)} TON`);
  await processPendingWithdrawals();
}).catch(err => { console.error("❌ Wallet error:", err.message); });

// دورة معالجة كل دقيقة
setInterval(async () => {
  if (!systemPaused) await processPendingWithdrawals();
}, 60000);

// listener لأي سحب جديد
db.ref("withdrawQueue").on("child_added", async (snap) => {
  if (systemPaused) return;
  const data = snap.val();
  if (data?.status === "pending" && !processingQueue.has(snap.key)) {
    console.log(`📢 New withdrawal: ${snap.key}`);
    setTimeout(() => processPendingWithdrawals(), 2000);
  }
});

db.ref(".info/connected").on("value", (snap) => { if (snap.val()) console.log("📡 Firebase connected"); });

console.log("💸 Running | 📬 @PandaBambooPayouts | 👤 Admin:", ADMIN_CHAT_ID);
console.log("=".repeat(50) + "\n");
