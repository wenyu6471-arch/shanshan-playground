const screens = [...document.querySelectorAll('[data-screen]')];
const toast = document.querySelector('.toast');
const parentDialog = document.querySelector('#parent-dialog');
let toastTimer;
let holdTimer;
let videoDemoTimer;
let videoControlsTimer;
let videoDemoSeconds = 10;
let videoPlaying = true;
let activeSeries = 'bluey';
let managedMode = 'music';
const importedFileKeys = new Set();
const sessionObjectUrls = [];
const DB_NAME = 'shanshan-local-library';
const DB_VERSION = 1;
const PARENT_CREDENTIAL_KEY = 'parent-credential-id';
let databasePromise;
let parentCredentialId = '';
let parentAuthBusy = false;

function openDatabase() {
  if (!('indexedDB' in window)) return Promise.reject(new Error('IndexedDB unavailable'));
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('media')) database.createObjectStore('media', { keyPath: 'id' });
      if (!database.objectStoreNames.contains('settings')) database.createObjectStore('settings', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function databaseRequest(storeName, mode, operation) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    const request = operation(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const getAllRecords = (storeName) => databaseRequest(storeName, 'readonly', (store) => store.getAll());
const putRecord = (storeName, value) => databaseRequest(storeName, 'readwrite', (store) => store.put(value));
const deleteRecord = (storeName, key) => databaseRequest(storeName, 'readwrite', (store) => store.delete(key));

async function saveSetting(key, value) {
  try {
    await putRecord('settings', { key, value });
  } catch (error) {
    console.warn('设置保存失败', error);
  }
}

async function readSetting(key) {
  try {
    const record = await databaseRequest('settings', 'readonly', (store) => store.get(key));
    return record?.value;
  } catch (error) {
    console.warn('设置读取失败', error);
    return undefined;
  }
}

function randomBytes(length = 32) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bufferToBase64Url(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

async function supportsParentDeviceVerification() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) return false;
  if (!PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) return true;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function updateParentAuthInterface(supported = true) {
  const enabled = Boolean(parentCredentialId);
  const status = document.querySelector('#parent-auth-status');
  const help = document.querySelector('#parent-auth-help');
  const toggle = document.querySelector('[data-parent-auth-toggle]');
  const title = document.querySelector('#parent-dialog-title');
  const copy = document.querySelector('[data-parent-auth-copy]');
  const note = document.querySelector('[data-parent-auth-note]');
  const hold = document.querySelector('[data-hold-enter]');
  const verify = document.querySelector('[data-device-verify]');

  if (status) status.textContent = enabled ? '设备验证已开启' : supported ? '长按进入家长中心' : '当前浏览器不支持设备验证';
  if (help) help.textContent = enabled
    ? '进入家长中心时由系统验证；本站不会读取或保存生物信息。'
    : supported
      ? '可以启用这台设备的 Face ID、Touch ID 或设备密码。'
      : '请使用最新版 iPadOS Safari，并确认设备已设置锁屏密码。';
  if (toggle) {
    toggle.textContent = enabled ? '关闭设备验证' : '启用设备验证';
    toggle.disabled = !enabled && !supported;
  }
  if (title) title.textContent = enabled ? '验证家长身份' : '这是家长入口';
  if (copy) copy.textContent = enabled ? '使用这台设备完成验证后进入家长中心。' : '请按住下面的按钮，直到圆环走完。';
  if (note) note.textContent = enabled
    ? '验证由 iPad 系统完成，可使用 Face ID、Touch ID 或设备密码。'
    : '首次进入后，可以在基础设置中启用设备验证。';
  if (hold) hold.hidden = enabled;
  if (verify) verify.hidden = !enabled;
}

async function createParentCredential() {
  if (!await supportsParentDeviceVerification()) throw new Error('unsupported');
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(),
      rp: { name: '闪闪小乐园' },
      user: {
        id: randomBytes(),
        name: 'shanshan-parent',
        displayName: '闪闪的家长'
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 }
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required'
      },
      timeout: 60000,
      attestation: 'none'
    }
  });
  if (!credential) throw new Error('cancelled');
  parentCredentialId = bufferToBase64Url(credential.rawId);
  await saveSetting(PARENT_CREDENTIAL_KEY, parentCredentialId);
  updateParentAuthInterface(true);
}

async function verifyParentCredential() {
  if (!parentCredentialId) return false;
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(),
      allowCredentials: [{
        type: 'public-key',
        id: base64UrlToBytes(parentCredentialId),
        transports: ['internal']
      }],
      userVerification: 'required',
      timeout: 60000
    }
  });
  return Boolean(credential);
}

function parentAuthMessage(error) {
  if (error?.name === 'NotAllowedError' || error?.message === 'cancelled') return '未完成设备验证，请再试一次';
  if (error?.message === 'unsupported') return '这台设备暂时不支持设备验证';
  return '设备验证没有完成，请确认设备密码后重试';
}

const seriesCatalog = {
  bluey: {
    title: 'Bluey',
    cover: 'assets/covers/bluey.jpg',
    episodes: ['Magic Xylophone', 'Hospital', 'Keepy Uppy', 'Shadowlands', 'The Weekend', 'BBQ']
  },
  peppa: {
    title: 'Peppa Pig',
    cover: 'assets/covers/peppa.jpg',
    episodes: ['Muddy Puddles', 'Hide and Seek', 'Polly Parrot', 'Best Friend', 'The Playground', 'The Picnic']
  },
  numberblocks: {
    title: 'Numberblocks',
    cover: 'assets/covers/numberblocks.jpg',
    episodes: ['One', 'Two', 'Three', 'Four', 'Five', 'Seven']
  },
  'hey-duggee': {
    title: 'Hey Duggee',
    cover: 'assets/covers/hey-duggee.jpg',
    episodes: ['The Drawing Badge', 'The Cake Badge', 'The Hair Badge', 'The Sandcastle Badge', 'The Rescue Badge', 'The Music Badge']
  },
  'puffin-rock': {
    title: 'Puffin Rock',
    cover: 'assets/covers/puffin-rock.jpg',
    episodes: ['Rise and Shine', 'Homesick Hoglet', 'The Great Gull', 'The Meteor Shower', 'The Salmon Leap', 'Back to the Pond']
  },
  'daniel-tiger': {
    title: 'Daniel Tiger',
    cover: 'assets/covers/daniel-tiger.jpg',
    episodes: ["Daniel's Birthday", "Daniel's Picnic", 'Fruit Picking Day', 'Big Enough to Help', 'King for the Day', 'Tiger Family Fun']
  }
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

function renderSeries(seriesId) {
  const series = seriesCatalog[seriesId];
  if (!series) return;
  activeSeries = seriesId;
  document.querySelector('#series-title').textContent = series.title;
  document.querySelector('#series-count').textContent = `${series.episodes.length} 个章节`;
  document.querySelector('#episode-grid').replaceChildren(...series.episodes.map((episode, originalIndex) => {
    const item = typeof episode === 'string' ? { title: episode } : episode;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'episode-card';
    button.dataset.playVideo = item.title;
    button.dataset.episodeIndex = String(originalIndex + 1);
    if (item.url) button.dataset.localUrl = item.url;
    const cover = item.cover || series.cover;
    button.innerHTML = `<span class="episode-thumb"><img src="${escapeHtml(cover)}" alt=""><i>${originalIndex + 1}</i></span><strong>${escapeHtml(item.title)}</strong><small>第 ${originalIndex + 1} 集</small>`;
    return button;
  }));
}

function mountHomeShelves() {
  const audioShelf = document.querySelector('[data-screen="audio-library"] .media-shelf');
  const sources = [
    ['music', audioShelf, '[data-audio-kind="music"]'],
    ['story', audioShelf, '[data-audio-kind="story"]'],
    ['video', document.querySelector('[data-screen="video-library"] .media-shelf'), null]
  ];
  sources.forEach(([type, shelf, selector]) => {
    const mount = document.querySelector(`[data-home-mount="${type}"]`);
    if (!mount || !shelf) return;
    const clone = shelf.cloneNode(true);
    if (selector) {
      clone.querySelectorAll('.media-cover').forEach((card) => {
        if (!card.matches(selector)) card.remove();
      });
    }
    clone.classList.add('home-media-shelf');
    mount.replaceChildren(clone);
  });
}

mountHomeShelves();
renderSeries(activeSeries);

function getManagedShelf(mode = managedMode) {
  return document.querySelector(`[data-home-mount="${mode}"] .home-media-shelf`);
}

function renderContentManager(mode = managedMode) {
  managedMode = mode;
  const list = document.querySelector('#content-manager-list');
  const shelf = getManagedShelf(mode);
  if (!list || !shelf) return;
  const cards = [...shelf.querySelectorAll('.media-cover')];
  list.replaceChildren(...cards.map((card, index) => {
    const row = document.createElement('div');
    const id = card.dataset.contentId || `${mode}-${index}`;
    card.dataset.contentId = id;
    row.className = 'content-manager__row';
    row.dataset.manageId = id;
    const image = card.querySelector('img')?.getAttribute('src') || 'assets/illustrations/icon-listen.png';
    const title = card.querySelector('.media-cover__title')?.textContent || '未命名内容';
    const meta = card.querySelector('.media-cover__meta')?.textContent || '';
    row.innerHTML = `<img src="${escapeHtml(image)}" alt=""><div class="content-manager__name"><input type="text" value="${escapeHtml(title)}" data-rename-content="${escapeHtml(id)}" aria-label="内容名称"><small>${escapeHtml(meta)}</small></div><div class="content-manager__order" aria-label="调整顺序"><button type="button" data-move-content="up" aria-label="上移" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-move-content="down" aria-label="下移" ${index === cards.length - 1 ? 'disabled' : ''}>↓</button></div><label class="visibility-toggle"><input type="checkbox" data-toggle-visible="${escapeHtml(id)}" ${card.hidden ? '' : 'checked'}><span>${card.hidden ? '已隐藏' : '儿童端可见'}</span><i></i></label><button class="content-manager__delete" type="button" data-delete-content="${escapeHtml(id)}" aria-label="删除${escapeHtml(title)}">删除</button>`;
    return row;
  }));
}

function cardsWithId(id) {
  return [...document.querySelectorAll('.media-cover')].filter((card) => card.dataset.contentId === id);
}

async function saveContentState(mode) {
  const shelf = getManagedShelf(mode);
  if (!shelf) return;
  const items = [...shelf.querySelectorAll('.media-cover')].map((card) => ({
    id: card.dataset.contentId,
    title: card.querySelector('.media-cover__title')?.textContent || '未命名内容',
    visible: !card.hidden
  }));
  await saveSetting(`content:${mode}`, items);
}

async function restoreContentState(mode) {
  const shelf = getManagedShelf(mode);
  const items = await readSetting(`content:${mode}`);
  if (!shelf) return;
  const deletedIds = await readSetting(`deleted-content:${mode}`);
  if (Array.isArray(deletedIds)) {
    deletedIds.forEach((id) => cardsWithId(id).forEach((card) => card.remove()));
  }
  if (!Array.isArray(items)) return;
  items.forEach((saved) => {
    const card = [...shelf.querySelectorAll('.media-cover')].find((item) => item.dataset.contentId === saved.id);
    if (!card) return;
    const migratedTitle = saved.id === 'local-video-series' && saved.title === '本地动画' ? '闪闪的动画' : saved.title;
    const title = card.querySelector('.media-cover__title');
    if (title) title.textContent = migratedTitle;
    card.hidden = saved.visible === false;
    if (card.dataset.playAudio) card.dataset.playAudio = migratedTitle;
    if (card.dataset.openSeries && seriesCatalog[card.dataset.openSeries]) seriesCatalog[card.dataset.openSeries].title = migratedTitle;
    shelf.append(card);
  });
}

renderContentManager();

function showScreen(name) {
  window.clearInterval(videoDemoTimer);
  window.clearTimeout(videoControlsTimer);
  document.body.classList.toggle('is-parent-screen', name === 'parent');
  if (name !== 'audio-player') document.querySelector('#local-audio-player').pause();
  if (name !== 'video-player') document.querySelector('#local-video-player').pause();
  document.querySelector('.time-warning').hidden = true;
  document.querySelector('[data-screen="video-player"]').classList.remove('is-controls-hidden');
  screens.forEach((screen) => {
    const active = screen.dataset.screen === name;
    screen.hidden = !active;
    screen.classList.toggle('is-active', active);
    screen.classList.remove('is-entering');
    if (active) {
      requestAnimationFrame(() => screen.classList.add('is-entering'));
      const focusTarget = screen.querySelector('h1, h2');
      if (focusTarget) {
        focusTarget.tabIndex = -1;
        focusTarget.focus({ preventScroll: true });
      }
    }
  });
  if (name === 'video-player' && !document.querySelector('[data-screen="video-player"]').classList.contains('is-local')) startVideoDemo();
}

function setVideoPlayState(playing) {
  videoPlaying = playing;
  const toggle = document.querySelector('[data-screen="video-player"] [data-toggle-play]');
  toggle.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  toggle.setAttribute('aria-label', playing ? '暂停' : '继续播放');
}

function hideVideoControls() {
  const screen = document.querySelector('[data-screen="video-player"]');
  if (!videoPlaying || screen.hidden || !document.querySelector('.time-warning').hidden) return;
  screen.classList.add('is-controls-hidden');
}

function showVideoControls({ autoHide = videoPlaying } = {}) {
  const screen = document.querySelector('[data-screen="video-player"]');
  window.clearTimeout(videoControlsTimer);
  screen.classList.remove('is-controls-hidden');
  if (autoHide && !screen.classList.contains('is-local')) {
    videoControlsTimer = window.setTimeout(hideVideoControls, 2400);
  }
}

function startVideoDemo() {
  videoDemoSeconds = 10;
  setVideoPlayState(true);
  const label = document.querySelector('#video-remaining');
  const warning = document.querySelector('.time-warning');
  label.textContent = `演示：${videoDemoSeconds} 秒`;
  showVideoControls();
  videoDemoTimer = window.setInterval(() => {
    if (!videoPlaying) return;
    videoDemoSeconds -= 1;
    label.textContent = `演示：${videoDemoSeconds} 秒`;
    if (videoDemoSeconds === 5) {
      warning.hidden = false;
      showVideoControls({ autoHide: false });
    }
    if (videoDemoSeconds <= 3) {
      warning.hidden = true;
      showVideoControls();
    }
    if (videoDemoSeconds <= 0) {
      window.clearInterval(videoDemoTimer);
      showScreen('rest');
    }
  }, 1000);
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.querySelector('span').textContent = message;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, 2600);
}

document.addEventListener('click', async (event) => {
  const videoSurface = event.target.closest('[data-screen="video-player"]');
  const videoChrome = event.target.closest('.video-overlay-bar, .video-controls, .time-warning, video');
  if (videoSurface && !videoChrome && !videoSurface.classList.contains('is-local')) {
    if (videoSurface.classList.contains('is-controls-hidden')) showVideoControls();
    else if (videoPlaying) hideVideoControls();
  }

  const homeMode = event.target.closest('[data-home-mode]');
  if (homeMode) {
    const selectedMode = homeMode.dataset.homeMode;
    document.querySelectorAll('[data-home-mode]').forEach((item) => {
      const selected = item === homeMode;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    document.querySelectorAll('[data-home-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.homePanel !== selectedMode;
    });
  }

  const emptyKind = event.target.closest('[data-empty-kind]');
  if (emptyKind) {
    document.querySelectorAll('[data-empty-kind]').forEach((item) => {
      const selected = item === emptyKind;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    document.querySelector('#empty-title').textContent = `这里还没有${emptyKind.dataset.emptyKind}`;
  }

  const nav = event.target.closest('[data-go]');
  if (nav) showScreen(nav.dataset.go);

  const audio = event.target.closest('[data-play-audio]');
  if (audio) {
    document.querySelector('#now-audio-title').textContent = audio.dataset.playAudio;
    document.querySelector('.track-name').textContent = audio.dataset.localUrl ? '本地音频 · 已保存在本机' : '来自闪闪的歌单';
    document.querySelector('[data-screen="audio-player"]').dataset.audioTheme = audio.dataset.playerTheme || 'night';
    const localAudio = document.querySelector('#local-audio-player');
    if (audio.dataset.localUrl) {
      localAudio.src = audio.dataset.localUrl;
      localAudio.play().catch(() => showToast('这个音频暂时无法播放，请换一个文件'));
    } else {
      localAudio.pause();
      localAudio.removeAttribute('src');
    }
    showScreen('audio-player');
  }

  const series = event.target.closest('[data-open-series]');
  if (series) {
    renderSeries(series.dataset.openSeries);
    showScreen('series-detail');
  }

  const video = event.target.closest('[data-play-video]');
  if (video) {
    document.querySelector('#now-video-title').textContent = video.dataset.playVideo;
    document.querySelector('#now-video-episode').textContent = `第 ${video.dataset.episodeIndex || 1} 集`;
    const videoScreen = document.querySelector('[data-screen="video-player"]');
    const localVideo = document.querySelector('#local-video-player');
    if (video.dataset.localUrl) {
      videoScreen.classList.add('is-local');
      localVideo.hidden = false;
      localVideo.src = video.dataset.localUrl;
      localVideo.play().catch(() => showToast('这个视频暂时无法播放，请换一个文件'));
    } else {
      videoScreen.classList.remove('is-local');
      localVideo.hidden = true;
      localVideo.pause();
      localVideo.removeAttribute('src');
    }
    showScreen('video-player');
  }

  const toggle = event.target.closest('[data-toggle-play]');
  if (toggle) {
    const icon = toggle.querySelector('use');
    const paused = icon.getAttribute('href') === '#i-play';
    icon.setAttribute('href', paused ? '#i-pause' : '#i-play');
    toggle.setAttribute('aria-label', paused ? '暂停' : '继续播放');
    if (toggle.closest('[data-screen="video-player"]')) {
      setVideoPlayState(paused);
      showVideoControls({ autoHide: paused });
    }
    if (toggle.closest('[data-screen="audio-player"]')) {
      const localAudio = document.querySelector('#local-audio-player');
      if (localAudio.src) paused ? localAudio.play() : localAudio.pause();
    }
  }

  const tab = event.target.closest('[data-parent-tab]');
  if (tab) {
    document.querySelectorAll('[data-parent-tab]').forEach((item) => item.classList.toggle('is-selected', item === tab));
    document.querySelectorAll('[data-parent-panel]').forEach((panel) => {
      const active = panel.dataset.parentPanel === tab.dataset.parentTab;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    if (tab.dataset.parentTab === 'content') renderContentManager(managedMode);
  }

  const manageTab = event.target.closest('[data-manage-mode]');
  if (manageTab) {
    document.querySelectorAll('[data-manage-mode]').forEach((item) => {
      const selected = item === manageTab;
      item.classList.toggle('is-selected', selected);
      item.setAttribute('aria-selected', String(selected));
    });
    renderContentManager(manageTab.dataset.manageMode);
  }

  const moveButton = event.target.closest('[data-move-content]');
  if (moveButton) {
    const row = moveButton.closest('[data-manage-id]');
    const shelf = getManagedShelf();
    const cards = [...shelf.querySelectorAll('.media-cover')];
    const card = cards.find((item) => item.dataset.contentId === row.dataset.manageId);
    const index = cards.indexOf(card);
    if (moveButton.dataset.moveContent === 'up' && index > 0) shelf.insertBefore(card, cards[index - 1]);
    if (moveButton.dataset.moveContent === 'down' && index < cards.length - 1) shelf.insertBefore(cards[index + 1], card);
    renderContentManager();
    saveContentState(managedMode);
    showToast('儿童端顺序已更新');
  }

  const deleteButton = event.target.closest('[data-delete-content]');
  if (deleteButton) {
    const id = deleteButton.dataset.deleteContent;
    const row = deleteButton.closest('[data-manage-id]');
    const title = row?.querySelector('[data-rename-content]')?.value.trim() || '这项内容';
    if (!window.confirm(`确定删除“${title}”吗？\n删除后需要重新导入才能恢复。`)) return;

    if (id === 'local-video-series') {
      const localVideos = (await getAllRecords('media')).filter((record) => record.category === 'video');
      await Promise.all(localVideos.map((record) => deleteRecord('media', record.id)));
      localVideos.forEach((record) => importedFileKeys.delete(record.key));
      delete seriesCatalog['local-videos'];
    } else if (id.startsWith('local-')) {
      const record = await databaseRequest('media', 'readonly', (store) => store.get(id));
      await deleteRecord('media', id);
      if (record?.key) importedFileKeys.delete(record.key);
    } else {
      const deletedKey = `deleted-content:${managedMode}`;
      const deletedIds = await readSetting(deletedKey) || [];
      if (!deletedIds.includes(id)) await saveSetting(deletedKey, [...deletedIds, id]);
    }

    cardsWithId(id).forEach((card) => card.remove());
    await saveContentState(managedMode);
    renderContentManager(managedMode);
    showToast(`已删除“${title}”`);
  }

  if (event.target.closest('[data-add-time]')) {
    document.querySelector('#usage-left').textContent = '剩余 34 分钟';
    document.querySelector('#video-remaining').textContent = '还剩 34 分钟';
    showToast('今天已增加 10 分钟');
  }

  if (event.target.closest('[data-save-rules]')) showToast('时间规则已保存');
  if (event.target.closest('[data-import]')) document.querySelector('#local-file-input').click();
  if (event.target.closest('[data-enable-offline]')) prepareOfflineStorage(true);
});

document.addEventListener('input', (event) => {
  const setting = event.target.closest('[data-setting]');
  if (setting) {
    const value = setting.type === 'checkbox' ? setting.checked : setting.value;
    saveSetting(setting.dataset.setting, value);
    if (setting.dataset.setting === 'reduce-motion') document.documentElement.classList.toggle('reduce-motion', Boolean(value));
  }

  const rename = event.target.closest('[data-rename-content]');
  if (rename) {
    const nextName = rename.value.trim() || '未命名内容';
    cardsWithId(rename.dataset.renameContent).forEach((card) => {
      const title = card.querySelector('.media-cover__title');
      if (title) title.textContent = nextName;
      if (card.dataset.playAudio) card.dataset.playAudio = nextName;
      if (card.dataset.openSeries && seriesCatalog[card.dataset.openSeries]) seriesCatalog[card.dataset.openSeries].title = nextName;
    });
    saveContentState(managedMode);
  }

  const visibility = event.target.closest('[data-toggle-visible]');
  if (visibility) {
    cardsWithId(visibility.dataset.toggleVisible).forEach((card) => { card.hidden = !visibility.checked; });
    const label = visibility.closest('.visibility-toggle').querySelector('span');
    label.textContent = visibility.checked ? '儿童端可见' : '已隐藏';
    saveContentState(managedMode);
  }
});

document.addEventListener('change', (event) => {
  const setting = event.target.closest('[data-setting]');
  if (!setting) return;
  const value = setting.type === 'checkbox' ? setting.checked : setting.value;
  saveSetting(setting.dataset.setting, value);
  if (setting.dataset.setting === 'reduce-motion') {
    document.documentElement.classList.toggle('reduce-motion', Boolean(value));
  }
});

document.querySelector('[data-close-dialog]').addEventListener('click', () => parentDialog.close());
parentDialog.addEventListener('click', (event) => {
  const bounds = parentDialog.getBoundingClientRect();
  const inside = event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
  if (!inside) parentDialog.close();
});

const holdButton = document.querySelector('[data-hold-enter]');
const deviceVerifyButton = document.querySelector('[data-device-verify]');
const parentAuthToggle = document.querySelector('[data-parent-auth-toggle]');

async function enterWithDeviceVerification() {
  if (parentAuthBusy) return;
  parentAuthBusy = true;
  deviceVerifyButton.disabled = true;
  deviceVerifyButton.setAttribute('aria-busy', 'true');
  deviceVerifyButton.textContent = '正在等待系统验证…';
  try {
    if (!await verifyParentCredential()) throw new Error('cancelled');
    if (parentDialog.open) parentDialog.close();
    showScreen('parent');
  } catch (error) {
    if (!parentDialog.open) parentDialog.showModal();
    showToast(parentAuthMessage(error));
  } finally {
    parentAuthBusy = false;
    deviceVerifyButton.disabled = false;
    deviceVerifyButton.removeAttribute('aria-busy');
    deviceVerifyButton.textContent = '使用设备验证';
  }
}

document.querySelectorAll('[data-parent-lock]').forEach((button) => button.addEventListener('click', async () => {
  if (!parentCredentialId) {
    updateParentAuthInterface(await supportsParentDeviceVerification());
    if (!parentDialog.open) parentDialog.showModal();
    return;
  }
  await enterWithDeviceVerification();
}));

deviceVerifyButton.addEventListener('click', enterWithDeviceVerification);

parentAuthToggle.addEventListener('click', async () => {
  if (parentAuthBusy) return;
  parentAuthBusy = true;
  parentAuthToggle.disabled = true;
  parentAuthToggle.setAttribute('aria-busy', 'true');
  try {
    if (parentCredentialId) {
      parentCredentialId = '';
      await saveSetting(PARENT_CREDENTIAL_KEY, '');
      updateParentAuthInterface(await supportsParentDeviceVerification());
      showToast('设备验证已关闭');
    } else {
      await createParentCredential();
      showToast('设备验证已开启');
    }
  } catch (error) {
    showToast(parentAuthMessage(error));
  } finally {
    parentAuthBusy = false;
    parentAuthToggle.removeAttribute('aria-busy');
    updateParentAuthInterface(await supportsParentDeviceVerification());
  }
});

function beginHold() {
  holdButton.classList.add('is-holding');
  holdTimer = window.setTimeout(() => {
    holdButton.classList.remove('is-holding');
    parentDialog.close();
    showScreen('parent');
  }, 1500);
}

function cancelHold() {
  window.clearTimeout(holdTimer);
  holdButton.classList.remove('is-holding');
}

holdButton.addEventListener('pointerdown', beginHold);
holdButton.addEventListener('pointerup', cancelHold);
holdButton.addEventListener('pointerleave', cancelHold);
holdButton.addEventListener('pointercancel', cancelHold);
holdButton.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) beginHold();
});
holdButton.addEventListener('keyup', cancelHold);

['video', 'music', 'story'].forEach((kind) => {
  const range = document.querySelector(`#${kind}-limit`);
  const output = document.querySelector(`#${kind}-limit-output`);
  const usedMinutes = { video: 6, music: 18, story: 12 }[kind];
  range.addEventListener('input', () => {
    output.value = `${range.value} 分钟`;
    output.textContent = `${range.value} 分钟`;
    const remaining = Math.max(0, Number(range.value) - usedMinutes);
    const homeRemaining = document.querySelector(`#home-${kind}-remaining`);
    if (homeRemaining) homeRemaining.textContent = `剩余可${kind === 'video' ? '看' : '听'} ${remaining} 分钟`;
    const usageRemaining = document.querySelector(kind === 'video' ? '#usage-left' : `#usage-${kind}-left`);
    if (usageRemaining) usageRemaining.textContent = `剩余 ${remaining} 分钟`;
    saveSetting(`${kind}-limit`, range.value);
  });
});

const fileInput = document.querySelector('#local-file-input');
const LOCAL_VIDEO_PLACEHOLDER = 'assets/illustrations/watch-fort.png';
const VIDEO_THUMBNAIL_VERSION = 4;

function baseFileName(name) {
  return name.replace(/\.[^.]+$/, '');
}

function addImportedAudio(file, url, id, category = 'music') {
  const shelf = document.querySelector(`[data-home-mount="${category}"] .home-media-shelf`);
  if (!shelf) return;
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'media-cover cover--lavender';
  card.dataset.contentId = id;
  card.dataset.audioKind = category;
  card.dataset.playAudio = baseFileName(file.name);
  card.dataset.playerTheme = 'lavender';
  card.dataset.localUrl = url;
  card.innerHTML = `<span class="cover-art cover-art--cloud" aria-hidden="true"><i></i><b></b></span><span class="media-cover__title">${escapeHtml(baseFileName(file.name))}</span><span class="media-cover__meta">本地${category === 'story' ? '故事' : '音乐'}</span>`;
  shelf.append(card);
  if (managedMode === category) renderContentManager();
}

function videoThumbnail(file) {
  return new Promise((resolve) => {
    const source = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;
    let candidates = [];
    let candidateIndex = 0;
    let bestFrame = null;
    const cleanup = (result = null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(source);
      resolve(result);
    };
    const capture = () => {
      if (!video.videoWidth || !video.videoHeight) return cleanup();
      const canvas = document.createElement('canvas');
      const width = 640;
      canvas.width = width;
      canvas.height = Math.round(width * video.videoHeight / video.videoWidth);
      const context = canvas.getContext('2d');
      if (!context) return cleanup();
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const sample = document.createElement('canvas');
      sample.width = 64;
      sample.height = Math.max(1, Math.round(64 * video.videoHeight / video.videoWidth));
      const sampleContext = sample.getContext('2d', { willReadFrequently: true });
      let brightness = 0;
      if (sampleContext) {
        sampleContext.drawImage(canvas, 0, 0, sample.width, sample.height);
        const pixels = sampleContext.getImageData(0, 0, sample.width, sample.height).data;
        for (let index = 0; index < pixels.length; index += 4) {
          brightness += pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722;
        }
        brightness /= pixels.length / 4;
      }
      if (!bestFrame || brightness > bestFrame.brightness) bestFrame = { canvas, brightness };
      candidateIndex += 1;
      if (candidateIndex < candidates.length) {
        window.setTimeout(() => {
          if (!settled) video.currentTime = candidates[candidateIndex];
        }, 0);
        return;
      }
      bestFrame.canvas.toBlob((blob) => cleanup(blob), 'image/jpeg', 0.84);
    };
    const timeout = window.setTimeout(() => {
      if (bestFrame) bestFrame.canvas.toBlob((blob) => cleanup(blob), 'image/jpeg', 0.84);
      else cleanup();
    }, 15000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.addEventListener('error', () => cleanup(), { once: true });
    video.addEventListener('loadedmetadata', () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const latest = Math.max(0.2, duration - 0.2);
      candidates = duration
        ? [...new Set([0.25, 0.5, 0.75].map((ratio) => Math.min(latest, Math.max(0.2, duration * ratio))))]
        : [1];
      video.currentTime = candidates[0];
    }, { once: true });
    video.addEventListener('seeked', capture);
    video.src = source;
  });
}

function addImportedVideo(file, url, id, thumbnailUrl = LOCAL_VIDEO_PLACEHOLDER) {
  const localId = 'local-videos';
  if (!seriesCatalog[localId]) {
    seriesCatalog[localId] = { title: '闪闪的动画', cover: thumbnailUrl, episodes: [] };
    const shelf = document.querySelector('[data-home-mount="video"] .home-media-shelf');
    if (shelf) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'media-cover';
      card.dataset.contentId = 'local-video-series';
      card.dataset.openSeries = localId;
      card.innerHTML = `<img class="cover-art cover-art--photo" src="${escapeHtml(thumbnailUrl)}" alt="" aria-hidden="true"><span class="media-cover__title">闪闪的动画</span><span class="media-cover__meta" data-local-video-count>动画合集 · 0 个章节</span>`;
      shelf.append(card);
      if (managedMode === 'video') renderContentManager();
    }
  }
  seriesCatalog[localId].episodes.push({ title: baseFileName(file.name), url, id, cover: thumbnailUrl });
  const count = document.querySelector('[data-local-video-count]');
  if (count) count.textContent = `动画合集 · ${seriesCatalog[localId].episodes.length} 个章节`;
}

fileInput.addEventListener('change', async () => {
  const files = [...fileInput.files];
  let added = 0;
  let skipped = 0;
  for (const file of files) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    const extension = file.name.split('.').pop().toLowerCase();
    const audio = file.type.startsWith('audio/') || ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg'].includes(extension);
    const video = file.type.startsWith('video/') || ['mp4', 'mov', 'm4v', 'webm'].includes(extension);
    if ((!audio && !video) || importedFileKeys.has(key)) {
      skipped += 1;
      continue;
    }
    const category = audio && managedMode === 'story' ? 'story' : audio ? 'music' : 'video';
    const id = `local-${category}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const thumbnailBlob = video ? await videoThumbnail(file) : null;
    try {
      await putRecord('media', {
        id,
        key,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        mimeType: file.type,
        category,
        createdAt: Date.now(),
        blob: file,
        thumbnailBlob,
        thumbnailVersion: video ? VIDEO_THUMBNAIL_VERSION : undefined
      });
    } catch (error) {
      console.warn('本地文件保存失败', error);
      showToast('存储空间不足，这个文件没有保存');
      continue;
    }
    importedFileKeys.add(key);
    const url = URL.createObjectURL(file);
    sessionObjectUrls.push(url);
    if (audio) addImportedAudio(file, url, id, category);
    if (video) {
      const thumbnailUrl = thumbnailBlob ? URL.createObjectURL(thumbnailBlob) : LOCAL_VIDEO_PLACEHOLDER;
      if (thumbnailBlob) sessionObjectUrls.push(thumbnailUrl);
      addImportedVideo(file, url, id, thumbnailUrl);
    }
    added += 1;
  }
  fileInput.value = '';
  if (added) {
    await saveContentState(managedMode);
    showToast(`已安全保存 ${added} 个本地文件`);
  }
  else if (skipped) showToast('没有加入文件：可能格式不支持或内容重复');
});

document.querySelector('#local-audio-player').addEventListener('error', () => showToast('这个音频文件无法读取'));
document.querySelector('#local-video-player').addEventListener('error', () => showToast('这个视频文件无法读取'));
document.addEventListener('visibilitychange', () => {
  const videoScreen = document.querySelector('[data-screen="video-player"]');
  if (videoScreen.hidden) return;
  if (document.hidden) {
    window.clearTimeout(videoControlsTimer);
    document.querySelector('#local-video-player').pause();
    if (!videoScreen.classList.contains('is-local')) setVideoPlayState(false);
  } else {
    showVideoControls({ autoHide: false });
  }
});
window.addEventListener('beforeunload', () => sessionObjectUrls.forEach((url) => URL.revokeObjectURL(url)));

window.addEventListener('hashchange', () => {
  const name = window.location.hash.replace('#', '');
  if (screens.some((screen) => screen.dataset.screen === name)) showScreen(name);
});

const initialScreen = window.location.hash.replace('#', '');
if (screens.some((screen) => screen.dataset.screen === initialScreen)) showScreen(initialScreen);

function isStandaloneApp() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function updatePwaStatus() {
  const status = document.querySelector('#pwa-status');
  const help = document.querySelector('#pwa-help');
  if (!status || !help) return;
  const persistent = await navigator.storage?.persisted?.().catch(() => false);
  if (isStandaloneApp() && persistent) {
    status.textContent = '已安装，本机存储已保护';
    help.textContent = '断网也能打开；请不要在系统设置中清除该网站的数据。';
  } else if (isStandaloneApp()) {
    status.textContent = '已添加到主屏幕';
    help.textContent = '离线界面已缓存；建议点击右侧按钮再检查本机存储。';
  } else {
    status.textContent = '还未添加到主屏幕';
    help.textContent = '在 iPad Safari 中点击“分享”→“添加到主屏幕”。';
  }
}

async function prepareOfflineStorage(notify = false) {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
    await updatePwaStatus();
    if (notify) showToast(isStandaloneApp() ? '离线存储状态已检查' : '请先用 Safari 添加到主屏幕');
  } catch (error) {
    console.warn('无法请求持久存储', error);
    if (notify) showToast('暂时无法检查离线存储');
  }
}

async function restoreImportedMedia() {
  const records = (await getAllRecords('media')).sort((a, b) => a.createdAt - b.createdAt);
  for (const record of records) {
    importedFileKeys.add(record.key);
    const url = URL.createObjectURL(record.blob);
    sessionObjectUrls.push(url);
    const fileInfo = { name: record.name };
    if (record.category === 'video') {
      if (!record.thumbnailBlob || record.thumbnailVersion !== VIDEO_THUMBNAIL_VERSION) {
        record.thumbnailBlob = await videoThumbnail(record.blob);
        record.thumbnailVersion = VIDEO_THUMBNAIL_VERSION;
        await putRecord('media', record);
      }
      const thumbnailUrl = record.thumbnailBlob ? URL.createObjectURL(record.thumbnailBlob) : LOCAL_VIDEO_PLACEHOLDER;
      if (record.thumbnailBlob) sessionObjectUrls.push(thumbnailUrl);
      addImportedVideo(fileInfo, url, record.id, thumbnailUrl);
    } else {
      addImportedAudio(fileInfo, url, record.id, record.category || 'music');
    }
  }
}

async function restoreSettings() {
  for (const kind of ['video', 'music', 'story']) {
    const value = await readSetting(`${kind}-limit`);
    const range = document.querySelector(`#${kind}-limit`);
    if (value !== undefined && range) {
      range.value = value;
      range.dispatchEvent(new Event('input'));
    }
  }
  for (const control of document.querySelectorAll('[data-setting]')) {
    const value = await readSetting(control.dataset.setting);
    if (value === undefined) continue;
    if (control.type === 'checkbox') control.checked = Boolean(value);
    else control.value = value;
    if (control.dataset.setting === 'reduce-motion') document.documentElement.classList.toggle('reduce-motion', Boolean(value));
  }
}

async function initializePersistentApp() {
  try {
    await openDatabase();
    await restoreImportedMedia();
    await Promise.all(['music', 'story', 'video'].map(restoreContentState));
    await saveContentState('video');
    await restoreSettings();
    parentCredentialId = await readSetting(PARENT_CREDENTIAL_KEY) || '';
    updateParentAuthInterface(await supportsParentDeviceVerification());
    renderContentManager(managedMode);
  } catch (error) {
    console.warn('本地数据库初始化失败', error);
    showToast('当前浏览器无法保存本地内容');
  }
  prepareOfflineStorage(false);
}

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('离线服务注册失败', error));
}

initializePersistentApp();
