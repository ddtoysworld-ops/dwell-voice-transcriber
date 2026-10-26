const signedOut = document.querySelector('#signed-out');
const signedIn = document.querySelector('#signed-in');
const identity = document.querySelector('#identity');
const message = document.querySelector('#message');
const dot = document.querySelector('#status-dot');

function send(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error?.message || '操作失败'));
      resolve(response.data);
    });
  });
}

function render(status) {
  signedOut.hidden = status.signedIn;
  signedIn.hidden = !status.signedIn;
  dot.dataset.online = String(status.signedIn);
  identity.textContent = status.user?.email || '已登录';
}

async function refresh() {
  try {
    render(await send({ type: 'VOICE_AUTH_STATUS' }));
  } catch (error) {
    message.textContent = error.message;
  }
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '正在登录…';
  const submit = event.currentTarget.querySelector('button');
  submit.disabled = true;
  try {
    await send({
      type: 'VOICE_AUTH_LOGIN',
      email: document.querySelector('#email').value,
      password: document.querySelector('#password').value
    });
    document.querySelector('#password').value = '';
    message.textContent = '';
    await refresh();
  } catch (error) {
    message.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

document.querySelector('#logout').addEventListener('click', async () => {
  await send({ type: 'VOICE_AUTH_LOGOUT' });
  message.textContent = '';
  await refresh();
});

refresh();

