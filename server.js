require('dotenv').config();
const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool, types } = require('pg');

types.setTypeParser(1082, v => v); // return DATE columns as 'YYYY-MM-DD' text

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SECRET = process.env.JWT_SECRET || 'change-me';
const q = (text, params) => pool.query(text, params);

const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
// patient blood group -> donor groups that can give to them
const COMPAT = {
  'A+': ['A+', 'A-', 'O+', 'O-'], 'A-': ['A-', 'O-'],
  'B+': ['B+', 'B-', 'O+', 'O-'], 'B-': ['B-', 'O-'],
  'AB+': GROUPS, 'AB-': ['A-', 'B-', 'AB-', 'O-'],
  'O+': ['O+', 'O-'], 'O-': ['O-'],
};

// ---------- helpers ----------
const wrap = fn => (req, res) =>
  fn(req, res).catch(e => { console.error(e); res.status(500).json({ error: 'Server error' }); });

const auth = roles => (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const user = jwt.verify(token, SECRET);
    if (roles && !roles.includes(user.role)) return res.status(403).json({ error: 'Not allowed' });
    req.user = user;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Please log in' });
  }
};

const donorIdOf = async uid => (await q('SELECT donor_id FROM donors WHERE user_id=$1', [uid])).rows[0]?.donor_id;
const facilityIdOf = async uid => (await q('SELECT facility_id FROM hospitals WHERE user_id=$1', [uid])).rows[0]?.facility_id;

// ---------- public (no login) ----------
app.get('/api/public/stats', wrap(async (req, res) => {
  const r = await q(`SELECT (SELECT COUNT(*) FROM donors)::int AS donors,
                            (SELECT COUNT(*) FROM hospitals)::int AS hospitals,
                            (SELECT COUNT(*) FROM donations)::int AS donations,
                            (SELECT COUNT(*) FROM blood_requests WHERE status IN ('Pending','Notified','Matched'))::int AS open_requests`);
  res.json(r.rows[0]);
}));

// ---------- auth ----------
app.post('/api/register', wrap(async (req, res) => {
  const { name, email, password, phone, role, blood_group, date_of_birth, location,
          facility_name, license_no, address } = req.body;
  if (!name || !email || !password || password.length < 6)
    return res.status(400).json({ error: 'Name, email and a password of at least 6 characters are required' });
  if (!['donor', 'hospital'].includes(role)) return res.status(400).json({ error: 'Choose a role' });
  if (role === 'donor' && !GROUPS.includes(blood_group)) return res.status(400).json({ error: 'Choose your blood group' });
  if (role === 'hospital' && !facility_name) return res.status(400).json({ error: 'Facility name is required' });

  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      'INSERT INTO users(name,email,phone,password_hash,role) VALUES($1,$2,$3,$4,$5) RETURNING user_id',
      [name, email.toLowerCase(), phone || null, hash, role]);
    const uid = u.rows[0].user_id;
    if (role === 'donor')
      await client.query('INSERT INTO donors(user_id,blood_group,date_of_birth,location) VALUES($1,$2,$3,$4)',
        [uid, blood_group, date_of_birth || null, location || null]);
    else
      await client.query('INSERT INTO hospitals(user_id,facility_name,license_no,address) VALUES($1,$2,$3,$4)',
        [uid, facility_name, license_no || null, address || null]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') return res.status(400).json({ error: 'This email is already registered' });
    throw e;
  } finally {
    client.release();
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  const r = await q('SELECT * FROM users WHERE email=$1', [(email || '').toLowerCase()]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'Wrong email or password' });
  if (!u.is_active) return res.status(403).json({ error: 'Your account is deactivated' });
  const token = jwt.sign({ id: u.user_id, role: u.role, name: u.name }, SECRET, { expiresIn: '8h' });
  res.json({ token, role: u.role, name: u.name });
}));

// ---------- donor ----------
app.get('/api/donor/profile', auth(['donor']), wrap(async (req, res) => {
  const r = await q(`SELECT u.name,u.email,u.phone,d.blood_group,d.location,d.last_donation_date,d.availability
                     FROM donors d JOIN users u ON u.user_id=d.user_id WHERE d.user_id=$1`, [req.user.id]);
  const p = r.rows[0];
  let next = null;
  if (p.last_donation_date) {
    const n = new Date(p.last_donation_date);
    n.setDate(n.getDate() + 56); // 8 weeks between donations
    next = n.toISOString().slice(0, 10);
  }
  const today = new Date().toISOString().slice(0, 10);
  res.json({ ...p, next_date: next, eligible: p.availability && (!next || next <= today) });
}));

app.put('/api/donor/profile', auth(['donor']), wrap(async (req, res) => {
  const { phone, location, availability } = req.body;
  await q('UPDATE users SET phone=$1 WHERE user_id=$2', [phone || null, req.user.id]);
  await q('UPDATE donors SET location=$1, availability=$2 WHERE user_id=$3', [location || null, !!availability, req.user.id]);
  res.json({ ok: true });
}));

app.get('/api/donor/requests', auth(['donor']), wrap(async (req, res) => {
  const did = await donorIdOf(req.user.id);
  const r = await q(`SELECT m.match_id, m.status AS match_status, r.request_id, r.blood_group, r.quantity,
                            r.urgency, r.request_date, h.facility_name, h.address
                     FROM request_matches m
                     JOIN blood_requests r ON r.request_id=m.request_id
                     JOIN hospitals h ON h.facility_id=r.facility_id
                     WHERE m.donor_id=$1 ORDER BY r.request_id DESC`, [did]);
  res.json(r.rows);
}));

app.post('/api/donor/matches/:id/respond', auth(['donor']), wrap(async (req, res) => {
  const did = await donorIdOf(req.user.id);
  const status = req.body.response === 'accepted' ? 'Accepted' : 'Declined';
  const r = await q(`UPDATE request_matches SET status=$1 WHERE match_id=$2 AND donor_id=$3 AND status='Notified'
                     RETURNING request_id`, [status, req.params.id, did]);
  if (!r.rowCount) return res.status(400).json({ error: 'Already answered' });
  if (status === 'Accepted')
    await q(`UPDATE blood_requests SET status='Matched' WHERE request_id=$1 AND status IN ('Pending','Notified')`,
      [r.rows[0].request_id]);
  res.json({ ok: true });
}));

app.get('/api/donor/donations', auth(['donor']), wrap(async (req, res) => {
  const did = await donorIdOf(req.user.id);
  const r = await q(`SELECT d.donation_date, d.volume, h.facility_name FROM donations d
                     JOIN hospitals h ON h.facility_id=d.facility_id
                     WHERE d.donor_id=$1 ORDER BY d.donation_date DESC, d.donation_id DESC`, [did]);
  res.json(r.rows);
}));

app.get('/api/donor/notifications', auth(['donor']), wrap(async (req, res) => {
  const did = await donorIdOf(req.user.id);
  const r = await q('SELECT message, sent_date FROM notifications WHERE donor_id=$1 ORDER BY sent_date DESC LIMIT 20', [did]);
  res.json(r.rows);
}));

// ---------- hospital / blood bank ----------
app.post('/api/requests', auth(['hospital']), wrap(async (req, res) => {
  const { blood_group, quantity, urgency } = req.body;
  const qty = parseInt(quantity);
  if (!GROUPS.includes(blood_group) || !(qty > 0)) return res.status(400).json({ error: 'Choose a blood group and a valid number of units' });
  const fid = await facilityIdOf(req.user.id);
  const hosp = (await q('SELECT facility_name FROM hospitals WHERE facility_id=$1', [fid])).rows[0];
  const reqRow = await q(`INSERT INTO blood_requests(facility_id,blood_group,quantity,urgency)
                          VALUES($1,$2,$3,$4) RETURNING request_id`,
    [fid, blood_group, qty, ['Normal', 'Urgent', 'Critical'].includes(urgency) ? urgency : 'Normal']);
  const rid = reqRow.rows[0].request_id;

  // matching: compatible, available, eligible (56 days since last donation), active
  const donors = await q(`SELECT d.donor_id FROM donors d JOIN users u ON u.user_id=d.user_id
                          WHERE d.blood_group = ANY($1) AND d.availability AND u.is_active
                            AND (d.last_donation_date IS NULL OR d.last_donation_date <= CURRENT_DATE - 56)
                          LIMIT 50`, [COMPAT[blood_group]]);
  for (const d of donors.rows) {
    await q('INSERT INTO request_matches(request_id,donor_id) VALUES($1,$2)', [rid, d.donor_id]);
    await q('INSERT INTO notifications(donor_id,request_id,message) VALUES($1,$2,$3)',
      [d.donor_id, rid, `${hosp.facility_name} needs ${qty} unit(s) of ${blood_group} blood. Please check your requests.`]);
  }
  await q('UPDATE blood_requests SET status=$1 WHERE request_id=$2', [donors.rowCount ? 'Notified' : 'Pending', rid]);
  res.json({ request_id: rid, matched: donors.rowCount });
}));

app.get('/api/requests', auth(['hospital']), wrap(async (req, res) => {
  const fid = await facilityIdOf(req.user.id);
  const r = await q(`SELECT r.*,
      (SELECT COUNT(*)::int FROM request_matches m WHERE m.request_id=r.request_id) AS matches,
      (SELECT COUNT(*)::int FROM donations d WHERE d.request_id=r.request_id) AS donated
      FROM blood_requests r WHERE r.facility_id=$1 ORDER BY r.request_id DESC`, [fid]);
  res.json(r.rows);
}));

app.get('/api/requests/:id', auth(['hospital']), wrap(async (req, res) => {
  const fid = await facilityIdOf(req.user.id);
  const rq = await q('SELECT * FROM blood_requests WHERE request_id=$1 AND facility_id=$2', [req.params.id, fid]);
  if (!rq.rowCount) return res.status(404).json({ error: 'Request not found' });
  const m = await q(`SELECT m.status, d.donor_id, u.name, u.phone, d.blood_group, d.location
                     FROM request_matches m JOIN donors d ON d.donor_id=m.donor_id
                     JOIN users u ON u.user_id=d.user_id WHERE m.request_id=$1 ORDER BY m.match_id`, [req.params.id]);
  // phone is only shown after the donor accepts
  const matches = m.rows.map(x => ({ ...x, phone: ['Accepted', 'Donated'].includes(x.status) ? x.phone : null }));
  res.json({ request: rq.rows[0], matches });
}));

app.post('/api/requests/:id/cancel', auth(['hospital']), wrap(async (req, res) => {
  const fid = await facilityIdOf(req.user.id);
  await q(`UPDATE blood_requests SET status='Cancelled' WHERE request_id=$1 AND facility_id=$2
           AND status NOT IN ('Fulfilled')`, [req.params.id, fid]);
  res.json({ ok: true });
}));

app.post('/api/requests/:id/donations', auth(['hospital']), wrap(async (req, res) => {
  const fid = await facilityIdOf(req.user.id);
  const donorId = parseInt(req.body.donor_id);
  const rq = await q('SELECT * FROM blood_requests WHERE request_id=$1 AND facility_id=$2', [req.params.id, fid]);
  if (!rq.rowCount) return res.status(404).json({ error: 'Request not found' });
  const m = await q(`UPDATE request_matches SET status='Donated' WHERE request_id=$1 AND donor_id=$2
                     AND status='Accepted' RETURNING 1`, [req.params.id, donorId]);
  if (!m.rowCount) return res.status(400).json({ error: 'This donor has not accepted the request' });
  await q('INSERT INTO donations(donor_id,facility_id,request_id) VALUES($1,$2,$3)', [donorId, fid, req.params.id]);
  await q('UPDATE donors SET last_donation_date=CURRENT_DATE WHERE donor_id=$1', [donorId]);
  const c = (await q('SELECT COUNT(*)::int AS c FROM donations WHERE request_id=$1', [req.params.id])).rows[0].c;
  if (c >= rq.rows[0].quantity) await q(`UPDATE blood_requests SET status='Fulfilled' WHERE request_id=$1`, [req.params.id]);
  res.json({ ok: true });
}));

app.get('/api/stock', auth(['hospital']), wrap(async (req, res) => {
  const fid = await facilityIdOf(req.user.id);
  const r = await q('SELECT blood_group, units_available, expiry_date FROM blood_stock WHERE facility_id=$1 ORDER BY blood_group', [fid]);
  res.json(r.rows);
}));

app.post('/api/stock', auth(['hospital']), wrap(async (req, res) => {
  const { blood_group, units_available, expiry_date } = req.body;
  const units = parseInt(units_available);
  if (!GROUPS.includes(blood_group) || !(units >= 0)) return res.status(400).json({ error: 'Choose a blood group and a valid number of units' });
  const fid = await facilityIdOf(req.user.id);
  await q(`INSERT INTO blood_stock(facility_id,blood_group,units_available,expiry_date) VALUES($1,$2,$3,$4)
           ON CONFLICT (facility_id,blood_group) DO UPDATE
           SET units_available=EXCLUDED.units_available, expiry_date=EXCLUDED.expiry_date`,
    [fid, blood_group, units, expiry_date || null]);
  res.json({ ok: true });
}));

app.get('/api/donors', auth(['hospital']), wrap(async (req, res) => {
  const r = await q(`SELECT u.name, d.blood_group, d.location, d.availability
                     FROM donors d JOIN users u ON u.user_id=d.user_id
                     WHERE u.is_active AND ($1::text IS NULL OR d.blood_group=$1)
                       AND ($2::text IS NULL OR d.location ILIKE '%' || $2 || '%')
                     ORDER BY u.name LIMIT 100`, [req.query.blood_group || null, req.query.location || null]);
  res.json(r.rows);
}));

// ---------- administrator ----------
app.get('/api/admin/stats', auth(['admin']), wrap(async (req, res) => {
  const r = await q(`SELECT (SELECT COUNT(*) FROM donors)::int AS donors,
                            (SELECT COUNT(*) FROM hospitals)::int AS hospitals,
                            (SELECT COUNT(*) FROM blood_requests)::int AS requests,
                            (SELECT COUNT(*) FROM donations)::int AS donations`);
  res.json(r.rows[0]);
}));

app.get('/api/admin/users', auth(['admin']), wrap(async (req, res) => {
  const r = await q('SELECT user_id, name, email, role, is_active FROM users ORDER BY user_id');
  res.json(r.rows);
}));

app.post('/api/admin/users/:id/toggle', auth(['admin']), wrap(async (req, res) => {
  await q(`UPDATE users SET is_active = NOT is_active WHERE user_id=$1 AND role <> 'admin'`, [req.params.id]);
  res.json({ ok: true });
}));

// ---------- start ----------
async function seedAdmin() {
  const r = await q("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  if (r.rowCount) return;
  const email = process.env.ADMIN_EMAIL || 'admin@lifelink.com';
  const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin@123', 10);
  const u = await q("INSERT INTO users(name,email,password_hash,role) VALUES('Administrator',$1,$2,'admin') RETURNING user_id", [email, hash]);
  await q('INSERT INTO administrators(user_id) VALUES($1)', [u.rows[0].user_id]);
  console.log('Admin account created:', email);
}

seedAdmin()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('LifeLink running on http://localhost:' + (process.env.PORT || 3000))))
  .catch(e => { console.error('Could not start. Check DATABASE_URL in .env:', e.message); process.exit(1); });