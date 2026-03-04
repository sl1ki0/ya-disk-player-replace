/* ================================================================
   Ya-Disk-Player – app.js
   YouTube-like player with hls.js + keyboard shortcuts
   ================================================================ */

'use strict';

/* ----------------------------------------------------------------
   DOM references
---------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

// Landing
const landingEl      = $('landing');
const urlForm        = $('url-form');
const urlInput       = $('url-input');
const urlErrorEl     = $('url-error');
const urlSubmitBtn   = urlForm.querySelector('.url-submit-btn');
const btnLabel       = urlSubmitBtn.querySelector('.btn-label');
const btnSpinner     = urlSubmitBtn.querySelector('.btn-spinner');

// Player page
const playerPage     = $('player-page');
const backBtn        = $('back-btn');
const videoTitleEl   = $('video-title');

// Player core
const playerWrap     = $('player-wrap');
const videoEl        = $('video');
const loadingOverlay = $('loading-overlay');
const playerErrorEl  = $('player-error');
const playerErrorMsg = $('player-error-msg');
const centerFlash    = $('center-flash');
const flashPlay      = $('flash-play');
const flashPause     = $('flash-pause');
const kbdToast       = $('kbd-toast');
const controls       = $('controls');

// Progress
const progressArea   = $('progress-area');
const progressTrack  = $('progress-track');
const progressBuffer = $('progress-buffer');
const progressFill   = $('progress-fill');
const progressThumb  = $('progress-thumb');
const seekTooltip    = $('seek-tooltip');

// Buttons
const btnPlay        = $('btn-play');
const iconPlay       = btnPlay.querySelector('.icon-play');
const iconPause      = btnPlay.querySelector('.icon-pause');
const btnRewind      = $('btn-rewind');
const btnForward     = $('btn-forward');
const btnMute        = $('btn-mute');
const iconVolHigh    = btnMute.querySelector('.icon-vol-high');
const iconVolLow     = btnMute.querySelector('.icon-vol-low');
const iconVolMute    = btnMute.querySelector('.icon-vol-mute');
const volSlider      = $('vol-slider');
const timeCurrent    = $('time-current');
const timeTotal      = $('time-total');
const qualityWrap    = $('quality-wrap');
const btnQuality     = $('btn-quality');
const qualityLabel   = $('quality-label');
const qualityMenu    = $('quality-menu');
const btnSpeed       = $('btn-speed');
const speedLabel     = $('speed-label');
const speedMenu      = $('speed-menu');
const btnFullscreen  = $('btn-fullscreen');
const iconFs         = btnFullscreen.querySelector('.icon-fullscreen');
const iconExitFs     = btnFullscreen.querySelector('.icon-exit-fullscreen');

/* ----------------------------------------------------------------
   State
---------------------------------------------------------------- */
let hls = null;
let hlsNetworkRetries = 0;
const HLS_MAX_NETWORK_RETRIES = 3;
let isSeeking = false;
let hideControlsTimer = null;
let toastTimer = null;
let flashTimer = null;
let loadingTimer = null;
let previousVolume = 1;
let currentLevelIndex = -1; // -1 = auto

/* ----------------------------------------------------------------
   Helpers
---------------------------------------------------------------- */
function formatTime(sec) {
  if (isNaN(sec) || !isFinite(sec)) return '0:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function showError(msg) {
  urlErrorEl.textContent = msg;
  urlErrorEl.classList.remove('hidden');
}

function hideError() {
  urlErrorEl.classList.add('hidden');
}

/** Show an error overlay on the player page itself. */
function showPlayerError(msg) {
  console.error('[player] error:', msg);
  clearTimeout(loadingTimer);
  loadingOverlay.classList.add('hidden');
  playerErrorMsg.textContent = msg;
  playerErrorEl.classList.remove('hidden');
}

function hidePlayerError() {
  playerErrorEl.classList.add('hidden');
  playerErrorMsg.textContent = '';
}

function setLoading(on) {
  if (on) {
    urlSubmitBtn.disabled = true;
    btnLabel.classList.add('hidden');
    btnSpinner.classList.remove('hidden');
  } else {
    urlSubmitBtn.disabled = false;
    btnLabel.classList.remove('hidden');
    btnSpinner.classList.add('hidden');
  }
}

/* ----------------------------------------------------------------
   Toast notification
---------------------------------------------------------------- */
function showToast(msg) {
  clearTimeout(toastTimer);
  kbdToast.textContent = msg;
  kbdToast.classList.remove('hidden', 'visible');
  // Force reflow for re-animation
  void kbdToast.offsetWidth;
  kbdToast.classList.add('visible');
  toastTimer = setTimeout(() => {
    kbdToast.classList.remove('visible');
    setTimeout(() => kbdToast.classList.add('hidden'), 300);
  }, 1500);
}

/* ----------------------------------------------------------------
   Center play/pause flash
---------------------------------------------------------------- */
function showFlash(isPlay) {
  clearTimeout(flashTimer);
  flashPlay.style.display  = isPlay ? '' : 'none';
  flashPause.style.display = isPlay ? 'none' : '';
  centerFlash.classList.remove('hidden', 'visible');
  void centerFlash.offsetWidth;
  centerFlash.classList.add('visible');
  flashTimer = setTimeout(() => centerFlash.classList.add('hidden'), 700);
}

/* ----------------------------------------------------------------
   Controls visibility
---------------------------------------------------------------- */
function showControls() {
  playerWrap.classList.add('controls-visible');
  clearTimeout(hideControlsTimer);
  if (!videoEl.paused) {
    hideControlsTimer = setTimeout(() => {
      playerWrap.classList.remove('controls-visible');
    }, 3000);
  }
}

function updatePausedClass() {
  if (videoEl.paused) {
    playerWrap.classList.add('paused');
  } else {
    playerWrap.classList.remove('paused');
  }
}

/* ----------------------------------------------------------------
   Play / Pause
---------------------------------------------------------------- */
function togglePlay() {
  if (videoEl.paused) {
    videoEl.play().catch(() => {});
    showFlash(true);
  } else {
    videoEl.pause();
    showFlash(false);
  }
}

function updatePlayButton() {
  if (videoEl.paused) {
    iconPlay.classList.remove('hidden');
    iconPause.classList.add('hidden');
    btnPlay.setAttribute('aria-label', 'Play');
  } else {
    iconPlay.classList.add('hidden');
    iconPause.classList.remove('hidden');
    btnPlay.setAttribute('aria-label', 'Pause');
  }
  updatePausedClass();
}

/* ----------------------------------------------------------------
   Volume
---------------------------------------------------------------- */
function updateVolumeUI() {
  const v = videoEl.volume;
  const muted = videoEl.muted || v === 0;
  iconVolHigh.classList.toggle('hidden', muted || v <= 0.5);
  iconVolLow.classList.toggle('hidden',  muted || v > 0.5);
  iconVolMute.classList.toggle('hidden', !muted);
  volSlider.value = muted ? 0 : v;
  btnMute.setAttribute('aria-label', muted ? 'Включить звук' : 'Выключить звук');
}

function setVolume(val) {
  val = Math.max(0, Math.min(1, val));
  videoEl.volume = val;
  if (val > 0) videoEl.muted = false;
  updateVolumeUI();
}

function toggleMute() {
  if (videoEl.muted || videoEl.volume === 0) {
    videoEl.muted = false;
    if (videoEl.volume === 0) videoEl.volume = previousVolume || 0.5;
    showToast('Звук включён');
  } else {
    previousVolume = videoEl.volume;
    videoEl.muted = true;
    showToast('Звук выключен');
  }
  updateVolumeUI();
}

/* ----------------------------------------------------------------
   Seek / progress bar
---------------------------------------------------------------- */
function getTrackFraction(event) {
  const rect = progressTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
}

function updateProgress() {
  if (!videoEl.duration || isSeeking) return;
  const frac = videoEl.currentTime / videoEl.duration;
  progressFill.style.width  = frac * 100 + '%';
  progressThumb.style.left  = frac * 100 + '%';
  timeCurrent.textContent   = formatTime(videoEl.currentTime);
  progressArea.setAttribute('aria-valuenow', Math.round(frac * 100));
}

function updateBuffer() {
  if (!videoEl.duration) return;
  const buf = videoEl.buffered;
  if (buf.length) {
    const end = buf.end(buf.length - 1);
    progressBuffer.style.width = (end / videoEl.duration) * 100 + '%';
  }
}

function seekTo(frac) {
  if (!videoEl.duration) return;
  videoEl.currentTime = frac * videoEl.duration;
  updateProgress();
}

/* ----------------------------------------------------------------
   Seek-bar interactions
---------------------------------------------------------------- */
function onProgressPointerDown(e) {
  if (e.button !== 0) return;
  isSeeking = true;
  progressArea.setPointerCapture(e.pointerId);
  seekTo(getTrackFraction(e));
}

function onProgressPointerMove(e) {
  const frac = getTrackFraction(e);
  const time = videoEl.duration ? formatTime(frac * videoEl.duration) : '0:00';
  const rect  = progressTrack.getBoundingClientRect();
  const xPx   = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
  seekTooltip.textContent  = time;
  seekTooltip.style.left   = xPx + 'px';
  if (isSeeking) seekTo(frac);
}

function onProgressPointerUp(e) {
  if (!isSeeking) return;
  isSeeking = false;
  progressArea.releasePointerCapture(e.pointerId);
  seekTo(getTrackFraction(e));
}

progressArea.addEventListener('pointerdown', onProgressPointerDown);
progressArea.addEventListener('pointermove', onProgressPointerMove);
progressArea.addEventListener('pointerup',   onProgressPointerUp);

/* ----------------------------------------------------------------
   Speed menu
---------------------------------------------------------------- */
function setSpeed(val) {
  videoEl.playbackRate = val;
  speedLabel.textContent = val === 1 ? '1×' : `${val}×`;
  speedMenu.querySelectorAll('li').forEach((li) => {
    li.classList.toggle('selected', parseFloat(li.dataset.speed) === val);
  });
  showToast(`Скорость ${val}×`);
}

speedMenu.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  setSpeed(parseFloat(li.dataset.speed));
  speedMenu.classList.add('hidden');
});

btnSpeed.addEventListener('click', () => {
  speedMenu.classList.toggle('hidden');
  qualityMenu.classList.add('hidden');
});

/* ----------------------------------------------------------------
   Quality menu (HLS levels)
---------------------------------------------------------------- */
function buildQualityMenu(levels) {
  qualityMenu.innerHTML = '';

  const autoLi = document.createElement('li');
  autoLi.textContent = 'Авто';
  autoLi.setAttribute('role', 'option');
  autoLi.dataset.level = '-1';
  autoLi.classList.toggle('selected', currentLevelIndex === -1);
  qualityMenu.appendChild(autoLi);

  levels.forEach((lvl, idx) => {
    const li = document.createElement('li');
    const h = lvl.height || '';
    li.textContent = h ? `${h}p` : `Уровень ${idx}`;
    li.setAttribute('role', 'option');
    li.dataset.level = idx;
    li.classList.toggle('selected', idx === currentLevelIndex);
    qualityMenu.appendChild(li);
  });

  qualityWrap.classList.remove('hidden');
}

qualityMenu.addEventListener('click', (e) => {
  const li = e.target.closest('li');
  if (!li || !hls) return;
  const level = parseInt(li.dataset.level, 10);
  hls.currentLevel = level;
  currentLevelIndex = level;
  qualityLabel.textContent = level === -1 ? 'Auto' : `${hls.levels[level]?.height || level}p`;
  qualityMenu.querySelectorAll('li').forEach((el) => {
    el.classList.toggle('selected', parseInt(el.dataset.level, 10) === level);
  });
  qualityMenu.classList.add('hidden');
  showToast(level === -1 ? 'Качество: Авто' : `Качество: ${qualityLabel.textContent}`);
});

btnQuality.addEventListener('click', () => {
  qualityMenu.classList.toggle('hidden');
  speedMenu.classList.add('hidden');
});

/* ----------------------------------------------------------------
   Fullscreen
---------------------------------------------------------------- */
function toggleFullscreen() {
  const fsEl = playerWrap;
  if (!document.fullscreenElement) {
    (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl);
  } else {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
}

function updateFullscreenUI() {
  const fs = !!document.fullscreenElement;
  iconFs.classList.toggle('hidden', fs);
  iconExitFs.classList.toggle('hidden', !fs);
  btnFullscreen.setAttribute('aria-label', fs ? 'Выйти из полного экрана' : 'На весь экран');
}

document.addEventListener('fullscreenchange', updateFullscreenUI);

/* ----------------------------------------------------------------
   Keyboard shortcuts (YouTube-compatible)
---------------------------------------------------------------- */
document.addEventListener('keydown', (e) => {
  if (playerPage.classList.contains('hidden')) return;
  // Ignore when focus is on interactive element (except the player itself)
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  let handled = true;

  switch (e.code) {
    case 'Space':
    case 'KeyK':
      togglePlay();
      showToast(videoEl.paused ? 'Пауза' : 'Воспроизведение');
      break;

    case 'ArrowLeft':
    case 'KeyJ': {
      const delta = e.shiftKey ? 5 : 10;
      videoEl.currentTime = Math.max(0, videoEl.currentTime - delta);
      showToast(`−${delta} сек`);
      break;
    }

    case 'ArrowRight':
    case 'KeyL': {
      const delta = e.shiftKey ? 5 : 10;
      videoEl.currentTime = Math.min(videoEl.duration || 0, videoEl.currentTime + delta);
      showToast(`+${delta} сек`);
      break;
    }

    case 'ArrowUp':
      setVolume(videoEl.volume + 0.05);
      showToast(`Громкость ${Math.round(videoEl.volume * 100)}%`);
      break;

    case 'ArrowDown':
      setVolume(videoEl.volume - 0.05);
      showToast(`Громкость ${Math.round(videoEl.volume * 100)}%`);
      break;

    case 'KeyM':
      toggleMute();
      break;

    case 'KeyF':
      toggleFullscreen();
      break;

    case 'Home':
      videoEl.currentTime = 0;
      showToast('Начало');
      break;

    case 'End':
      if (videoEl.duration) videoEl.currentTime = videoEl.duration;
      showToast('Конец');
      break;

    case 'Digit0': case 'Numpad0':
      if (!e.shiftKey) { videoEl.currentTime = 0; showToast('0%'); }
      else handled = false;
      break;
    case 'Digit1': case 'Numpad1':
      videoEl.currentTime = (videoEl.duration || 0) * 0.1; showToast('10%'); break;
    case 'Digit2': case 'Numpad2':
      videoEl.currentTime = (videoEl.duration || 0) * 0.2; showToast('20%'); break;
    case 'Digit3': case 'Numpad3':
      videoEl.currentTime = (videoEl.duration || 0) * 0.3; showToast('30%'); break;
    case 'Digit4': case 'Numpad4':
      videoEl.currentTime = (videoEl.duration || 0) * 0.4; showToast('40%'); break;
    case 'Digit5': case 'Numpad5':
      videoEl.currentTime = (videoEl.duration || 0) * 0.5; showToast('50%'); break;
    case 'Digit6': case 'Numpad6':
      videoEl.currentTime = (videoEl.duration || 0) * 0.6; showToast('60%'); break;
    case 'Digit7': case 'Numpad7':
      videoEl.currentTime = (videoEl.duration || 0) * 0.7; showToast('70%'); break;
    case 'Digit8': case 'Numpad8':
      videoEl.currentTime = (videoEl.duration || 0) * 0.8; showToast('80%'); break;
    case 'Digit9': case 'Numpad9':
      videoEl.currentTime = (videoEl.duration || 0) * 0.9; showToast('90%'); break;

    default:
      handled = false;
  }

  if (handled) {
    e.preventDefault();
    showControls();
  }
});

/* ----------------------------------------------------------------
   Loading timeout – surface silent failures after 30 s
---------------------------------------------------------------- */
function startLoadingTimeout() {
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    // If video hasn't reached HAVE_FUTURE_DATA yet, it's still stuck
    if (videoEl.readyState < 3) {
      showPlayerError(
        'Видео не удаётся загрузить. Проверьте логи сервера или попробуйте снова.',
      );
    }
  }, 30_000);
}

/* ----------------------------------------------------------------
   Video events
---------------------------------------------------------------- */
videoEl.addEventListener('play',       updatePlayButton);
videoEl.addEventListener('pause',      () => { updatePlayButton(); showControls(); });
videoEl.addEventListener('ended',      updatePlayButton);
videoEl.addEventListener('timeupdate', updateProgress);
videoEl.addEventListener('progress',   updateBuffer);
videoEl.addEventListener('volumechange', updateVolumeUI);

videoEl.addEventListener('waiting',  () => {
  console.log('[video] waiting…');
  loadingOverlay.classList.remove('hidden');
});
videoEl.addEventListener('playing',  () => {
  console.log('[video] playing');
  clearTimeout(loadingTimer);
  loadingOverlay.classList.add('hidden');
  hidePlayerError();
});
videoEl.addEventListener('canplay',  () => {
  console.log('[video] canplay – readyState:', videoEl.readyState);
  loadingOverlay.classList.add('hidden');
});

videoEl.addEventListener('error', () => {
  const err = videoEl.error;
  const msg = err
    ? `Ошибка видео (код ${err.code}): ${err.message}`
    : 'Неизвестная ошибка загрузки видео.';
  console.error('[video] error event:', msg);
  showPlayerError(msg);
});

videoEl.addEventListener('durationchange', () => {
  console.log('[video] duration:', videoEl.duration);
  timeTotal.textContent = formatTime(videoEl.duration);
});

videoEl.addEventListener('click', () => {
  togglePlay();
  showControls();
});

/* ----------------------------------------------------------------
   Control bar interactions
---------------------------------------------------------------- */
btnPlay.addEventListener('click',       () => { togglePlay(); showControls(); });
btnRewind.addEventListener('click',     () => {
  videoEl.currentTime = Math.max(0, videoEl.currentTime - 10);
  showToast('−10 сек');
  showControls();
});
btnForward.addEventListener('click',    () => {
  videoEl.currentTime = Math.min(videoEl.duration || 0, videoEl.currentTime + 10);
  showToast('+10 сек');
  showControls();
});
btnMute.addEventListener('click',       toggleMute);
volSlider.addEventListener('input',     (e) => setVolume(parseFloat(e.target.value)));
btnFullscreen.addEventListener('click', toggleFullscreen);

// Double-click on video = fullscreen
videoEl.addEventListener('dblclick',   toggleFullscreen);

// Mouse move → show controls
playerWrap.addEventListener('mousemove', showControls);
playerWrap.addEventListener('mouseenter', showControls);

// Close menus when clicking outside
document.addEventListener('click', (e) => {
  if (!btnQuality.contains(e.target)) qualityMenu.classList.add('hidden');
  if (!btnSpeed.contains(e.target))   speedMenu.classList.add('hidden');
});

/* ----------------------------------------------------------------
   HLS / player initialisation
---------------------------------------------------------------- */
function destroyPlayer() {
  if (hls) {
    hls.destroy();
    hls = null;
  }
  hlsNetworkRetries = 0;
  videoEl.removeAttribute('src');
  videoEl.load();
  qualityWrap.classList.add('hidden');
  qualityMenu.innerHTML = '';
  currentLevelIndex = -1;
  qualityLabel.textContent = 'Auto';
}

function initHls(manifestUrl) {
  destroyPlayer();
  hidePlayerError();

  if (typeof Hls === 'undefined') {
    showPlayerError(
      'hls.js не загрузился. Обновите страницу или проверьте блокировщики контента.',
    );
    return;
  }

  if (Hls.isSupported()) {
    console.log('[hls] initialising, manifest:', manifestUrl);
    hls = new Hls({
      autoStartLoad: true,
      startLevel: -1, // auto quality
      enableWorker: true,
      lowLatencyMode: false,
    });

    hls.loadSource(manifestUrl);
    hls.attachMedia(videoEl);

    hls.on(Hls.Events.MANIFEST_LOADING, () => {
      console.log('[hls] MANIFEST_LOADING');
    });

    hls.on(Hls.Events.MANIFEST_PARSED, (_evt, data) => {
      console.log('[hls] MANIFEST_PARSED, levels:', data.levels.length);
      buildQualityMenu(data.levels);
      videoEl.play().catch((e) => console.warn('[hls] autoplay rejected:', e.message));
    });

    hls.on(Hls.Events.LEVEL_SWITCHED, (_evt, data) => {
      console.log('[hls] LEVEL_SWITCHED ->', data.level);
      if (currentLevelIndex === -1) {
        const lvl = hls.levels[data.level];
        qualityLabel.textContent = lvl?.height ? `${lvl.height}p` : 'Auto';
      }
    });

    hls.on(Hls.Events.FRAG_LOADING, (_evt, data) => {
      console.log('[hls] FRAG_LOADING sn:', data.frag?.sn, 'url:', data.frag?.url?.substring(0, 80));
    });

    hls.on(Hls.Events.FRAG_LOADED, (_evt, data) => {
      console.log('[hls] FRAG_LOADED sn:', data.frag?.sn);
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      console.error('[hls] ERROR type:', data.type, '| details:', data.details, '| fatal:', data.fatal, '| url:', data.url?.substring(0, 80));
      if (data.fatal) {
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (hlsNetworkRetries < HLS_MAX_NETWORK_RETRIES) {
            hlsNetworkRetries++;
            console.warn(`[hls] fatal network error – retry ${hlsNetworkRetries}/${HLS_MAX_NETWORK_RETRIES}`);
            hls.startLoad();
          } else {
            showPlayerError(
              `Ошибка сети при загрузке потока (${data.details}). ` +
              'Возможно, ссылка устарела — вернитесь и попробуйте снова.',
            );
          }
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          console.warn('[hls] fatal media error – trying to recover');
          hls.recoverMediaError();
        } else {
          showPlayerError(
            `Критическая ошибка HLS (${data.details}). ` +
            'Возможно, ссылка устарела — попробуйте ещё раз.',
          );
        }
      }
    });
  } else if (videoEl.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari native HLS
    console.log('[hls] using native HLS (Safari)');
    videoEl.src = manifestUrl;
    videoEl.play().catch((e) => console.warn('[hls] native autoplay rejected:', e.message));
  } else {
    showPlayerError('Ваш браузер не поддерживает HLS воспроизведение.');
  }
}

function initDirect(videoUrl) {
  destroyPlayer();
  hidePlayerError();
  console.log('[direct] setting src:', videoUrl.substring(0, 100));
  videoEl.src = videoUrl;
  videoEl.play().catch((e) => console.warn('[direct] autoplay rejected:', e.message));
}

/* ----------------------------------------------------------------
   Landing form submit
---------------------------------------------------------------- */
urlForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const diskUrl = urlInput.value.trim();
  if (!diskUrl) return;

  hideError();
  setLoading(true);

  try {
    const resp = await fetch(
      `/api/video-info?url=${encodeURIComponent(diskUrl)}`,
    );
    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || `Сервер вернул ошибку ${resp.status}`);
    }

    // Switch to player view
    landingEl.classList.add('hidden');
    playerPage.classList.remove('hidden');
    videoTitleEl.textContent = data.title || 'Видео';
    hidePlayerError();
    loadingOverlay.classList.remove('hidden');
    startLoadingTimeout();

    console.log('[app] video-info response:', data.type, data.url?.substring(0, 80));

    try {
      if (data.type === 'hls') {
        initHls(data.url);
      } else {
        initDirect(data.url);
      }
    } catch (initErr) {
      showPlayerError(`Ошибка инициализации плеера: ${initErr.message}`);
    }
  } catch (err) {
    showError(err.message || 'Неизвестная ошибка. Проверьте ссылку и попробуйте снова.');
  } finally {
    setLoading(false);
  }
});

/* ----------------------------------------------------------------
   Back button
---------------------------------------------------------------- */
backBtn.addEventListener('click', () => {
  clearTimeout(loadingTimer);
  destroyPlayer();
  videoEl.pause();
  loadingOverlay.classList.add('hidden');
  hidePlayerError();
  playerPage.classList.add('hidden');
  landingEl.classList.remove('hidden');
  hideError();
  urlInput.focus();
});
