'use strict';

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const axios = require('axios');
const crypto = require('crypto');

admin.initializeApp();
const db = admin.firestore();

const XERO_AUTH_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
const FUNCTION_BASE = 'https://us-central1-rx-audit.cloudfunctions.net';

// Secrets — set via: firebase functions:secrets:set XERO_CLIENT_ID
const XERO_CLIENT_ID = defineSecret('XERO_CLIENT_ID');
const XERO_CLIENT_SECRET = defineSecret('XERO_CLIENT_SECRET');
const XERO_WEBHOOK_KEY = defineSecret('XERO_WEBHOOK_KEY');

// ── HELPERS ────────────────────────────────────────────────────

async function getXeroToken() {
  const doc = await db.collection('billing').doc('xeroTokens').get();
  if (!doc.exists) throw new Error('Xero not connected — visit /xeroAuth first');
  const d = doc.data();

  if (Date.now() >= d.expiry - 300000) {
    const res = await axios.post(
      XERO_TOKEN_URL,
      `grant_type=refresh_token&refresh_token=${encodeURIComponent(d.refreshToken)}`,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(
            `${XERO_CLIENT_ID.value()}:${XERO_CLIENT_SECRET.value()}`
          ).toString('base64'),
        },
      }
    );
    const tokens = {
      accessToken: res.data.access_token,
      refreshToken: res.data.refresh_token,
      expiry: Date.now() + res.data.expires_in * 1000,
    };
    await db.collection('billing').doc('xeroTokens').update(tokens);
    return tokens.accessToken;
  }
  return d.accessToken;
}

async function getXeroTenantId() {
  const doc = await db.collection('billing').doc('config').get();
  if (!doc.exists) throw new Error('Xero tenant not configured');
  return doc.data().xeroTenantId;
}

async function ensureXeroContact(nurseId, nurseName, nurseEmail, token, tenantId) {
  const ref = db.collection('billing').doc(nurseId);
  const snap = await ref.get();
  if (snap.exists && snap.data().xeroContactId) return snap.data().xeroContactId;

  const res = await axios.post(
    `${XERO_API_BASE}/Contacts`,
    { Contacts: [{ Name: nurseName, EmailAddress: nurseEmail || '' }] },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'xero-tenant-id': tenantId,
        'Content-Type': 'application/json',
      },
    }
  );
  const contactId = res.data.Contacts[0].ContactID;
  await ref.set({ xeroContactId: contactId }, { merge: true });
  return contactId;
}

// ── XERO OAUTH ─────────────────────────────────────────────────

exports.xeroAuth = onRequest(
  { secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET] },
  (req, res) => {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: XERO_CLIENT_ID.value(),
      redirect_uri: `${FUNCTION_BASE}/xeroCallback`,
      scope: 'accounting.contacts accounting.transactions accounting.settings offline_access',
      state: crypto.randomBytes(16).toString('hex'),
    });
    res.redirect(`${XERO_AUTH_URL}?${params}`);
  }
);

exports.xeroCallback = onRequest(
  { secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET] },
  async (req, res) => {
    try {
      const { code } = req.query;
      if (!code) { res.status(400).send('Missing authorization code'); return; }

      const tokenRes = await axios.post(
        XERO_TOKEN_URL,
        `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(`${FUNCTION_BASE}/xeroCallback`)}`,
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(
              `${XERO_CLIENT_ID.value()}:${XERO_CLIENT_SECRET.value()}`
            ).toString('base64'),
          },
        }
      );

      const tenantsRes = await axios.get('https://api.xero.com/connections', {
        headers: { Authorization: `Bearer ${tokenRes.data.access_token}` },
      });
      const tenantId = tenantsRes.data[0].tenantId;
      const tenantName = tenantsRes.data[0].tenantName;

      await db.collection('billing').doc('xeroTokens').set({
        accessToken: tokenRes.data.access_token,
        refreshToken: tokenRes.data.refresh_token,
        expiry: Date.now() + tokenRes.data.expires_in * 1000,
      });
      await db.collection('billing').doc('config').set(
        { xeroTenantId: tenantId, xeroTenantName: tenantName, xeroConnected: true },
        { merge: true }
      );

      res.send(`
        <html><body style="font-family:sans-serif;padding:40px;text-align:center;">
        <h2 style="color:#1a4d6e;">&#10003; Xero Connected</h2>
        <p>Organisation: <strong>${tenantName}</strong></p>
        <p>You can close this tab and return to RxAudit.</p>
        </body></html>
      `);
    } catch (e) {
      console.error('xeroCallback error:', e.response ? e.response.data : e.message);
      res.status(500).send('Xero connection failed: ' + e.message);
    }
  }
);

// ── BILLING RUN ────────────────────────────────────────────────

async function runBillingForAllNurses(clientId, clientSecret) {
  const token = await getXeroToken();
  const tenantId = await getXeroTenantId();

  const usersDoc = await db.collection('data').doc('users').get();
  const users = usersDoc.exists ? (usersDoc.data().list || []) : [];
  const nurses = users.filter(u => u.role === 'nurse' && u.active !== false);

  const now = new Date();
  const monthLabel = now.toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'Australia/Brisbane' });
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const dueDateStr = now.toISOString().split('T')[0];
  const results = [];

  for (const nurse of nurses) {
    const nurseId = String(nurse.id);
    try {
      const billingSnap = await db.collection('billing').doc(nurseId).get();
      const billing = billingSnap.exists ? billingSnap.data() : {};
      const monthlyRate = billing.monthlyRate || 0;
      if (!monthlyRate) { results.push({ nurse: nurse.name, status: 'skipped', reason: 'no rate set' }); continue; }

      const existing = await db.collection('billingPayments')
        .where('nurseId', '==', nurseId).where('month', '==', monthKey).limit(1).get();
      if (!existing.empty) { results.push({ nurse: nurse.name, status: 'skipped', reason: 'already invoiced this month' }); continue; }

      const contactId = await ensureXeroContact(nurseId, nurse.name, nurse.email || '', token, tenantId);
      const gst = Math.round(monthlyRate * 0.1 * 100) / 100;
      const invoiceNumber = `RXAUDIT-${nurse.name.replace(/\s+/g, '').toUpperCase().slice(0, 6)}-${monthKey.replace('-', '')}`;

      const invoiceRes = await axios.post(
        `${XERO_API_BASE}/Invoices`,
        {
          Invoices: [{
            Type: 'ACCREC',
            Contact: { ContactID: contactId },
            DueDate: dueDateStr,
            InvoiceNumber: invoiceNumber,
            Status: 'AUTHORISED',
            SentToContact: true,
            LineItems: [{
              Description: `RxAudit Platform — ${monthLabel}`,
              Quantity: 1,
              UnitAmount: monthlyRate,
              AccountCode: '200',
              TaxType: 'OUTPUT2',
            }],
          }],
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'xero-tenant-id': tenantId,
            'Content-Type': 'application/json',
          },
        }
      );

      const inv = invoiceRes.data.Invoices[0];
      await db.collection('billingPayments').add({
        nurseId,
        nurseName: nurse.name,
        nurseClinic: nurse.clinic || '',
        amount: monthlyRate,
        gst,
        total: monthlyRate + gst,
        date: dueDateStr,
        month: monthKey,
        xeroInvoiceId: inv.InvoiceID,
        xeroInvoiceNumber: inv.InvoiceNumber,
        status: 'PENDING',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      await db.collection('billing').doc(nurseId).set({
        status: 'PENDING',
        lastInvoiceDate: dueDateStr,
        lastInvoiceId: inv.InvoiceID,
        lastInvoiceNumber: inv.InvoiceNumber,
        lastInvoiceAmount: monthlyRate + gst,
      }, { merge: true });

      results.push({ nurse: nurse.name, status: 'invoiced', invoice: inv.InvoiceNumber });
    } catch (e) {
      console.error(`Billing failed for ${nurse.name}:`, e.response ? JSON.stringify(e.response.data) : e.message);
      results.push({ nurse: nurse.name, status: 'error', error: e.message });
    }
  }
  return results;
}

exports.monthlyBillingRun = onSchedule(
  { schedule: '0 22 * * *', timeZone: 'Australia/Brisbane', secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET] },
  async () => {
    try {
      const configDoc = await db.collection('billing').doc('config').get();
      if (!configDoc.exists) return;
      const billingDay = configDoc.data().billingDay;
      if (!billingDay) return;

      const dayInBrisbane = parseInt(
        new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Brisbane', day: 'numeric' }).format(new Date()), 10
      );
      if (dayInBrisbane !== billingDay) return;

      console.log(`Billing day ${billingDay} matched — running invoices`);
      const results = await runBillingForAllNurses();
      console.log('Billing run complete', JSON.stringify(results));
    } catch (e) {
      console.error('Scheduled billing run failed:', e.message);
    }
  }
);

exports.triggerBillingNow = onCall(
  { secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET] },
  async () => {
    try {
      const results = await runBillingForAllNurses();
      return { success: true, results };
    } catch (e) {
      throw new HttpsError('internal', e.message);
    }
  }
);

// ── XERO WEBHOOK ───────────────────────────────────────────────

exports.xeroWebhook = onRequest(
  { secrets: [XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_WEBHOOK_KEY] },
  async (req, res) => {
    try {
      const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body);
      const signature = req.headers['x-xero-signature'];
      const webhookKey = XERO_WEBHOOK_KEY.value();

      if (webhookKey && signature) {
        const expected = crypto.createHmac('sha256', webhookKey).update(rawBody).digest('base64');
        if (signature !== expected) { res.status(401).send('Invalid signature'); return; }
      }

      const events = (req.body && req.body.events) ? req.body.events : [];
      for (const event of events) {
        if (event.resourceType !== 'INVOICE' || event.eventType !== 'UPDATE') continue;
        const invoiceId = event.resourceId;
        if (!invoiceId) continue;

        try {
          const token = await getXeroToken();
          const tenantId = await getXeroTenantId();
          const invRes = await axios.get(`${XERO_API_BASE}/Invoices/${invoiceId}`, {
            headers: { Authorization: `Bearer ${token}`, 'xero-tenant-id': tenantId },
          });
          const inv = invRes.data.Invoices[0];
          const xeroStatus = inv.Status;

          const payments = await db.collection('billingPayments').where('xeroInvoiceId', '==', invoiceId).get();
          for (const doc of payments.docs) {
            const update = { status: xeroStatus };
            if (xeroStatus === 'PAID') update.paidDate = new Date().toISOString().split('T')[0];
            await doc.ref.update(update);
            const nurseId = doc.data().nurseId;
            await db.collection('billing').doc(nurseId).set({
              status: xeroStatus === 'PAID' ? 'PAID' : (xeroStatus === 'VOIDED' ? 'VOIDED' : 'OVERDUE'),
              ...(xeroStatus === 'PAID' ? { lastPaidDate: new Date().toISOString().split('T')[0] } : {}),
            }, { merge: true });
          }
        } catch (innerErr) {
          console.warn('Webhook invoice update failed:', innerErr.message);
        }
      }
      res.status(200).send('OK');
    } catch (e) {
      console.error('Webhook handler error:', e.message);
      res.status(500).send('Error');
    }
  }
);

// ── STATUS ENDPOINT ────────────────────────────────────────────

exports.xeroStatus = onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const doc = await db.collection('billing').doc('config').get();
    if (!doc.exists || !doc.data().xeroConnected) { res.json({ connected: false }); return; }
    res.json({ connected: true, organisation: doc.data().xeroTenantName || '' });
  } catch (e) {
    res.json({ connected: false, error: e.message });
  }
});
