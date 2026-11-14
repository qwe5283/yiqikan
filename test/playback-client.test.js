const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const playbackSource = source.slice(
  source.indexOf('  function serverPosition()'),
  source.indexOf('  function updatePlayButton()'),
) + source.slice(
  source.indexOf('  function syncPlayer('),
  source.indexOf("  $('playButton').addEventListener"),
);

function createPlaybackHarness() {
  const media = { id: 'movie', kind: 'video', name: '测试影片', url: '/media/movie.mp4' };
  const clock = { wall: 20_000, monotonic: 5_000 };
  const seeks = [];
  const requests = [];
  const state = {
    selfId: 'browser-a',
    currentMediaId: media.id,
    playlist: [media],
    playback: { mediaId: media.id, currentTime: 0, paused: true, updatedAt: clock.wall },
    lastControlAt: 0,
    seeking: false,
  };
  const player = {
    readyState: 4,
    duration: 300,
    currentTime: 0,
    paused: true,
    ended: false,
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
  };
  const elements = new Map();
  const context = vm.createContext({
    state,
    Date: { now: () => clock.wall },
    performance: { now: () => clock.monotonic },
    currentMedia: () => state.playlist.find((item) => item.id === state.playback?.mediaId),
    renderPlaylist() {},
    updateMediaStage() {},
    updateTimeline() {},
    toast(message) { throw new Error(message); },
    async emitAck(event, payload) { requests.push({ event, payload }); return { ok: true }; },
    $: (id) => {
      if (id === 'player') return player;
      if (!elements.has(id)) elements.set(id, { hidden: false });
      return elements.get(id);
    },
  });
  vm.runInContext(`${playbackSource}\nglobalThis.playbackApi = { serverPosition, syncPlayer, applyPlayback, playbackAction };`, context);
  return { api: context.playbackApi, state, player, clock, seeks, requests };
}

test('客户端时钟落后服务端时，远端播放状态不会造成进度回退', () => {
  const harness = createPlaybackHarness();
  const { api, player, clock } = harness;
  player.currentTime = 95.884674;
  player.paused = false;

  api.applyPlayback({
    mediaId: 'movie', currentTime: 95.884674, paused: false,
    updatedAt: 21_650, actorId: 'browser-b',
  });
  clock.wall += 1_600;
  clock.monotonic += 1_600;
  player.currentTime = 97.471827;
  api.syncPlayer();

  assert.equal(player.currentTime, 97.471827);
  assert.equal(api.serverPosition(), 97.484674);
});

test('延迟到达的本人播放回包不会覆盖本地已推进的位置', async () => {
  const harness = createPlaybackHarness();
  const { api, player, clock, requests } = harness;
  await api.playbackAction('play', 0);
  assert.equal(requests[0].event, 'playback:action');

  clock.wall += 1_600;
  clock.monotonic += 1_600;
  player.currentTime = 1.587153;
  api.applyPlayback({
    mediaId: 'movie', currentTime: 0, paused: false,
    updatedAt: 21_650, actorId: 'browser-a',
  });

  assert.equal(player.currentTime, 1.587153);
  assert.equal(api.serverPosition(), 1.6);
});
