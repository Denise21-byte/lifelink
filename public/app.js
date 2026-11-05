const $ = s => document.querySelector(s);
const GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const opts = GROUPS.map(g => `<option>${g}</option>`).join('');
let token = localStorage.token, role = localStorage.role, uname = localStorage.name;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const render = html => { $('#app').innerHTML = html; };

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'bad' : ''; t.style.display = 'block';
  setTimeout(() => t.style.display = 'none', 3000);
}
window.addEventListener('unhandledrejection', e => toast(e.reason.message, true));

async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && token) logout();
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
}

function nav() {
  $('#nav').innerHTML = token ? `<span>${esc(uname)} (${esc(role)})</span><button class="link" onclick="logout()">Logout</button>` : '';
}
function logout() { localStorage.clear(); token = role = uname = null; nav(); showLogin(); }
function go() { nav(); role === 'donor' ? donorHome() : role === 'hospital' ? hospitalHome() : adminHome(); }

// ---------- login / register ----------
function showLogin() {
  render(`<div class="card narrow"><h2>Login</h2>
    <label>Email</label><input id="email" type="email">
    <label>Password</label><input id="password" type="password">
    <button onclick="login()">Login</button>
    <p>New here? <a href="#" onclick="showRegister();return false">Create an account</a></p></div>`);
}
async function login() {
  const d = await api('/api/login', 'POST', { email: $('#email').value, password: $('#password').value });
  token = d.token; role = d.role; uname = d.name;
  localStorage.token = token; localStorage.role = role; localStorage.name = uname;
  go();
}

function showRegister() {
  render(`<div class="card narrow"><h2>Create account</h2>
    <label>I am a</label><select id="role" onchange="toggleRole()"><option value="donor">Blood donor</option><option value="hospital">Hospital / Blood bank</option></select>
    <label>Full name</label><input id="name">
    <label>Email</label><input id="email" type="email">
    <label>Phone</label><input id="phone">
    <label>Password (min 6 characters)</label><input id="password" type="password">
    <div id="donorF"><label>Blood group</label><select id="bg">${opts}</select>
      <label>Date of birth</label><input id="dob" type="date">
      <label>Location (city)</label><input id="loc"></div>
    <div id="hospF" style="display:none"><label>Facility name</label><input id="fn">
      <label>License number</label><input id="ln">
      <label>Address</label><input id="ad"></div>
    <button onclick="register()">Register</button>
    <p><a href="#" onclick="showLogin();return false">Back to login</a></p></div>`);
}
function toggleRole() {
  const d = $('#role').value === 'donor';
  $('#donorF').style.display = d ? 'block' : 'none';
  $('#hospF').style.display = d ? 'none' : 'block';
}
async function register() {
  await api('/api/register', 'POST', {
    role: $('#role').value, name: $('#name').value, email: $('#email').value, phone: $('#phone').value,
    password: $('#password').value, blood_group: $('#bg').value, date_of_birth: $('#dob').value || null,
    location: $('#loc').value, facility_name: $('#fn').value, license_no: $('#ln').value, address: $('#ad').value,
  });
  toast('Account created. Please login.');
  showLogin();
}

// ---------- donor ----------
async function donorHome() {
  const [p, reqs, dons, notes] = await Promise.all([
    api('/api/donor/profile'), api('/api/donor/requests'), api('/api/donor/donations'), api('/api/donor/notifications')]);
  render(`
    <div class="card">
      <div class="${p.eligible ? 'ok' : 'wait'}">${p.eligible ? 'You can donate blood today.' :
        (p.availability ? 'Next donation possible from ' + esc(p.next_date) : 'You are marked as unavailable.')}</div>
      <p>Blood group: <b>${esc(p.blood_group)}</b> &nbsp; Last donation: <b>${esc(p.last_donation_date || 'none yet')}</b></p>
    </div>
    <div class="card"><h2>Blood requests for you</h2>
      ${reqs.length ? reqs.map(r => `<div class="item"><div>
        <b>${esc(r.facility_name)}</b> needs <b>${esc(r.quantity)} unit(s) of ${esc(r.blood_group)}</b>
        <span class="badge ${esc(r.urgency)}">${esc(r.urgency)}</span><br><small class="muted">${esc(r.address || '')}</small></div>
        <div>${r.match_status === 'Notified'
          ? `<button class="small" onclick="respond(${r.match_id},'accepted')">Accept</button>
             <button class="small grey" onclick="respond(${r.match_id},'declined')">Decline</button>`
          : `<span class="badge ${esc(r.match_status)}">${esc(r.match_status)}</span>`}</div></div>`).join('')
        : '<p class="muted">No requests right now. You will be notified when someone needs your blood group.</p>'}
    </div>
    <div class="card"><h2>My profile</h2>
      <div class="row"><div><label>Phone</label><input id="ph" value="${esc(p.phone || '')}"></div>
      <div><label>Location</label><input id="lc" value="${esc(p.location || '')}"></div></div>
      <label><input type="checkbox" id="av" ${p.availability ? 'checked' : ''}> I am available to donate</label>
      <button onclick="saveProfile()">Save</button></div>
    <div class="card"><h2>Donation history</h2>
      ${dons.length ? `<table><tr><th>Date</th><th>Place</th><th>Volume</th></tr>${dons.map(d =>
        `<tr><td>${esc(d.donation_date)}</td><td>${esc(d.facility_name)}</td><td>${esc(d.volume)} ml</td></tr>`).join('')}</table>`
        : '<p class="muted">No donations yet.</p>'}</div>
    <div class="card"><h2>Notifications</h2>
      ${notes.length ? notes.map(n => `<div class="item"><span>${esc(n.message)}</span><small class="muted">${esc(String(n.sent_date).slice(0, 10))}</small></div>`).join('')
        : '<p class="muted">No notifications.</p>'}</div>`);
}
async function respond(id, response) {
  await api(`/api/donor/matches/${id}/respond`, 'POST', { response });
  toast(response === 'accepted' ? 'Thank you! The hospital will contact you.' : 'Request declined.');
  donorHome();
}
async function saveProfile() {
  await api('/api/donor/profile', 'PUT', { phone: $('#ph').value, location: $('#lc').value, availability: $('#av').checked });
  toast('Profile saved'); donorHome();
}

// ---------- hospital / blood bank ----------
async function hospitalHome() {
  const [reqs, stock] = await Promise.all([api('/api/requests'), api('/api/stock')]);
  const open = reqs.filter(r => ['Pending', 'Notified', 'Matched'].includes(r.status)).length;
  const units = stock.reduce((s, x) => s + x.units_available, 0);
  render(`
    <div class="stats">
      <div class="stat"><b>${open}</b>Open requests</div>
      <div class="stat"><b>${reqs.filter(r => r.status === 'Fulfilled').length}</b>Fulfilled</div>
      <div class="stat"><b>${units}</b>Units in stock</div></div>
    <div class="card"><h2>New blood request</h2>
      <div class="row"><div><label>Blood group needed</label><select id="rg">${opts}</select></div>
      <div><label>Units</label><input id="rq" type="number" min="1" value="1"></div>
      <div><label>Urgency</label><select id="ru"><option>Normal</option><option>Urgent</option><option>Critical</option></select></div></div>
      <button onclick="createRequest()">Send request and find donors</button></div>
    <div class="card"><h2>My requests</h2>
      ${reqs.length ? `<table><tr><th>#</th><th>Blood</th><th>Units</th><th>Urgency</th><th>Status</th><th>Donors</th><th></th></tr>
        ${reqs.map(r => `<tr><td>${r.request_id}</td><td>${esc(r.blood_group)}</td><td>${r.donated}/${r.quantity}</td>
        <td><span class="badge ${esc(r.urgency)}">${esc(r.urgency)}</span></td>
        <td><span class="badge ${esc(r.status)}">${esc(r.status)}</span></td><td>${r.matches}</td>
        <td><button class="small" onclick="viewRequest(${r.request_id})">View</button>
        ${['Fulfilled', 'Cancelled'].includes(r.status) ? '' : `<button class="small grey" onclick="cancelRequest(${r.request_id})">Cancel</button>`}</td></tr>`).join('')}</table>`
        : '<p class="muted">No requests yet.</p>'}</div>
    <div class="card"><h2>Blood stock</h2>
      <div class="row"><div><label>Blood group</label><select id="sg">${opts}</select></div>
      <div><label>Units available</label><input id="su" type="number" min="0" value="0"></div>
      <div><label>Expiry date</label><input id="se" type="date"></div></div>
      <button onclick="saveStock()">Save stock</button>
      ${stock.length ? `<table style="margin-top:14px"><tr><th>Blood group</th><th>Units</th><th>Expiry</th></tr>${stock.map(s =>
        `<tr><td>${esc(s.blood_group)}</td><td>${s.units_available}</td><td>${esc(s.expiry_date || '-')}</td></tr>`).join('')}</table>` : ''}</div>
    <div class="card"><h2>Search donors</h2>
      <div class="row"><div><label>Blood group</label><select id="fg"><option value="">Any</option>${opts}</select></div>
      <div><label>Location</label><input id="fl"></div></div>
      <button onclick="searchDonors()">Search</button><div id="results"></div></div>`);
}
async function createRequest() {
  const d = await api('/api/requests', 'POST', { blood_group: $('#rg').value, quantity: $('#rq').value, urgency: $('#ru').value });
  toast(d.matched ? `Request sent. ${d.matched} compatible donor(s) notified.` : 'Request saved. No compatible donor found yet.');
  hospitalHome();
}
async function cancelRequest(id) {
  if (!confirm('Cancel this request?')) return;
  await api(`/api/requests/${id}/cancel`, 'POST'); hospitalHome();
}
async function saveStock() {
  await api('/api/stock', 'POST', { blood_group: $('#sg').value, units_available: $('#su').value, expiry_date: $('#se').value });
  toast('Stock saved'); hospitalHome();
}
async function searchDonors() {
  const list = await api(`/api/donors?blood_group=${encodeURIComponent($('#fg').value)}&location=${encodeURIComponent($('#fl').value)}`);
  $('#results').innerHTML = list.length ? `<table style="margin-top:14px"><tr><th>Name</th><th>Blood</th><th>Location</th><th>Available</th></tr>${list.map(d =>
    `<tr><td>${esc(d.name)}</td><td>${esc(d.blood_group)}</td><td>${esc(d.location || '-')}</td><td>${d.availability ? 'Yes' : 'No'}</td></tr>`).join('')}</table>`
    : '<p class="muted">No donors found.</p>';
}
async function viewRequest(id) {
  const { request: r, matches } = await api('/api/requests/' + id);
  render(`<div class="card"><button class="small grey" onclick="hospitalHome()">&larr; Back</button>
    <h2 style="margin-top:14px">Request #${r.request_id}: ${esc(r.quantity)} unit(s) of ${esc(r.blood_group)}</h2>
    <p><span class="badge ${esc(r.urgency)}">${esc(r.urgency)}</span> <span class="badge ${esc(r.status)}">${esc(r.status)}</span></p>
    <h2>Matched donors</h2>
    ${matches.length ? `<table><tr><th>Name</th><th>Blood</th><th>Location</th><th>Phone</th><th>Status</th><th></th></tr>${matches.map(m =>
      `<tr><td>${esc(m.name)}</td><td>${esc(m.blood_group)}</td><td>${esc(m.location || '-')}</td><td>${esc(m.phone || 'Hidden until accepted')}</td>
      <td><span class="badge ${esc(m.status)}">${esc(m.status)}</span></td>
      <td>${m.status === 'Accepted' ? `<button class="small" onclick="recordDonation(${r.request_id},${m.donor_id})">Record donation</button>` : ''}</td></tr>`).join('')}</table>`
      : '<p class="muted">No donors matched yet.</p>'}</div>`);
}
async function recordDonation(rid, did) {
  await api(`/api/requests/${rid}/donations`, 'POST', { donor_id: did });
  toast('Donation recorded'); viewRequest(rid);
}

// ---------- administrator ----------
async function adminHome() {
  const [s, users] = await Promise.all([api('/api/admin/stats'), api('/api/admin/users')]);
  render(`
    <div class="stats">
      <div class="stat"><b>${s.donors}</b>Donors</div><div class="stat"><b>${s.hospitals}</b>Hospitals</div>
      <div class="stat"><b>${s.requests}</b>Requests</div><div class="stat"><b>${s.donations}</b>Donations</div></div>
    <div class="card"><h2>Manage users</h2>
      <table><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr>${users.map(u =>
        `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td>
        <td>${u.is_active ? 'Active' : 'Deactivated'}</td>
        <td>${u.role === 'admin' ? '' : `<button class="small ${u.is_active ? 'grey' : ''}" onclick="toggleUser(${u.user_id})">${u.is_active ? 'Deactivate' : 'Activate'}</button>`}</td></tr>`).join('')}</table></div>`);
}
async function toggleUser(id) { await api(`/api/admin/users/${id}/toggle`, 'POST'); adminHome(); }

// ---------- start ----------
if (token && role) go();
else if (location.hash === '#register-donor') showRegister();
else if (location.hash === '#register-hospital') { showRegister(); $('#role').value = 'hospital'; toggleRole(); }
else showLogin();