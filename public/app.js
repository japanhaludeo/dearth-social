const guestView = document.querySelector('#guestView');
const accountView = document.querySelector('#accountView');
const registerForm = document.querySelector('#registerForm');
const loginForm = document.querySelector('#loginForm');
const passwordForm = document.querySelector('#passwordForm');
const deleteForm = document.querySelector('#deleteForm');
const message = document.querySelector('#message');
let csrfToken = '';

function showMessage(text, type = 'error') {
  message.textContent = text;
  message.className = `message ${type}`;
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (csrfToken && !['GET', 'HEAD'].includes(options.method || 'GET')) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, { ...options, headers });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || 'エラーが発生しました。');
  if (data.csrfToken) csrfToken = data.csrfToken;
  return data;
}

function setGuestView() {
  guestView.hidden = false;
  accountView.hidden = true;
}

function setAccountView(user) {
  guestView.hidden = true;
  accountView.hidden = false;
  document.querySelector('#accountName').textContent = user.accountName;
  document.querySelector('#accountId').textContent = `@${user.accountId}`;
  document.querySelector('#avatar').textContent = user.accountName.slice(0, 1).toUpperCase();
}

async function refreshAccount() {
  try {
    const { user } = await api('/api/account');
    if (user) setAccountView(user);
    else setGuestView();
  } catch (error) {
    showMessage(error.message);
  }
}

function switchGuestTab(tab) {
  const registering = tab === 'register';
  document.querySelector('#registerTab').classList.toggle('active', registering);
  document.querySelector('#loginTab').classList.toggle('active', !registering);
  registerForm.hidden = !registering;
  loginForm.hidden = registering;
  showMessage('');
}

document.querySelector('#registerTab').addEventListener('click', () => switchGuestTab('register'));
document.querySelector('#loginTab').addEventListener('click', () => switchGuestTab('login'));

registerForm.addEventListener('submit', async event => {
  event.preventEvent = true;
  event.preventDefault();
  const values = Object.fromEntries(new FormData(registerForm));
  try {
    const data = await api('/api/account/register', { method: 'POST', body: JSON.stringify(values) });
    registerForm.reset();
    showMessage('アカウントを作成しました。', 'success');
    setAccountView(data.user);
  } catch (error) { showMessage(error.message); }
});

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(loginForm));
  try {
    const data = await api('/api/account/login', { method: 'POST', body: JSON.stringify(values) });
    loginForm.reset();
    showMessage('ログインしました。', 'success');
    setAccountView(data.user);
  } catch (error) { showMessage(error.message); }
});

document.querySelector('#logoutButton').addEventListener('click', async () => {
  try {
    await api('/api/account/logout', { method: 'POST', body: '{}' });
    csrfToken = '';
    showMessage('ログアウトしました。', 'success');
    setGuestView();
  } catch (error) { showMessage(error.message); }
});

passwordForm.addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(passwordForm));
  try {
    await api('/api/account/password', { method: 'PATCH', body: JSON.stringify(values) });
    passwordForm.reset();
    csrfToken = '';
    showMessage('パスワードを変更しました。もう一度ログインしてください。', 'success');
    setGuestView();
  } catch (error) { showMessage(error.message); }
});

deleteForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!window.confirm('本当にアカウントを完全に削除しますか？この操作は取り消せません。')) return;
  const values = Object.fromEntries(new FormData(deleteForm));
  try {
    await api('/api/account', { method: 'DELETE', body: JSON.stringify(values) });
    deleteForm.reset();
    csrfToken = '';
    showMessage('アカウントを完全削除しました。', 'success');
    setGuestView();
  } catch (error) { showMessage(error.message); }
});

(async () => {
  try {
    const data = await api('/api/csrf');
    csrfToken = data.csrfToken;
  } catch (error) { showMessage(error.message); }
  await refreshAccount();
})();
