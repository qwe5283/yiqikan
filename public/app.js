(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const socket = io({ reconnection: true });
  const state = {
    mode: 'create',
    code: '',
    nickname: '',
    selfId: '',
    users: [],
    playlist: [],
    messages: [],
    playback: null,
    currentMediaId: null,
    lastControlAt: 0,
    seeking: false,
    uploadBusy: false,
    maxFileSize: 2 * 1024 ** 3,
    maxFileSizeLabel: '2 GiB',
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    reconnecting: false,
    voice: { active: false, mode: 'hold', stream: null, peers: new Map() },
  };
  async function loadConfig() {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('配置读取失败');
    const config = await response.json();
    if (Number.isSafeInteger(config.maxFileSize) && config.maxFileSize > 0) {
      state.maxFileSize = config.maxFileSize;
      state.maxFileSizeLabel = config.maxFileSizeLabel || state.maxFileSizeLabel;
      $('maxFileSizeLabel').textContent = `支持常见音视频格式 · 最大 ${state.maxFileSizeLabel}`;
    }
    if (Array.isArray(config.iceServers) && config.iceServers.length) state.iceServers = config.iceServers;
  }
  const configReady = loadConfig().catch(() => {});

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function toast(text, type = '') {
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = text;
    $('toastRegion').append(item);
    setTimeout(() => item.remove(), 3400);
  }

  function emitAck(event, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!socket.connected) return reject(new Error('连接已断开，请稍后重试'));
      socket.timeout(9000).emit(event, payload, (error, response) => {
        if (error) return reject(new Error('请求超时，请检查网络后重试'));
        if (!response || !response.ok) return reject(new Error(response && response.error || '操作失败'));
        resolve(response);
      });
    });
  }

  function setEntryMode(mode) {
    state.mode = mode;
    for (const button of document.querySelectorAll('[data-mode]')) {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    $('joinCodeField').hidden = mode !== 'join';
    $('joinCodeInput').required = mode === 'join';
    $('entrySubmitText').textContent = mode === 'create' ? '创建我的房间' : '加入好友的房间';
  }

  document.querySelectorAll('[data-mode]').forEach((button) => {
    button.addEventListener('click', () => setEntryMode(button.dataset.mode));
  });
  $('joinCodeInput').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  $('entryForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const nickname = $('nicknameInput').value.trim();
    const code = $('joinCodeInput').value.trim().toUpperCase();
    if (!nickname || [...nickname].length > 16) return toast('请输入 1–16 个字符的昵称', 'error');
    if (state.mode === 'join' && !/^[A-Z0-9]{4}$/.test(code)) return toast('请输入完整的 4 位房间码', 'error');
    $('entrySubmit').disabled = true;
    $('entrySubmitText').textContent = state.mode === 'create' ? '正在创建…' : '正在加入…';
    try {
      const response = await emitAck(state.mode === 'create' ? 'room:create' : 'room:join', { nickname, code });
      state.nickname = nickname;
      enterRoom(response.snapshot);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      $('entrySubmit').disabled = false;
      setEntryMode(state.mode);
    }
  });

  function enterRoom(snapshot) {
    state.code = snapshot.code;
    state.selfId = snapshot.selfId;
    state.users = snapshot.users;
    state.playlist = snapshot.playlist;
    state.messages = snapshot.messages;
    state.playback = snapshot.playback;
    state.currentMediaId = null;
    $('landingView').hidden = true;
    $('roomView').hidden = false;
    $('roomCode').textContent = state.code;
    document.title = `${state.code} · 一起看`;
    renderUsers();
    renderMessages(true);
    renderPlaylist();
    applyPlayback(snapshot.playback);
    history.replaceState(null, '', `?room=${state.code}`);
  }

  function resetRoom() {
    stopVoice(false);
    state.code = '';
    state.selfId = '';
    state.users = [];
    state.playlist = [];
    state.messages = [];
    state.playback = null;
    state.currentMediaId = null;
    $('player').pause();
    $('player').removeAttribute('src');
    $('player').load();
    $('roomView').hidden = true;
    $('landingView').hidden = false;
    document.title = '一起看 · 精彩同步发生';
    history.replaceState(null, '', location.pathname);
  }

  $('leaveButton').addEventListener('click', () => {
    const event = state.code ? 'room:leave' : null;
    resetRoom();
    if (event) socket.emit(event, {}, () => {});
  });

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    const input = document.createElement('textarea');
    input.value = text;
    input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
    document.body.append(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) throw new Error('复制失败');
  }

  $('copyCodeButton').addEventListener('click', async () => {
    try {
      await copyText(state.code);
      toast(`房间码 ${state.code} 已复制`, 'success');
      $('copyCodeButton').querySelector('use').setAttribute('href', '#i-check');
      setTimeout(() => $('copyCodeButton').querySelector('use').setAttribute('href', '#i-copy'), 1600);
    } catch {
      toast(`请手动复制房间码：${state.code}`, 'error');
    }
  });

  function renderUsers() {
    $('onlineCount').textContent = `${state.users.length} 位成员在线`;
    const avatars = $('headerAvatars');
    avatars.replaceChildren();
    for (const user of state.users) {
      const avatar = document.createElement('span');
      avatar.className = 'header-avatar online';
      avatar.textContent = [...user.nickname][0] || '友';
      avatar.title = `${user.nickname}${user.id === state.selfId ? '（我）' : ''}`;
      avatars.append(avatar);
    }
  }

  function sameDay(left, right) {
    return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
  }

  function messageTime(timestamp) {
    const date = new Date(timestamp);
    const time = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    return sameDay(date, new Date()) ? time : `${date.getMonth() + 1}月${date.getDate()}日 ${time}`;
  }

  function renderMessages(forceScroll = false) {
    const box = $('messages');
    const stickToBottom = forceScroll || box.scrollHeight - box.scrollTop - box.clientHeight < 90;
    const fragment = document.createDocumentFragment();
    state.messages.forEach((message, index) => {
      const previous = state.messages[index - 1];
      if (!previous || message.at - previous.at >= 5 * 60 * 1000) {
        const divider = document.createElement('div');
        divider.className = 'time-divider';
        const label = document.createElement('span');
        label.textContent = messageTime(message.at);
        divider.append(label);
        fragment.append(divider);
      }
      if (message.kind === 'system') {
        const row = document.createElement('div');
        row.className = 'system-message';
        const text = document.createElement('span');
        text.textContent = message.text;
        row.append(text);
        fragment.append(row);
        return;
      }
      const own = message.userId === state.selfId;
      const row = document.createElement('div');
      row.className = `message-row${own ? ' own' : ''}`;
      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = [...(message.nickname || '友')][0];
      const content = document.createElement('div');
      content.className = 'message-content';
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const name = document.createElement('strong');
      name.textContent = own ? '我' : message.nickname;
      meta.append(name);
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.textContent = message.text;
      content.append(meta, bubble);
      row.append(avatar, content);
      fragment.append(row);
    });
    box.replaceChildren(fragment);
    if (stickToBottom) requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
  }

  function resizeComposer() {
    const input = $('chatInput');
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 92)}px`;
    $('charCount').textContent = input.value.length >= 800 ? `${input.value.length}/1000` : '';
  }
  $('chatInput').addEventListener('input', resizeComposer);
  $('chatInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('chatForm').requestSubmit();
    }
  });
  $('chatForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('chatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    resizeComposer();
    try {
      await emitAck('chat:send', { text });
    } catch (error) {
      input.value = text;
      resizeComposer();
      toast(error.message, 'error');
    }
    input.focus();
  });

  function formatSize(bytes) {
    if (!Number.isFinite(bytes)) return '';
    if (bytes <= 0) return '0 KB';
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  function currentMedia() {
    return state.playlist.find((item) => item.id === state.playback?.mediaId);
  }

  function renderPlaylist() {
    $('playlistCount').textContent = state.playlist.length;
    const list = $('mediaList');
    list.replaceChildren();
    if (!state.playlist.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-playlist';
      empty.textContent = '还没有内容，上传一部影片或一首音乐吧';
      list.append(empty);
      return;
    }
    for (const media of state.playlist) {
      const button = document.createElement('button');
      const active = media.id === state.playback?.mediaId;
      button.type = 'button';
      button.className = `media-item${active ? ' active' : ''}`;
      const thumb = document.createElement('span');
      thumb.className = 'media-thumb';
      thumb.append(icon(media.kind === 'audio' ? 'music' : 'video'));
      const copy = document.createElement('span');
      copy.className = 'media-copy';
      const name = document.createElement('strong');
      name.textContent = media.name;
      name.title = media.name;
      const detail = document.createElement('small');
      detail.textContent = `${media.kind === 'audio' ? '音频' : '视频'} · ${formatSize(media.size)} · ${media.addedBy || '房间成员'}`;
      copy.append(name, detail);
      button.append(thumb, copy);
      if (active && !state.playback?.paused) {
        const playing = document.createElement('span');
        playing.className = 'playing-indicator';
        playing.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
        button.append(playing);
      }
      button.addEventListener('click', async () => {
        if (media.id === state.playback?.mediaId) return;
        try {
          await emitAck('media:switch', { mediaId: media.id });
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      list.append(button);
    }
  }

  const TRANSFER_WINDOW = 2500;
  const TRANSFER_PAINT = 120;
  let transfer = null;
  let uploadJob = null;

  function setUploadProgress(percent, status) {
    $('uploadProgress').hidden = false;
    $('uploadBar').style.width = `${percent}%`;
    $('uploadPercent').textContent = `${Math.round(percent)}%`;
    if (status) $('uploadStatus').textContent = status;
  }

  function formatSpeed(bytesPerSecond) {
    const value = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB/s`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB/s`;
    if (value >= 1024) return `${Math.round(value / 1024)} KB/s`;
    return `${Math.round(value)} B/s`;
  }

  function beginTransfer(size) {
    transfer = { size, startedAt: performance.now(), samples: [], paintedAt: 0 };
    $('uploadMeta').hidden = false;
    $('uploadSize').textContent = `0 KB / ${formatSize(size)}`;
    $('uploadSpeed').textContent = '';
  }

  function trackTransfer(loaded, final = false) {
    if (!transfer) return;
    const now = performance.now();
    const sent = Math.min(Math.max(loaded, 0), transfer.size);
    const samples = transfer.samples;
    samples.push({ at: now, loaded: sent });
    while (samples.length > 2 && now - samples[0].at > TRANSFER_WINDOW) samples.shift();
    if (!final && now - transfer.paintedAt < TRANSFER_PAINT) return;
    transfer.paintedAt = now;
    const first = samples[0];
    const elapsed = (now - first.at) / 1000;
    // 过程中用最近窗口的瞬时速度，收尾时用全程平均速度，避免末尾数字乱跳
    const speed = final
      ? transfer.size / Math.max(0.001, (now - transfer.startedAt) / 1000)
      : (elapsed > 0 ? (sent - first.loaded) / elapsed : 0);
    setUploadProgress(50 + (sent / transfer.size) * 45);
    $('uploadSize').textContent = `${formatSize(sent)} / ${formatSize(transfer.size)}`;
    $('uploadSpeed').textContent = final || elapsed >= 0.4 ? formatSpeed(speed) : '';
  }

  function beginJob() {
    uploadJob = { aborted: false, committed: false, request: null, controller: new AbortController() };
    $('uploadCancel').disabled = false;
    return uploadJob;
  }

  function commitJob() {
    if (!uploadJob) return;
    uploadJob.committed = true;
    $('uploadCancel').disabled = true;
  }

  function cancelUpload() {
    const job = uploadJob;
    if (!job || job.aborted || job.committed) return;
    job.aborted = true;
    $('uploadCancel').disabled = true;
    if (job.request) job.request.abort();
    job.controller.abort();
  }

  async function md5Of(file, job) {
    const spark = new SparkMD5.ArrayBuffer();
    const chunkSize = 2 * 1024 * 1024;
    for (let start = 0; start < file.size; start += chunkSize) {
      if (job.aborted) throw new Error('上传已取消');
      const end = Math.min(start + chunkSize, file.size);
      spark.append(await file.slice(start, end).arrayBuffer());
      setUploadProgress(5 + (end / file.size) * 40, '正在计算 MD5，相同文件可秒传…');
    }
    return spark.end();
  }

  function uploadRequest(file, md5, job) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open('POST', '/api/media/upload');
      request.responseType = 'json';
      job.request = request;
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) trackTransfer(event.loaded);
      };
      request.onerror = () => reject(new Error('上传失败，请检查网络'));
      request.onabort = () => reject(new Error('上传已取消'));
      request.onload = () => {
        const response = request.response || {};
        if (request.status >= 200 && request.status < 300 && response.media) {
          trackTransfer(file.size, true);
          return resolve(response.media);
        }
        reject(new Error(response.error || '上传失败'));
      };
      const form = new FormData();
      form.append('name', file.name);
      form.append('md5', md5);
      form.append('file', file);
      request.send(form);
    });
  }

  async function uploadOne(file) {
    const job = beginJob();
    $('uploadName').textContent = file.name;
    transfer = null;
    $('uploadMeta').hidden = true;
    setUploadProgress(2, '正在读取文件…');
    const md5 = await md5Of(file, job);
    setUploadProgress(47, '正在检查是否可以秒传…');
    const response = await fetch(`/api/media/check?md5=${md5}`, { cache: 'no-store', signal: job.controller.signal });
    const check = await response.json();
    if (!response.ok) throw new Error(check.error || '校验失败');
    let media = check.media;
    if (media) {
      setUploadProgress(96, '发现相同文件，秒传完成');
      toast(`「${file.name}」已秒传`, 'success');
    } else {
      setUploadProgress(50, '正在上传媒体…');
      beginTransfer(file.size);
      media = await uploadRequest(file, md5, job);
    }
    if (job.aborted) throw new Error('上传已取消');
    commitJob();
    setUploadProgress(100, '正在加入播放列表…');
    const result = await emitAck('media:add', { md5: media.md5, name: file.name });
    if (result.duplicate) toast('这个文件已经在播放列表中');
  }

  $('fileInput').addEventListener('change', async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    if (!files.length || state.uploadBusy) return;
    state.uploadBusy = true;
    $('uploadButton').disabled = true;
    $('emptyUploadButton').disabled = true;
    try {
      await configReady;
      for (const file of files) {
        try {
          if (file.size > state.maxFileSize) throw new Error(`单个文件不能超过 ${state.maxFileSizeLabel}`);
          if (!file.size) throw new Error('不能上传空文件');
          await uploadOne(file);
        } catch (error) {
          if (uploadJob && uploadJob.aborted) {
            toast('已取消上传');
            break;
          }
          toast(`${file.name}：${error.message}`, 'error');
        }
      }
    } finally {
      state.uploadBusy = false;
      transfer = null;
      uploadJob = null;
      $('uploadButton').disabled = false;
      $('emptyUploadButton').disabled = false;
      $('uploadProgress').hidden = true;
    }
  });
  $('uploadCancel').addEventListener('click', cancelUpload);
  for (const id of ['uploadButton', 'emptyUploadButton']) {
    $(id).addEventListener('click', () => {
      if (!state.code) return;
      $('fileInput').click();
    });
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const rest = value % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
      : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }

  function serverPosition() {
    if (!state.playback) return 0;
    const elapsed = state.playback.paused ? 0 : Math.max(0, Date.now() - state.playback.updatedAt) / 1000;
    return state.playback.currentTime + elapsed;
  }

  function updatePlayButton() {
    const paused = $('player').paused;
    $('playButton').querySelector('use').setAttribute('href', paused ? '#i-play' : '#i-pause');
    $('playButton').setAttribute('aria-label', paused ? '播放' : '暂停');
    $('stage').classList.toggle('playing', !paused);
  }

  function updateTimeline() {
    const player = $('player');
    const duration = Number.isFinite(player.duration) ? player.duration : 0;
    if (!state.seeking) {
      const ratio = duration ? Math.min(1, player.currentTime / duration) : 0;
      $('timeline').value = Math.round(ratio * 1000);
      $('timeline').style.setProperty('--progress', `${ratio * 100}%`);
      $('currentTime').textContent = formatTime(player.currentTime);
    }
    $('duration').textContent = formatTime(duration);
  }

  function updateMediaStage() {
    const media = currentMedia();
    $('stage').classList.toggle('empty', !media);
    $('stage').classList.toggle('audio-mode', media?.kind === 'audio');
    $('emptyPlayer').hidden = Boolean(media);
    $('audioArtwork').hidden = media?.kind !== 'audio';
    $('mediaKindBadge').hidden = !media;
    $('mediaKindBadge').textContent = media ? `${media.kind === 'audio' ? '音频' : '视频'} · ${media.name}` : '';
    $('audioTitle').textContent = media?.name || '';
    $('nowPlaying').textContent = media?.name || '尚未选择媒体';
    for (const id of ['playButton', 'rewindButton', 'forwardButton', 'timeline', 'fullscreenButton']) {
      $(id).disabled = !media;
    }
  }

  function syncPlayer(force = false) {
    const player = $('player');
    if (!state.playback?.mediaId || player.readyState < 1) return;
    let target = serverPosition();
    if (Number.isFinite(player.duration)) target = Math.min(target, player.duration);
    if (force || Math.abs(player.currentTime - target) > 0.75) player.currentTime = Math.max(0, target);
    if (state.playback.paused) {
      player.pause();
      $('resumeButton').hidden = true;
    } else if (player.paused) {
      player.play().then(() => {
        $('resumeButton').hidden = true;
      }).catch(() => {
        $('resumeButton').hidden = false;
      });
    }
    updateTimeline();
  }

  function applyPlayback(playback) {
    const previousId = state.currentMediaId;
    state.playback = playback;
    const media = currentMedia();
    if (playback?.mediaId !== previousId) {
      const player = $('player');
      player.pause();
      player.removeAttribute('src');
      player.load();
      state.currentMediaId = playback?.mediaId || null;
      $('resumeButton').hidden = true;
      if (media) {
        player.src = media.url;
        player.load();
      }
      updateMediaStage();
    }
    renderPlaylist();
    updateMediaStage();
    syncPlayer(previousId !== state.currentMediaId);
  }

  async function playbackAction(type, currentTime) {
    if (!currentMedia()) return toast('请先上传音视频', 'error');
    if (!Number.isFinite(currentTime)) currentTime = type === 'play' ? serverPosition() : $('player').currentTime;
    if (type === 'play' && $('player').ended) currentTime = 0;
    state.lastControlAt = Date.now();
    state.playback = { ...state.playback, currentTime, paused: type === 'seek' ? state.playback.paused : type === 'pause', updatedAt: Date.now() };
    if (type === 'play') {
      try {
        await $('player').play();
        $('resumeButton').hidden = true;
      } catch {
        $('resumeButton').hidden = false;
      }
    } else if (type === 'pause') {
      $('player').pause();
    } else {
      $('player').currentTime = currentTime;
      updateTimeline();
    }
    try {
      await emitAck('playback:action', { type, currentTime });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  $('playButton').addEventListener('click', () => playbackAction($('player').paused ? 'play' : 'pause'));
  $('resumeButton').addEventListener('click', () => playbackAction('play'));
  $('rewindButton').addEventListener('click', () => playbackAction('seek', Math.max(0, $('player').currentTime - 10)));
  $('forwardButton').addEventListener('click', () => playbackAction('seek', Math.min($('player').duration || Infinity, $('player').currentTime + 10)));
  $('timeline').addEventListener('pointerdown', () => { state.seeking = true; });
  $('timeline').addEventListener('input', () => {
    state.seeking = true;
    const duration = $('player').duration || 0;
    $('currentTime').textContent = formatTime(duration * $('timeline').value / 1000);
    $('timeline').style.setProperty('--progress', `${$('timeline').value / 10}%`);
  });
  $('timeline').addEventListener('change', () => {
    const target = ($('player').duration || 0) * $('timeline').value / 1000;
    state.seeking = false;
    playbackAction('seek', target);
  });
  $('volume').addEventListener('input', () => {
    $('player').volume = Number($('volume').value);
    $('player').muted = $('player').volume === 0;
    $('muteButton').querySelector('use').setAttribute('href', $('player').muted ? '#i-mute' : '#i-volume');
  });
  $('muteButton').addEventListener('click', () => {
    $('player').muted = !$('player').muted;
    $('muteButton').querySelector('use').setAttribute('href', $('player').muted ? '#i-mute' : '#i-volume');
  });
  let fullscreenHideTimer;
  function showFullscreenControls() {
    const playerCard = $('stage').parentElement;
    if (!document.fullscreenElement) return;
    playerCard.classList.remove('controls-hidden');
    clearTimeout(fullscreenHideTimer);
    fullscreenHideTimer = setTimeout(() => {
      if (document.fullscreenElement === playerCard && !state.seeking) {
        playerCard.classList.add('controls-hidden');
      }
    }, 3000);
  }
  for (const event of ['pointermove', 'pointerdown', 'pointerup']) {
    $('stage').parentElement.addEventListener(event, showFullscreenControls, { passive: true });
  }
  document.addEventListener('keydown', showFullscreenControls);
  $('fullscreenButton').addEventListener('click', async () => {
    const playerCard = $('stage').parentElement;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (playerCard.requestFullscreen) await playerCard.requestFullscreen();
      else if ($('player').webkitEnterFullscreen) $('player').webkitEnterFullscreen();
    } catch {
      toast('当前浏览器不支持全屏，也可尝试按 F11', 'error');
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const label = document.fullscreenElement ? '退出全屏' : '全屏';
    $('fullscreenButton').setAttribute('aria-label', label);
    $('fullscreenButton').title = label;
    clearTimeout(fullscreenHideTimer);
    if (document.fullscreenElement) showFullscreenControls();
    else $('stage').parentElement.classList.remove('controls-hidden');
  });
  $('player').addEventListener('loadedmetadata', () => syncPlayer(true));
  $('player').addEventListener('play', updatePlayButton);
  $('player').addEventListener('pause', updatePlayButton);
  $('player').addEventListener('timeupdate', () => {
    updateTimeline();
    if (state.seeking || $('player').paused || state.playback?.paused || Date.now() - state.lastControlAt < 1500) return;
    const target = serverPosition();
    if (Math.abs($('player').currentTime - target) > 1.5) $('player').currentTime = target;
  });
  $('player').addEventListener('ended', () => {
    if (state.playback && !state.playback.paused) playbackAction('pause', $('player').duration || 0);
  });
  $('player').addEventListener('error', () => {
    if (state.currentMediaId) toast('当前浏览器无法解码这个文件，建议换用 MP4 / WebM / MP3', 'error');
  });

  function updateVoiceUI() {
    const voice = state.voice;
    $('voiceToggle').textContent = voice.active ? '关闭' : '开启';
    $('voiceToggle').classList.toggle('active', voice.active);
    $('voiceToggle').setAttribute('aria-pressed', String(voice.active));
    $('voiceIcon').classList.toggle('active', voice.active);
    $('voiceControls').hidden = !voice.active;
    document.querySelectorAll('[data-voice-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.voiceMode === voice.mode);
    });
    $('holdToTalk').hidden = voice.mode !== 'hold';
    $('freeTalk').hidden = voice.mode !== 'free';
    if (!voice.active) $('voiceStatus').textContent = '默认关闭，需要时再开启';
    else if (!voice.peers.size) $('voiceStatus').textContent = '等待对方开启语音';
    else {
      const connected = [...voice.peers.values()].filter((peer) => peer.pc.connectionState === 'connected').length;
      $('voiceStatus').textContent = connected ? `${connected + 1} 人在通话` : '正在连接对方…';
    }
  }

  function setMicrophone(enabled) {
    if (!state.voice.active) return;
    state.voice.stream?.getAudioTracks().forEach((track) => { track.enabled = enabled; });
    $('holdToTalk').classList.toggle('talking', enabled && state.voice.mode === 'hold');
    $('holdToTalk').querySelector('span').textContent = enabled && state.voice.mode === 'hold' ? '正在说话…' : '按住说话';
  }

  function closePeer(id) {
    const peer = state.voice.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    if (peer.audio) {
      peer.audio.pause();
      peer.audio.remove();
    }
    state.voice.peers.delete(id);
    updateVoiceUI();
  }

  function makeOffer(id, peer) {
    peer.pc.createOffer()
      .then((offer) => peer.pc.setLocalDescription(offer))
      .then(() => socket.emit('voice:signal', { to: id, data: { type: 'offer', description: peer.pc.localDescription } }))
      .catch(() => {
        toast('语音连接建立失败，请重新开启', 'error');
        closePeer(id);
      });
  }

  function createPeer(id, initiator) {
    if (state.voice.peers.has(id)) return state.voice.peers.get(id);
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    const peer = { pc, candidates: [], audio: null };
    state.voice.peers.set(id, peer);
    state.voice.stream?.getTracks().forEach((track) => pc.addTrack(track, state.voice.stream));
    pc.onicecandidate = (event) => {
      if (event.candidate) socket.emit('voice:signal', { to: id, data: { type: 'candidate', candidate: event.candidate } });
    };
    pc.ontrack = (event) => {
      if (!peer.audio) {
        peer.audio = document.createElement('audio');
        peer.audio.autoplay = true;
        peer.audio.dataset.peer = id;
        document.body.append(peer.audio);
      }
      peer.audio.srcObject = event.streams[0];
      peer.audio.play().catch(() => toast('点击页面后可听到对方声音'));
    };
    pc.onconnectionstatechange = updateVoiceUI;
    updateVoiceUI();
    if (initiator) makeOffer(id, peer);
    return peer;
  }

  async function handleVoiceSignal({ from, data }) {
    if (!state.voice.active || !data) return;
    const peer = createPeer(from, false);
    try {
      if (data.type === 'offer') {
        await peer.pc.setRemoteDescription(data.description);
        for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        socket.emit('voice:signal', { to: from, data: { type: 'answer', description: peer.pc.localDescription } });
      } else if (data.type === 'answer') {
        await peer.pc.setRemoteDescription(data.description);
        for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
      } else if (data.type === 'candidate') {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
        else peer.candidates.push(data.candidate);
      }
    } catch {
      toast('语音连接不稳定，请尝试重新开启', 'error');
      closePeer(from);
    }
  }

  async function startVoice() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return toast('语音需要支持 WebRTC 的浏览器，并使用 localhost 或 HTTPS', 'error');
    }
    $('voiceToggle').disabled = true;
    try {
      await loadConfig();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      state.voice.stream = stream;
      state.voice.active = true;
      state.voice.mode = 'hold';
      setMicrophone(false);
      updateVoiceUI();
      const { peers } = await emitAck('voice:join');
      peers.forEach((id) => createPeer(id, true));
    } catch (error) {
      stopVoice(false);
      toast(error.name === 'NotAllowedError' ? '未获得麦克风权限，请在浏览器中允许后重试' : error.message, 'error');
    } finally {
      $('voiceToggle').disabled = false;
    }
  }

  function stopVoice(notify = true) {
    if (notify && state.voice.active) socket.emit('voice:leave');
    for (const id of [...state.voice.peers.keys()]) closePeer(id);
    state.voice.stream?.getTracks().forEach((track) => track.stop());
    state.voice.stream = null;
    state.voice.active = false;
    setMicrophone(false);
    updateVoiceUI();
  }

  $('voiceToggle').addEventListener('click', () => state.voice.active ? stopVoice() : startVoice());
  document.querySelectorAll('[data-voice-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      state.voice.mode = button.dataset.voiceMode;
      setMicrophone(state.voice.mode === 'free');
      updateVoiceUI();
    });
  });
  $('holdToTalk').addEventListener('pointerdown', (event) => {
    event.preventDefault();
    $('holdToTalk').setPointerCapture(event.pointerId);
    setMicrophone(true);
  });
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    $('holdToTalk').addEventListener(event, () => setMicrophone(false));
  }
  $('holdToTalk').addEventListener('keydown', (event) => {
    if ([' ', 'Enter'].includes(event.key) && !event.repeat) {
      event.preventDefault();
      setMicrophone(true);
    }
  });
  $('holdToTalk').addEventListener('keyup', (event) => {
    if ([' ', 'Enter'].includes(event.key)) setMicrophone(false);
  });
  $('holdToTalk').addEventListener('contextmenu', (event) => event.preventDefault());
  window.addEventListener('blur', () => {
    if (state.voice.mode === 'hold') setMicrophone(false);
  });

  socket.on('room:users', (users) => {
    state.users = users;
    renderUsers();
  });
  socket.on('message:new', (message) => {
    if (state.messages.some((item) => item.id === message.id)) return;
    state.messages.push(message);
    if (state.messages.length > 200) state.messages.shift();
    renderMessages(message.userId === state.selfId);
  });
  socket.on('playlist:state', (playlist) => {
    state.playlist = playlist;
    renderPlaylist();
    updateMediaStage();
  });
  socket.on('playback:state', applyPlayback);
  socket.on('voice:peer-joined', ({ id }) => {
    if (state.voice.active) createPeer(id, false);
  });
  socket.on('voice:signal', handleVoiceSignal);
  socket.on('voice:left', ({ id }) => closePeer(id));
  socket.on('error:message', (message) => toast(message, 'error'));
  socket.on('disconnect', () => {
    $('connectionStatus').textContent = '连接中…';
    $('connectionStatus').classList.add('offline');
    stopVoice(false);
  });
  socket.on('connect', async () => {
    $('connectionStatus').textContent = '已连接';
    $('connectionStatus').classList.remove('offline');
    if (!state.code || state.reconnecting) return;
    state.reconnecting = true;
    try {
      const response = await emitAck('room:join', { code: state.code, nickname: state.nickname });
      enterRoom(response.snapshot);
      toast('已重新连接到房间', 'success');
    } catch (error) {
      resetRoom();
      toast(error.message, 'error');
    } finally {
      state.reconnecting = false;
    }
  });

  const invitedCode = new URLSearchParams(location.search).get('room');
  if (invitedCode && /^[A-Z0-9]{4}$/i.test(invitedCode)) {
    setEntryMode('join');
    $('joinCodeInput').value = invitedCode.toUpperCase();
  }
  updateMediaStage();
  updateVoiceUI();
})();
