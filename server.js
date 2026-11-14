const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const { Server } = require('socket.io');
const {
  createCode,
  cleanNickname,
  playbackSnapshot,
  appendMessage,
  systemMessage,
} = require('./lib/rooms');
const { readMaxFileSize, fileSizeLabel } = require('./lib/config');
const { createIceServers } = require('./lib/turn');
const { createUploadStore, UploadError } = require('./lib/uploads');

const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_SIZE = readMaxFileSize();
const MAX_FILE_SIZE_LABEL = fileSizeLabel(MAX_FILE_SIZE);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TEMP_DIR = path.join(DATA_DIR, 'tmp');
for (const directory of [UPLOAD_DIR, TEMP_DIR]) fs.mkdirSync(directory, { recursive: true });

const MEDIA_TYPES = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
  '.ogv': 'video/ogg', '.mkv': 'video/x-matroska', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.flac': 'audio/flac',
};
const UPLOAD_SESSION_TTL = 24 * 60 * 60 * 1000;
const uploadStore = createUploadStore({
  tempDir: TEMP_DIR,
  uploadDir: UPLOAD_DIR,
  maxFileSize: MAX_FILE_SIZE,
  maxFileSizeLabel: MAX_FILE_SIZE_LABEL,
  allowedExtensions: Object.keys(MEDIA_TYPES),
});
const mediaIndex = new Map();

function cleanFileName(value) {
  return path.basename(String(value || '未命名媒体')).replace(/[\0\r\n]/g, '').trim().slice(0, 120) || '未命名媒体';
}

function makeMedia(md5, extension, name, size) {
  return {
    id: md5,
    md5,
    url: `/media/${md5}${extension}`,
    name: cleanFileName(name),
    size,
    kind: MEDIA_TYPES[extension].startsWith('audio/') ? 'audio' : 'video',
  };
}

function validateMediaRequest(name, mime) {
  const extension = path.extname(name).toLowerCase();
  if (!MEDIA_TYPES[extension]) {
    throw new UploadError(415, 'UNSUPPORTED_MEDIA_TYPE', '格式暂不支持，请选择常见音视频文件');
  }
  const value = String(mime || '');
  if (value && value !== 'application/octet-stream') {
    const mimeKind = value.split('/')[0];
    const extensionKind = MEDIA_TYPES[extension].startsWith('audio/') ? 'audio' : 'video';
    if (!['audio', 'video'].includes(mimeKind) || mimeKind !== extensionKind) {
      throw new UploadError(415, 'MEDIA_TYPE_MISMATCH', '文件类型与扩展名不一致');
    }
  }
}

function indexUploadedMedia(file) {
  const existing = mediaIndex.get(file.md5);
  if (existing) return existing;
  const media = makeMedia(file.md5, file.extension, file.name, file.size);
  mediaIndex.set(file.md5, media);
  return media;
}

for (const file of fs.readdirSync(UPLOAD_DIR)) {
  const match = file.match(/^([a-f0-9]{32})(\.[a-z0-9]+)$/i);
  if (!match || !MEDIA_TYPES[match[2].toLowerCase()]) continue;
  const md5 = match[1].toLowerCase();
  const extension = match[2].toLowerCase();
  const { size } = fs.statSync(path.join(UPLOAD_DIR, file));
  mediaIndex.set(md5, makeMedia(md5, extension, `已上传媒体${extension}`, size));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });
const rooms = new Map();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.json({ limit: '32kb' }));
app.use('/media', express.static(UPLOAD_DIR, { maxAge: '1y', immutable: true }));
app.get('/vendor/spark-md5.js', (req, res) => {
  res.sendFile(require.resolve('spark-md5/spark-md5.js'));
});
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    maxFileSize: MAX_FILE_SIZE,
    maxFileSizeLabel: MAX_FILE_SIZE_LABEL,
    iceServers: createIceServers(),
  });
});
app.get('/api/media/check', (req, res) => {
  const md5 = String(req.query.md5 || '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(md5)) return res.status(400).json({ error: '无效的 MD5' });
  const media = mediaIndex.get(md5);
  return res.json({ exists: Boolean(media), media });
});

app.post('/api/media/upload/init', async (req, res, next) => {
  try {
    const md5 = String(req.body && req.body.md5 || '').toLowerCase();
    const existing = mediaIndex.get(md5);
    if (existing) return res.json({ media: existing, instant: true });
    const name = cleanFileName(req.body && req.body.name);
    validateMediaRequest(name, req.body && req.body.mime);
    const session = await uploadStore.init({
      md5,
      name,
      size: Number(req.body && req.body.size),
    });
    if (session.published) {
      return res.json({ media: indexUploadedMedia(session.published), instant: true });
    }
    return res.json(session);
  } catch (error) {
    return next(error);
  }
});

app.put('/api/media/upload/:id/chunk', async (req, res, next) => {
  try {
    const result = await uploadStore.append({
      uploadId: req.params.id,
      offset: Number(req.get('X-Upload-Offset')),
      contentLength: Number(req.get('Content-Length')),
      body: req,
    });
    return res.json(result);
  } catch (error) {
    req.resume();
    return next(error);
  }
});

app.post('/api/media/upload/:id/complete', async (req, res, next) => {
  try {
    const existing = mediaIndex.get(String(req.params.id || '').toLowerCase());
    if (existing) return res.json({ media: existing, instant: false });
    const completed = await uploadStore.complete(req.params.id);
    return res.json({ media: indexUploadedMedia(completed), instant: false });
  } catch (error) {
    return next(error);
  }
});

app.use(express.static(path.join(ROOT, 'public')));
app.use((error, req, res, next) => {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  if (res.headersSent) return next(error);
  const message = status >= 500 ? '服务器处理失败' : error.message || '请求失败';
  const body = { error: message, code: error.code || 'REQUEST_FAILED' };
  if (Number.isSafeInteger(error.offset)) body.offset = error.offset;
  return res.status(status).json(body);
});

function snapshot(room, selfId) {
  return {
    code: room.code,
    selfId,
    users: [...room.users.values()].map(({ id, nickname }) => ({ id, nickname })),
    playlist: room.playlist,
    messages: room.messages,
    playback: playbackSnapshot(room),
  };
}

function emitSystem(room, text) {
  const message = systemMessage(room, text);
  io.to(room.code).emit('message:new', message);
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  const room = code && rooms.get(code);
  if (!room) return;
  const user = room.users.get(socket.id);
  if (!user) return;
  room.users.delete(socket.id);
  room.voice.delete(socket.id);
  socket.data.roomCode = null;
  socket.leave(code);
  socket.to(code).emit('voice:left', { id: socket.id });
  if (!room.users.size) {
    rooms.delete(code);
    return;
  }
  emitSystem(room, `${user.nickname} 离开了房间`);
  io.to(code).emit('room:users', [...room.users.values()]);
}

function member(socket) {
  const room = rooms.get(socket.data.roomCode);
  const user = room && room.users.get(socket.id);
  if (!room || !user) throw new Error('你已不在房间中，请重新加入');
  return { room, user };
}

function socketHandler(socket, event, handler) {
  socket.on(event, async (payload, ack) => {
    try {
      await handler(payload, typeof ack === 'function' ? ack : () => {});
    } catch (error) {
      const message = error.message || '操作失败';
      if (typeof ack === 'function') ack({ ok: false, error: message });
      else socket.emit('error:message', message);
    }
  });
}

io.on('connection', (socket) => {
  socketHandler(socket, 'room:create', (payload, ack) => {
    if (socket.data.roomCode) throw new Error('你已经在房间中');
    const nickname = cleanNickname(payload && payload.nickname);
    const code = createCode(new Set(rooms.keys()));
    const room = {
      code,
      users: new Map(),
      playlist: [],
      messages: [],
      voice: new Set(),
      playback: { mediaId: null, currentTime: 0, paused: true, updatedAt: Date.now() },
    };
    rooms.set(code, room);
    room.users.set(socket.id, { id: socket.id, nickname });
    systemMessage(room, `${nickname} 创建了房间`);
    socket.data.roomCode = code;
    socket.join(code);
    ack({ ok: true, snapshot: snapshot(room, socket.id) });
  });

  socketHandler(socket, 'room:join', (payload, ack) => {
    if (socket.data.roomCode) throw new Error('你已经在房间中');
    const code = String(payload && payload.code || '').trim().toUpperCase();
    const nickname = cleanNickname(payload && payload.nickname);
    const room = rooms.get(code);
    if (!room) throw new Error('房间不存在或已解散');
    if (room.users.size >= 2) throw new Error('这个房间已有两位成员');
    room.users.set(socket.id, { id: socket.id, nickname });
    const message = systemMessage(room, `${nickname} 加入了房间`);
    socket.data.roomCode = code;
    socket.join(code);
    ack({ ok: true, snapshot: snapshot(room, socket.id) });
    socket.to(code).emit('message:new', message);
    socket.to(code).emit('room:users', [...room.users.values()]);
  });

  socketHandler(socket, 'room:leave', (payload, ack) => {
    leaveRoom(socket);
    ack({ ok: true });
  });

  socketHandler(socket, 'media:add', (payload, ack) => {
    const { room, user } = member(socket);
    const media = mediaIndex.get(String(payload && payload.md5 || '').toLowerCase());
    if (!media) throw new Error('媒体尚未上传完成');
    const existing = room.playlist.find((item) => item.id === media.id);
    if (existing) return ack({ ok: true, duplicate: true, item: existing });
    const item = { ...media, name: cleanFileName(payload.name || media.name), addedBy: user.nickname };
    room.playlist.push(item);
    io.to(room.code).emit('playlist:state', room.playlist);
    emitSystem(room, `${user.nickname} 添加了《${item.name}》`);
    if (!room.playback.mediaId) {
      room.playback = { mediaId: item.id, currentTime: 0, paused: true, updatedAt: Date.now() };
      io.to(room.code).emit('playback:state', playbackSnapshot(room));
    }
    ack({ ok: true, item });
  });

  socketHandler(socket, 'media:switch', (payload, ack) => {
    const { room, user } = member(socket);
    const item = room.playlist.find((media) => media.id === String(payload && payload.mediaId));
    if (!item) throw new Error('媒体不在播放列表中');
    room.playback = { mediaId: item.id, currentTime: 0, paused: true, updatedAt: Date.now() };
    io.to(room.code).emit('playback:state', playbackSnapshot(room));
    emitSystem(room, `${user.nickname} 切换到了《${item.name}》`);
    ack({ ok: true });
  });

  socketHandler(socket, 'playback:action', (payload, ack) => {
    const { room } = member(socket);
    if (!room.playback.mediaId) throw new Error('请先上传媒体');
    if (!['play', 'pause', 'seek'].includes(payload && payload.type)) throw new Error('无效的播放操作');
    const current = playbackSnapshot(room);
    const requested = Number(payload.currentTime);
    room.playback = {
      ...current,
      currentTime: Number.isFinite(requested) ? Math.max(0, requested) : current.currentTime,
      paused: payload.type === 'seek' ? current.paused : payload.type === 'pause',
      updatedAt: Date.now(),
      actorId: socket.id,
    };
    io.to(room.code).emit('playback:state', playbackSnapshot(room));
    ack({ ok: true });
  });

  socketHandler(socket, 'chat:send', (payload, ack) => {
    const { room, user } = member(socket);
    const text = String(payload && payload.text || '').trim();
    if (!text) return ack({ ok: true });
    if ([...text].length > 1000) throw new Error('单条消息不能超过 1000 个字符');
    const message = appendMessage(room, {
      kind: 'user', userId: socket.id, nickname: user.nickname, text,
    });
    io.to(room.code).emit('message:new', message);
    ack({ ok: true });
  });

  socketHandler(socket, 'voice:join', (payload, ack) => {
    const { room, user } = member(socket);
    const peers = [...room.voice].filter((id) => id !== socket.id);
    room.voice.add(socket.id);
    ack({ ok: true, peers });
    socket.to(room.code).emit('voice:peer-joined', { id: socket.id, nickname: user.nickname });
  });

  socketHandler(socket, 'voice:signal', (payload) => {
    const { room } = member(socket);
    const target = String(payload && payload.to || '');
    if (!room.voice.has(socket.id) || !room.voice.has(target)) return;
    io.to(target).emit('voice:signal', { from: socket.id, data: payload.data });
  });

  socketHandler(socket, 'voice:leave', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.voice.delete(socket.id)) return;
    socket.to(room.code).emit('voice:left', { id: socket.id });
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

function cleanupUploadSessions() {
  uploadStore.cleanup(UPLOAD_SESSION_TTL).catch((error) => console.error('清理过期上传失败', error));
}
cleanupUploadSessions();
setInterval(cleanupUploadSessions, 60 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`一起看已启动：http://localhost:${PORT}`);
});
