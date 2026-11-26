const guestView = document.querySelector('#guestView');
const accountView = document.querySelector('#accountView');
const socialView = document.querySelector('#socialView');
const registerForm = document.querySelector('#registerForm');
const loginForm = document.querySelector('#loginForm');
const passwordForm = document.querySelector('#passwordForm');
const deleteForm = document.querySelector('#deleteForm');
const postForm = document.querySelector('#postForm');
const postBody = document.querySelector('#postBody');
const postCounter = document.querySelector('#postCounter');
const feed = document.querySelector('#feed');
const message = document.querySelector('#message');
let csrfToken = '';
let currentUser = null;

function showMessage(text, type = 'error') {
  message.textContent = text;
  message.className = `message ${type}`;
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (csrfToken && !['GET', 'HEAD'].includes(options.method || 'GET')) {
    headers['X-CSRF-Token'] = csrfToken;
  }
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  let data = {};
  try { data = await response.json(); } catch {}
  if (!response.ok) throw new Error(data.error || 'エラーが発生しました。');
  if (data.csrfToken) csrfToken = data.csrfToken;
  return data;
}

function weightedLength(value) {
  const segments = new Intl.Segmenter('ja', { granularity: 'grapheme' }).segment(value);
  let length = 0;
  for (const { segment } of segments) {
    const codePoint = segment.codePointAt(0);
    length += codePoint <= 0x7f || (codePoint >= 0xff61 && codePoint <= 0xff9f) ? 1 : 2;
  }
  return length;
}

function setGuestView() {
  currentUser = null;
  guestView.hidden = false;
  accountView.hidden = true;
  socialView.hidden = true;
}

function setAccountView(user) {
  currentUser = user;
  guestView.hidden = true;
  accountView.hidden = false;
  socialView.hidden = false;
  document.querySelector('#accountName').textContent = user.accountName;
  document.querySelector('#accountId').textContent = `@${user.accountId}`;
  document.querySelector('#avatar').textContent = user.accountName.slice(0, 1).toUpperCase();
  loadFeed();
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

function appendText(parent, tag, text, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function renderFeed(posts) {
  feed.replaceChildren();
  if (!posts.length) {
    appendText(feed, 'p', 'まだ投稿はありません。最初の投稿をしてみましょう。', 'empty-feed');
    return;
  }

  for (const post of posts) {
    const article = document.createElement('article');
    article.className = 'card post-card';
    article.dataset.postId = post.id;
    const header = document.createElement('header');
    header.className = 'post-header';
    appendText(header, 'strong', post.accountName, 'post-author');
    appendText(header, 'span', `@${post.accountId}`, 'post-account-id');
    appendText(header, 'time', new Date(`${post.createdAt.replace(' ', 'T')}Z`).toLocaleString(), 'post-time');
    article.append(header);
    appendText(article, 'p', post.body, 'post-body');

    const replies = document.createElement('div');
    replies.className = 'replies';
    for (const reply of post.replies) {
      const replyElement = document.createElement('div');
      replyElement.className = 'reply';
      const replyHeader = document.createElement('div');
      replyHeader.className = 'reply-header';
      appendText(replyHeader, 'strong', reply.accountName, 'reply-author');
      appendText(replyHeader, 'span', `@${reply.accountId}`, 'post-account-id');
      replyElement.append(replyHeader);
      appendText(replyElement, 'p', reply.body, 'reply-body');
      replies.append(replyElement);
    }
    article.append(replies);

    const replyForm = document.createElement('form');
    replyForm.className = 'reply-form';
    const replyInput = document.createElement('input');
    replyInput.name = 'body';
    replyInput.maxLength = 64;
    replyInput.placeholder = '返信を書く（全角2・半角1換算で64文字まで）';
    replyInput.required = true;
    replyInput.setAttribute('aria-label', `${post.accountName}さんの投稿への返信`);
    const replyFooter = document.createElement('div');
    replyFooter.className = 'reply-footer';
    const replyCounter = document.createElement('span');
    replyCounter.className = 'counter';
    replyCounter.textContent = '0 / 64';
    const replyButton = document.createElement('button');
    replyButton.type = 'submit';
    replyButton.className = 'secondary-button';
    replyButton.textContent = '返信';
    replyInput.addEventListener('input', () => {
      const count = weightedLength(replyInput.value);
      replyCounter.textContent = `${count} / 64`;
      replyCounter.classList.toggle('over-limit', count > 64);
    });
    replyForm.addEventListener('submit', async event => {
      event.preventDefault();
      const body = replyInput.value;
      if (weightedLength(body) > 64) return showMessage('返信は全角2・半角1文字換算で64文字以内にしてください。');
      try {
        await api(`/api/posts/${post.id}/replies`, { method: 'POST', body: JSON.stringify({ body }) });
        replyForm.reset();
        showMessage('返信しました。', 'success');
        await loadFeed();
      } catch (error) { showMessage(error.message); }
    });
    replyFooter.append(replyCounter, replyButton);
    replyForm.append(replyInput, replyFooter);
    article.append(replyForm);
    feed.append(article);
  }
}

async function loadFeed() {
  try {
    const { posts } = await api('/api/posts');
    renderFeed(posts);
  } catch (error) {
    showMessage(error.message);
  }
}

document.querySelectorAll('input[name="accountId"]').forEach(input => {
  input.addEventListener('input', () => {
    const start = input.selectionStart;
    const end = input.selectionEnd;
    input.value = input.value.toLowerCase().replace(/-/g, '');
    input.setSelectionRange(start, end);
  });
});

document.querySelector('#registerTab').addEventListener('click', () => switchGuestTab('register'));
document.querySelector('#loginTab').addEventListener('click', () => switchGuestTab('login'));

registerForm.addEventListener('submit', async event => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(registerForm));
  values.accountId = values.accountId.toLowerCase();
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
  values.accountId = values.accountId.toLowerCase();
  try {
    const data = await api('/api/account/login', { method: 'POST', body: JSON.stringify(values) });
    loginForm.reset();
    showMessage('ログインしました。', 'success');
    setAccountView(data.user);
  } catch (error) { showMessage(error.message); }
});

postBody.addEventListener('input', () => {
  const count = weightedLength(postBody.value);
  postCounter.textContent = `${count} / 256`;
  postCounter.classList.toggle('over-limit', count > 256);
});

postForm.addEventListener('submit', async event => {
  event.preventDefault();
  const body = postBody.value;
  if (weightedLength(body) > 256) return showMessage('投稿は全角2・半角1文字換算で256文字以内にしてください。');
  try {
    await api('/api/posts', { method: 'POST', body: JSON.stringify({ body }) });
    postForm.reset();
    postBody.dispatchEvent(new Event('input'));
    showMessage('投稿しました。', 'success');
    await loadFeed();
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
  if (!window.confirm('本当にアカウントを完全に削除しますか？投稿と返信も削除され、この操作は取り消せません。')) return;
  const values = Object.fromEntries(new FormData(deleteForm));
  values.accountId = currentUser?.accountId || '';
  try {
    await api('/api/account', { method: 'DELETE', body: JSON.stringify(values) });
    deleteForm.reset();
    csrfToken = '';
    showMessage('アカウントと投稿・返信を完全削除しました。', 'success');
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
