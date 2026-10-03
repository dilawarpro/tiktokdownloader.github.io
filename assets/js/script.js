/* ============================================================
   STATE
============================================================ */
const S = {
    videoUrl: null,
    audioUrl: null,
    images: [],
    caption: '',
    theme: localStorage.getItem('tt-theme') || 'dark',
    pwaPrompt: null,
    progressTimer: null,
    fetchTimer: null,
    copyCount: 0,
    userRating: 0,
    history: JSON.parse(localStorage.getItem('tt-history') || '[]'),
    currentData: null
};

/* ============================================================
   URL HELPERS (TikWM can return relative or http:// links)
============================================================ */
const TIKWM_HOST = 'https://www.tikwm.com';

function resolveTikwmUrl(u) {
    if (!u || typeof u !== 'string') return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith('//')) return 'https:' + u;
    if (u.startsWith('/')) return TIKWM_HOST + u;
    return u;
}
function forceHttps(u) { return u ? u.replace(/^http:\/\//i, 'https://') : u; }
function cleanMediaUrl(u) { return forceHttps(resolveTikwmUrl(u)); }
function coerceMediaUrl(value) {
    if (!value) return null;
    if (typeof value === 'string') return cleanMediaUrl(value);
    if (typeof value === 'object') {
        const candidates = [value.url, value.src, value.play, value.play_url, value.download_url, value.link, value.href];
        for (const candidate of candidates) {
            const result = coerceMediaUrl(candidate);
            if (result) return result;
        }
        return null;
    }
    return null;
}

/* HD first — used by the Download button */
function videoCandidates(data) {
    return [data.hdplay, data.play, data.wmplay].map(coerceMediaUrl).filter((u, i, all) => u && all.indexOf(u) === i);
}
/* Smallest first — used by the on-page preview so playback starts sooner */
function previewVideoCandidates(data) {
    return [data.play, data.wmplay, data.hdplay].map(coerceMediaUrl).filter((u, i, all) => u && all.indexOf(u) === i);
}

function preconnectTo(url) {
    try {
        const origin = new URL(url).origin;
        if (document.querySelector(`link[rel="preconnect"][href="${origin}"]`)) return;
        const link = document.createElement('link');
        link.rel = 'preconnect';
        link.href = origin;
        link.crossOrigin = 'anonymous';
        document.head.appendChild(link);
    } catch (e) { /* ignore invalid URLs */ }
}

function setPosterWithFallback(videoEl, data) {
    const candidates = [data.cover, data.origin_cover, data.ai_dynamic_cover, data.dynamic_cover]
        .map(cleanMediaUrl).filter((u, i, all) => u && all.indexOf(u) === i);
    if (!candidates.length) return;
    preconnectTo(candidates[0]);
    videoEl.poster = candidates[0];            // show the thumbnail immediately
    let i = 0;
    (function check() {                        // if it fails to load, swap to the next cover
        const probe = new Image();
        probe.onerror = () => {
            i++;
            if (i < candidates.length) { videoEl.poster = candidates[i]; check(); }
        };
        probe.src = candidates[i];
    })();
}

/* ============================================================
   FILE NAMING: "<title> - downloaded by tiktokvideodownload.app.ext"
============================================================ */
const SITE_DOMAIN = 'tiktokvideodownload.app';

function randomName() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return 'TikTok-' + id;
}

function makeFilename(ext, index) {
    let t = (S.caption || (S.currentData && S.currentData.title) || '');
    t = t
        .replace(/#\S+/g, '')                    // drop hashtags (delete this line to keep them)
        .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')    // characters illegal in file names
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
        .trim();
    if (!t) t = S.randomName || (S.randomName = randomName());   // no title -> random name (same for every file of this video)
    const label = ext === 'mp4' ? 'video downloaded by' : 'downloaded by';
    const num = index ? ` (${index})` : '';
    return `${t} - ${label} ${SITE_DOMAIN}${num}.${ext}`;
}

/* ============================================================
   LOADERS
============================================================ */
let _ttLoaderId = 0;
function loaderMarkup(compact) {
    const id = 'ttGrad' + (++_ttLoaderId);   // unique gradient id per loader instance
    return `
    <div class="tt-loader${compact ? ' sm' : ''}" aria-hidden="true">
        <div class="tt-stage">
            <span class="tt-glow"></span>
            <span class="tt-orb"><i></i><i></i></span>
            <svg class="tt-svg" viewBox="0 0 100 100">
                <defs>
                    <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
                        <stop offset="0%" stop-color="#00D4FF"/>
                        <stop offset="50%" stop-color="#6C3EF4"/>
                        <stop offset="100%" stop-color="#FF2D78"/>
                    </linearGradient>
                </defs>
                <circle class="tt-track-c" cx="50" cy="50" r="44"/>
                <circle class="tt-arc" cx="50" cy="50" r="44" stroke="url(#${id})"/>
            </svg>
            <span class="tt-logo">
                <i class="bi bi-tiktok c1"></i><i class="bi bi-tiktok c2"></i><i class="bi bi-tiktok c3"></i>
            </span>
        </div>
        <div class="tt-tips">
            <span>Finding your video…</span>
            <span>Removing the watermark…</span>
            <span>Grabbing audio &amp; caption…</span>
        </div>
    </div>`;
}

function setVideoLoadingHint(videoWrap, show) {
    let hint = videoWrap.querySelector('.vw-loading-hint');
    if (show && !hint) {
        hint = document.createElement('div');
        hint.className = 'vw-loading-hint';
        hint.innerHTML = loaderMarkup(true) + '<span>Loading preview…</span>';
        if (getComputedStyle(videoWrap).position === 'static') videoWrap.style.position = 'relative';
        videoWrap.appendChild(hint);
    } else if (!show && hint) {
        hint.remove();
    }
}

/* Simple, fast preview: play the first working source, fall through on error */
function playVideoFast(videoEl, videoWrap, candidates, onAllFailed) {
    if (videoEl.dataset.blobUrl) { URL.revokeObjectURL(videoEl.dataset.blobUrl); delete videoEl.dataset.blobUrl; }
    candidates.forEach(preconnectTo);
    setVideoLoadingHint(videoWrap, true);
    let i = 0;
    videoEl.preload = 'auto';
    videoEl.onloadeddata = () => { setVideoLoadingHint(videoWrap, false); videoEl.onerror = null; videoEl.play().catch(() => {}); };
    videoEl.onerror = () => {
        i++;
        if (i < candidates.length) { videoEl.src = candidates[i]; videoEl.load(); }
        else { setVideoLoadingHint(videoWrap, false); videoEl.onerror = null; onAllFailed(); }
    };
    videoEl.src = candidates[0];
    videoEl.load();
}

/* Thumbnail first, full video only when the user taps play */
function setupLazyPreview(videoEl, videoWrap, candidates, onAllFailed) {
    const old = videoWrap.querySelector('.vw-play');
    if (old) old.remove();
    candidates.forEach(preconnectTo);
    videoEl.controls = false;
    videoEl.preload = 'none';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vw-play';
    btn.setAttribute('aria-label', 'Play video preview');
    btn.innerHTML = '<span class="vw-play-ico"><i class="bi bi-play-fill"></i></span><span class="vw-play-txt">Tap to preview video</span>';
    btn.addEventListener('click', () => {
        btn.remove();
        videoEl.controls = true;
        playVideoFast(videoEl, videoWrap, candidates, onAllFailed);
    });
    if (getComputedStyle(videoWrap).position === 'static') videoWrap.style.position = 'relative';
    videoWrap.appendChild(btn);
}

/* ============================================================
   AUTO THEME SYSTEM
============================================================ */
const AutoTheme = (() => {
    const CFG = {
        dayStart: 6, nightStart: 20,
        manualKey: 'tt-theme-manual',
        manualExpiryKey: 'tt-theme-manual-expiry',
        manualDuration: 6 * 60 * 60 * 1000,
        checkInterval: 60 * 1000
    };
    let _timer = null, _mq = null, _lastAuto = null;

    function _hour() { return new Date().getHours(); }
    function _timeTheme() { const h = _hour(); return (h >= CFG.dayStart && h < CFG.nightStart) ? 'light' : 'dark'; }
    function _sysTheme() {
        if (!window.matchMedia) return null;
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
        if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
        return null;
    }
    function _autoTheme() { return _sysTheme() || _timeTheme(); }
    function _isManual() {
        const m = localStorage.getItem(CFG.manualKey);
        const e = localStorage.getItem(CFG.manualExpiryKey);
        if (!m || !e) return false;
        if (Date.now() > parseInt(e)) {
            localStorage.removeItem(CFG.manualKey);
            localStorage.removeItem(CFG.manualExpiryKey);
            return false;
        }
        return true;
    }
    function _apply(theme, src) {
        const cur = document.documentElement.getAttribute('data-theme');
        if (cur === theme) return;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('tt-theme', theme);
        S.theme = theme;
        const e = document.getElementById('ttEmoji');
        if (e) e.textContent = theme === 'dark' ? '🌙' : '☀️';
        if (src === 'auto-switch') {
            showToast(theme === 'dark' ? '🌙 Dark Mode' : '☀️ Light Mode',
                theme === 'dark' ? 'Switched automatically. Good evening!' : 'Switched automatically. Good morning!', 'info');
        }
    }
    function _check(src) {
        if (_isManual()) return;
        const a = _autoTheme();
        if (a !== _lastAuto) { _lastAuto = a; _apply(a, src); }
    }
    return {
        init() {
            if (_isManual()) {
                _apply(localStorage.getItem(CFG.manualKey), 'manual-restore');
            } else {
                const a = _autoTheme();
                _lastAuto = a; _apply(a, 'auto-init');
            }
            if (window.matchMedia) {
                _mq = window.matchMedia('(prefers-color-scheme: dark)');
                const handler = () => { if (!_isManual()) { const a = _autoTheme(); _lastAuto = a; _apply(a, 'system'); } };
                _mq.addEventListener ? _mq.addEventListener('change', handler) : _mq.addListener(handler);
            }
            _timer = setInterval(() => _check('auto-switch'), CFG.checkInterval);
        },
        onManual(theme) {
            localStorage.setItem(CFG.manualKey, theme);
            localStorage.setItem(CFG.manualExpiryKey, (Date.now() + CFG.manualDuration).toString());
            _apply(theme, 'manual');
            showToast(`${theme === 'dark' ? '🌙' : '☀️'} ${theme === 'dark' ? 'Dark' : 'Light'} Mode`,
                'Preference saved for 6 hours. Auto mode resumes after.', 'success');
        },
        getStatus() {
            return { current: document.documentElement.getAttribute('data-theme'), auto: _autoTheme(), hour: _hour(), isManual: _isManual() };
        }
    };
})();

/* ============================================================
   INIT
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
    AutoTheme.init();
    document.getElementById('footerYear').textContent = new Date().getFullYear();

    const urlInput = document.getElementById('tiktokUrl');
    urlInput.addEventListener('input', onInput);
    urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') fetchTikTok(); });
    syncCaptionLayout();
    window.addEventListener('resize', syncCaptionLayout);

    document.querySelectorAll('.faq-q').forEach(q => {
        q.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFaq(q); } });
    });
    document.getElementById('themeToggle').addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleTheme(); }
    });

    window.addEventListener('scroll', () => {
        document.getElementById('mainNav').classList.toggle('scrolled', window.scrollY > 40);
        document.getElementById('scrollTopBtn').classList.toggle('show', window.scrollY > 400);
    }, { passive: true });

    document.querySelectorAll('a[href^="#"]').forEach(a => {
        a.addEventListener('click', e => {
            const href = a.getAttribute('href');
            if (!href || href === '#') return;
            const t = document.querySelector(href);
            if (t) { e.preventDefault(); t.scrollIntoView(); }
        });
    });

    document.getElementById('hamburgerBtn').addEventListener('click', () => {
        const nl = document.getElementById('navLinks');
        const open = nl.classList.toggle('open');
        document.getElementById('hamburgerBtn').setAttribute('aria-expanded', open);
    });

    document.querySelectorAll('.star-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => {
            const val = parseInt(btn.dataset.star);
            document.querySelectorAll('.star-btn').forEach(s => {
                s.classList.toggle('hover', parseInt(s.dataset.star) <= val);
            });
        });
        btn.addEventListener('mouseleave', () => {
            document.querySelectorAll('.star-btn').forEach(s => s.classList.remove('hover'));
            updateStars(S.userRating);
        });
    });

    initStats();
    renderHistory();

    window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.pwaPrompt = e; });

    console.log('%c🎵 TikTok Downloader · tiktokvideodownload.app · by Dilawar Pro', 'background:#6C3EF4;color:#fff;padding:8px 18px;border-radius:8px;font-weight:700;');
    window.AutoTheme = AutoTheme;
});

function syncCaptionLayout() {
    const caption = document.getElementById('captionCard');
    const previewColumn = document.getElementById('mp3');
    const captionsColumn = document.getElementById('captions');
    if (!caption || !previewColumn || !captionsColumn) return;
    if (window.innerWidth <= 991) previewColumn.appendChild(caption);
    else captionsColumn.appendChild(caption);
}

/* ============================================================
   THEME / ANNOUNCE BAR / PWA
============================================================ */
function toggleTheme() {
    const cur = document.documentElement.getAttribute('data-theme');
    AutoTheme.onManual(cur === 'dark' ? 'light' : 'dark');
}

function closeAnnounceBar() {
    const bar = document.getElementById('announceBar');
    bar.style.maxHeight = bar.offsetHeight + 'px';
    bar.style.overflow = 'hidden';
    bar.style.transition = 'max-height 0.4s ease, padding 0.4s ease, opacity 0.3s ease';
    requestAnimationFrame(() => {
        bar.style.maxHeight = '0';
        bar.style.padding = '0';
        bar.style.opacity = '0';
    });
    setTimeout(() => bar.remove(), 400);
}

function handleInstall() {
    if (S.pwaPrompt) {
        S.pwaPrompt.prompt();
        S.pwaPrompt.userChoice.then(r => {
            if (r.outcome === 'accepted') showToast('Installed!', 'TikTok Downloader added to your home screen.', 'success');
            S.pwaPrompt = null;
        });
    } else {
        showToast('Install TikTok Downloader', 'Tap your browser menu → "Add to Home Screen" to install.', 'info');
    }
}

/* ============================================================
   INPUT
============================================================ */
function onInput() {
    const val = this.value.trim();
    document.getElementById('clearBtn').style.display = val ? 'flex' : 'none';
    document.querySelector('.btn-paste').style.display = val ? 'none' : 'flex';
    if (!val) { this.className = 'url-input'; return; }
    const ok = val.includes('tiktok.com') || val.includes('vm.tiktok.com') || val.includes('vt.tiktok.com');
    this.className = 'url-input ' + (ok ? 'valid' : 'invalid');
}

function clearInput() {
    const el = document.getElementById('tiktokUrl');
    el.value = ''; el.className = 'url-input';
    document.getElementById('clearBtn').style.display = 'none';
    document.querySelector('.btn-paste').style.display = 'flex';
    el.focus();
}

async function pasteURL() {
    try {
        const text = await navigator.clipboard.readText();
        if (text) {
            document.getElementById('tiktokUrl').value = text;
            document.getElementById('tiktokUrl').dispatchEvent(new Event('input'));
            showToast('Pasted!', text.includes('tiktok') ? 'TikTok URL pasted.' : 'Content pasted. Please verify the URL.', 'success');
        } else {
            showToast('Empty Clipboard', 'Nothing in clipboard.', 'error');
        }
    } catch {
        showToast('Permission Denied', 'Allow clipboard access or paste manually (Ctrl+V).', 'error');
    }
}

function setExample(type) {
    const urls = {
        video: 'https://www.tiktok.com/@mucaash4q/video/7621241062966742292?is_from_webapp=1&sender_device=pc',
        audio: 'https://www.tiktok.com/@soundscapehits/video/7639120823592160532?is_from_webapp=1&sender_device=pc&web_id=7631390762047309320'
    };
    document.getElementById('tiktokUrl').value = urls[type];
    document.getElementById('tiktokUrl').dispatchEvent(new Event('input'));
    showToast('Example URL Set!', 'Click Download to test the tool.', 'info');
}

function scrollToHistory() { document.getElementById('history-section').scrollIntoView(); }
function scrollToTop() { window.scrollTo(0, 0); }

/* ============================================================
   STATS COUNTER
============================================================ */
function initStats() {
    const obs = new IntersectionObserver(entries => {
        entries.forEach(e => { if (e.isIntersecting) { countUp(e.target); obs.unobserve(e.target); } });
    }, { threshold: 0.5 });
    document.querySelectorAll('[data-target]').forEach(el => obs.observe(el));
}

function countUp(el) {
    const target = parseInt(el.dataset.target);
    const suffix = el.dataset.suffix || '';
    if (!target) { el.textContent = '0' + suffix; return; }
    let cur = 0;
    const step = target / (1800 / 16);
    const t = setInterval(() => {
        cur = Math.min(cur + step, target);
        el.textContent = Math.floor(cur) + suffix;
        if (cur >= target) clearInterval(t);
    }, 16);
}

/* ============================================================
   PROGRESS (eases toward 92% until data arrives)
============================================================ */
function startProgress() {
    const sec = document.getElementById('progressSection');
    if (!sec.querySelector('.tt-loader')) sec.insertAdjacentHTML('afterbegin', loaderMarkup());
    sec.style.display = 'block';
    const fill = document.getElementById('progressFill');
    const lbl = document.getElementById('progressLabel');
    const pct = document.getElementById('progressPct');
    let p = 0;
    clearInterval(S.progressTimer);
    S.progressTimer = setInterval(() => {
        p += (92 - p) * 0.07;
        fill.style.width = p.toFixed(1) + '%';
        pct.textContent = Math.round(p) + '%';
        lbl.textContent = p < 25 ? 'Connecting to servers...'
                        : p < 55 ? 'Fetching video data...'
                        : p < 80 ? 'Extracting caption & media...'
                        : 'Preparing download links...';
    }, 100);
}

function finishProgress() {
    clearInterval(S.progressTimer);
    document.getElementById('progressFill').style.width = '100%';
    document.getElementById('progressLabel').textContent = 'Done!';
    document.getElementById('progressPct').textContent = '100%';
    setTimeout(() => { document.getElementById('progressSection').style.display = 'none'; }, 250);
}

function resetProgress() {
    clearInterval(S.progressTimer);
    document.getElementById('progressSection').style.display = 'none';
}

/* ============================================================
   FAST FETCH: primary + delayed backup race, cache, 15s cap
============================================================ */
const API_CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000;

async function fetchTikwm(url, signal) {
    const r = await fetch(`${TIKWM_HOST}/api/?url=${encodeURIComponent(url)}&hd=1`, { signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.code === 0 && j.data &&
        (j.data.play || j.data.hdplay || (j.data.images && j.data.images.length))) return j.data;
    throw new Error((j && j.msg) || 'No data');
}

async function fetchTikmate(url, signal) {
    if (signal.aborted) throw new Error('aborted');
    const r = await fetch(`https://api.tikmate.app/api/lookup?url=${encodeURIComponent(url)}`, { signal });
    const j = await r.json();
    if (!(j && j.id)) throw new Error('Backup failed');
    return {
        play: `https://tikmate.app/download/${j.token}/${j.id}.mp4`,
        music: j.musicUrl || j.music || j.music_url || null,
        title: j.desc || '',
        author: { nickname: j.author || 'TikTok User' },
        duration: j.duration || 0,
        images: []
    };
}

async function fetchTikTok() {
    const url = document.getElementById('tiktokUrl').value.trim();
    if (!url) { showToast('URL Required', 'Paste a TikTok video URL first.', 'error'); document.getElementById('tiktokUrl').focus(); return; }
    if (!url.includes('tiktok.com')) { showToast('Invalid URL', 'Please enter a valid TikTok URL.', 'error'); return; }

    setLoading(true); hideResult(); startProgress();

    const hit = API_CACHE.get(url);
    if (hit && Date.now() - hit.t < CACHE_TTL) { processData(hit.data, url); return; }

    const ctrl = new AbortController();
    clearTimeout(S.fetchTimer);
    S.fetchTimer = setTimeout(() => ctrl.abort(), 9000);

    try {
        let data;
        try {
            data = await fetchTikwm(url, ctrl.signal);
        } catch (primaryErr) {
            if (ctrl.signal.aborted) throw primaryErr;
            data = await fetchTikmate(url, ctrl.signal);
        }
        clearTimeout(S.fetchTimer);
        ctrl.abort();
        API_CACHE.set(url, { data, t: Date.now() });
        processData(data, url);
    } catch (err) {
        clearTimeout(S.fetchTimer);
        setLoading(false); resetProgress();
        showToast('Failed', 'Could not load this TikTok. Check the URL and try again.', 'error');
    }
}

/* ============================================================
   PROCESS DATA
============================================================ */
function processData(data, originalUrl) {
    S.images = normalizeImages(data.images);
    S.caption = data.title || '';
    const vCandidates = videoCandidates(data);
    const previewCandidates = previewVideoCandidates(data);
    S.videoUrl = vCandidates[0] || null;
    S.videoList = vCandidates;   // HD first, then standard — used as automatic fallbacks
    const mi = data.music_info || {};
    const audioSources = [data.music, mi, data.music_info, data.audio, data.audio_url, data.music_url,
        mi.play, mi.play_url, mi.url, mi.link, mi.href];
    S.audioList = audioSources
        .map(coerceMediaUrl)
        .filter((u, i, all) => u && all.indexOf(u) === i);
    S.audioUrl = S.audioList[0] || null;
    S.currentData = data;
    S.copyCount = 0;

    const captionEl = document.getElementById('captionArea');
    captionEl.value = S.caption || 'No caption found for this video.';
    document.getElementById('charCount').textContent = S.caption ? `${S.caption.length} characters` : '';
    document.getElementById('copyCountBadge').style.display = 'none';

    const author = data.author ? (data.author.nickname || data.author.unique_id || 'Unknown') : 'Unknown';
    document.getElementById('infoAuthor').textContent = '@' + author;
    document.getElementById('infoDuration').textContent = fmtDur(data.duration);
    document.getElementById('infoLikes').textContent = fmtNum(data.digg_count);
    document.getElementById('infoViews').textContent = fmtNum(data.play_count);
    document.getElementById('videoInfoCard').style.display = 'block';

    const videoWrap = document.getElementById('videoWrap');
    const videoEl = document.getElementById('tiktokVideo');
    const slideshowWrap = document.getElementById('slideshowWrap');
    const placeholder = document.getElementById('previewPlaceholder');

    videoWrap.style.display = 'none';
    slideshowWrap.style.display = 'none';
    placeholder.style.display = 'none';
    videoEl.onerror = null;
    videoEl.onloadeddata = null;
    S.randomName = null;
    const oldPlay = videoWrap.querySelector('.vw-play');
    if (oldPlay) oldPlay.remove();
    setVideoLoadingHint(videoWrap, false);
    if (videoEl.dataset.blobUrl) { URL.revokeObjectURL(videoEl.dataset.blobUrl); delete videoEl.dataset.blobUrl; }
    videoEl.removeAttribute('poster');
    videoEl.removeAttribute('src');
    videoEl.load();
    videoEl.pause();

    if (S.images.length > 0) {
        document.getElementById('contentBadge').textContent = `📸 ${S.images.length} Images`;
        buildSlides(S.images);
        slideshowWrap.style.display = 'flex';
        document.getElementById('btnMp4').style.display = 'none';
        document.getElementById('btnAllImg').style.display = 'flex';
        document.getElementById('btnAllImgSub').textContent = `${S.images.length} slides · Save all at once`;
    } else if (previewCandidates.length > 0) {
        document.getElementById('contentBadge').textContent = '🎬 HD Video';
        setPosterWithFallback(videoEl, data);
        videoWrap.style.display = 'block';
        document.getElementById('btnMp4').style.display = 'flex';
        document.getElementById('btnAllImg').style.display = 'none';

        setupLazyPreview(videoEl, videoWrap, previewCandidates, () => {
            showToast('Preview Unavailable', 'The preview could not load, but the Download button may still work.', 'error');
            setupLazyPreview(videoEl, videoWrap, previewCandidates, () => {});   // let the user retry
        });
    } else {
        placeholder.style.display = 'block';
    }

    document.getElementById('btnMp3').style.display = S.audioUrl ? 'flex' : 'none';

    saveToHistory(data, originalUrl);

    S.userRating = 0;
    updateStars(0);
    document.getElementById('ratingLabel').textContent = 'Click a star to rate';

    finishProgress();
    setLoading(false);
    showResult();
    showToast('Success!', 'TikTok content fetched. Caption ready to copy!', 'success');
    setTimeout(() => { document.getElementById('resultSection').scrollIntoView({ block: 'start' }); }, 80);
}

/* ============================================================
   SLIDESHOW
============================================================ */
function buildSlides(images) {
    const grid = document.getElementById('slidesGrid');
    grid.innerHTML = '';
    const preview = document.createElement('div');
    preview.className = 'gallery-preview';
    preview.setAttribute('aria-label', `Open TikTok slideshow with ${images.length} photos`);
    const previewImage = document.createElement('img');
    previewImage.alt = 'TikTok slideshow preview';
    previewImage.loading = 'eager';
    previewImage.decoding = 'async';
    previewImage.referrerPolicy = 'no-referrer';
    preview.appendChild(previewImage);
    const previewLabel = document.createElement('span');
    previewLabel.innerHTML = '<i class="bi bi-images" aria-hidden="true"></i> View ' + images.length + ' Photos';
    preview.appendChild(previewLabel);
    let currentIndex = 0;
    const currentDownload = document.getElementById('downloadCurrentImage');
    const updatePreview = index => {
        currentIndex = (index + images.length) % images.length;
        setImageFallbacks(previewImage, images[currentIndex]);
        previewLabel.innerHTML = `<i class="bi bi-images" aria-hidden="true"></i> ${currentIndex + 1} / ${images.length} Photos`;
        if (currentDownload) currentDownload.onclick = () => doDownload(images[currentIndex], makeFilename('jpg', currentIndex + 1));
    };
    setImageFallbacks(previewImage, images[0]);
    if (currentDownload) currentDownload.onclick = () => doDownload(images[0], makeFilename('jpg', 1));
    const previousButton = document.createElement('button');
    previousButton.type = 'button';
    previousButton.className = 'gallery-nav gallery-nav-prev';
    previousButton.setAttribute('aria-label', 'View previous slideshow image');
    previousButton.innerHTML = '<i class="bi bi-chevron-left" aria-hidden="true"></i>';
    const nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'gallery-nav gallery-nav-next';
    nextButton.setAttribute('aria-label', 'View next slideshow image');
    nextButton.innerHTML = '<i class="bi bi-chevron-right" aria-hidden="true"></i>';
    previousButton.addEventListener('click', event => { event.stopPropagation(); updatePreview(currentIndex - 1); });
    nextButton.addEventListener('click', event => { event.stopPropagation(); updatePreview(currentIndex + 1); });
    preview.append(previousButton, nextButton);
    grid.appendChild(preview);
}

/* ============================================================
   SHOW/HIDE
============================================================ */
function showResult() { document.getElementById('resultSection').style.display = 'block'; }

function imagePreviewUrl(url) { return `https://wsrv.nl/?url=${encodeURIComponent(url)}&output=jpg`; }

function normalizeImages(images) {
    if (!Array.isArray(images)) return [];
    return images.flatMap(image => {
        if (typeof image === 'string') return [image];
        if (!image || typeof image !== 'object') return [];
        const candidates = [image.url, image.src, image.image, image.download_url, image.display_url, image.origin_cover, image.url_list];
        return candidates.flatMap(candidate => Array.isArray(candidate) ? candidate : [candidate]);
    })
        .map(resolveTikwmUrl)
        .filter((url, index, all) => typeof url === 'string' && /^https?:\/\//i.test(url) && all.indexOf(url) === index);
}

function setImageFallbacks(image, originalUrl) {
    const sources = [imagePreviewUrl(originalUrl), `https://images.weserv.nl/?url=${encodeURIComponent(originalUrl)}`, originalUrl];
    let sourceIndex = 0;
    const tryNextSource = () => {
        sourceIndex++;
        if (sourceIndex < sources.length) image.src = sources[sourceIndex];
    };
    image.addEventListener('error', tryNextSource);
    image.src = sources[0];
}

function hideResult() {
    document.getElementById('resultSection').style.display = 'none';
    document.getElementById('videoInfoCard').style.display = 'none';
    ['btnMp4','btnMp3','btnAllImg'].forEach(id => document.getElementById(id).style.display = 'none');
}

function setLoading(on) {
    const btn = document.getElementById('fetchBtn');
    btn.disabled = on;
    btn.innerHTML = on
        ? '<i class="bi bi-hourglass-split"></i> Fetching...'
        : '<i class="bi bi-lightning-charge-fill"></i> Download';
}

/* ============================================================
   DOWNLOAD
============================================================ */
/* Streams the file with live progress, so the user always sees it moving.
   If a source stalls (no data for 10s) it automatically switches to the next one. */
function saveBlob(blob, filename) {
    if (/\.mp3$/i.test(filename) && !/^audio\//i.test(blob.type)) blob = new Blob([blob], { type: 'audio/mpeg' });
    if (/\.mp4$/i.test(filename) && !/^video\//i.test(blob.type)) blob = new Blob([blob], { type: 'video/mp4' });
    const bUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = bUrl; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(bUrl), 10000);
}

function fmtMB(b) { return (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + ' MB'; }

function openDlCard(filename, immediate) {
    let box = document.getElementById('dlStack');
    if (!box) { box = document.createElement('div'); box.id = 'dlStack'; document.body.appendChild(box); }
    const ui = { el: null, cancelled: false, ctrl: null, closed: false, got: 0, total: 0 };
    const short = filename.length > 46 ? filename.slice(0, 43) + '…' : filename;

    function build() {
        if (ui.el || ui.closed) return;
        ui.el = document.createElement('div');
        ui.el.className = 'dl-card';
        ui.el.innerHTML = `
            <div class="dl-card-top">
                <span class="dl-card-ico"><i class="bi bi-arrow-down-circle-fill"></i></span>
                <span class="dl-card-name">${escHtml(short)}</span>
                <button type="button" class="dl-card-x" aria-label="Cancel download"><i class="bi bi-x-lg"></i></button>
            </div>
            <div class="dl-card-bar"><span></span></div>
            <div class="dl-card-txt">Starting download…</div>`;
        ui.el.querySelector('.dl-card-x').onclick = () => { ui.cancelled = true; if (ui.ctrl) ui.ctrl.abort(); ui.close(); };
        box.appendChild(ui.el);
        requestAnimationFrame(() => ui.el && ui.el.classList.add('show'));
        ui.render();
    }
    ui.render = () => {
        if (!ui.el) return;
        const bar = ui.el.querySelector('.dl-card-bar span');
        const txt = ui.el.querySelector('.dl-card-txt');
        if (ui.total) {
            const p = Math.min(99, Math.round(ui.got / ui.total * 100));
            ui.el.querySelector('.dl-card-bar').classList.remove('indeterminate');
            bar.style.width = p + '%';
            txt.textContent = `${p}% · ${fmtMB(ui.got)} of ${fmtMB(ui.total)}`;
        } else if (ui.got) {
            ui.el.querySelector('.dl-card-bar').classList.add('indeterminate');
            txt.textContent = `Downloading… ${fmtMB(ui.got)}`;
        }
    };
    ui.update = (got, total) => { ui.got = got; ui.total = total; ui.render(); };
    ui.note = msg => { if (ui.el) { ui.got = 0; ui.total = 0; ui.el.querySelector('.dl-card-txt').textContent = msg; ui.el.querySelector('.dl-card-bar span').style.width = '0%'; } };
    ui.done = () => {
        if (!ui.el) { ui.closed = true; return; }
        ui.el.classList.add('done');
        ui.el.querySelector('.dl-card-bar span').style.width = '100%';
        ui.el.querySelector('.dl-card-bar').classList.remove('indeterminate');
        ui.el.querySelector('.dl-card-txt').textContent = 'Saved ✓';
        setTimeout(ui.close, 1800);
    };
    ui.close = () => {
        ui.closed = true;
        if (ui.timer) clearTimeout(ui.timer);
        if (!ui.el) return;
        ui.el.classList.remove('show');
        const el = ui.el; ui.el = null;
        setTimeout(() => el.remove(), 350);
    };
    ui.show = build;
    ui.manual = (url, label) => {
        build();
        if (!ui.el) return;
        ui.el.querySelector('.dl-card-bar').style.display = 'none';
        ui.el.querySelector('.dl-card-txt').innerHTML =
            'The browser blocked a direct save from this source. Trying a direct browser download instead.' +
            '<button type="button" class="dl-card-open"><i class="bi bi-download"></i> ' + label + '</button>';
        ui.el.querySelector('.dl-card-open').onclick = () => {
            const a = document.createElement('a');
            a.href = url;
            a.rel = 'noopener';
            a.target = '_blank';
            a.download = label || 'download';
            document.body.appendChild(a);
            a.click();
            a.remove();
            ui.close();
        };
        setTimeout(() => ui.el && ui.el.querySelector('.dl-card-open').click(), 150);
        setTimeout(ui.close, 12000);
    };
    if (immediate) build(); else ui.timer = setTimeout(build, 700);
    return ui;
}

async function fetchBlobProgress(url, ui, stallMs, firstByteMs) {
    const ctrl = new AbortController();
    ui.ctrl = ctrl;
    let stall = setTimeout(() => ctrl.abort(), firstByteMs || stallMs);   // TikTok can take a while to prepare the file
    const bump = () => { clearTimeout(stall); stall = setTimeout(() => ctrl.abort(), stallMs); };
    try {
        const res = await fetch(url, { mode: 'cors', signal: ctrl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const ct = res.headers.get('content-type') || '';
        if (/^text\/|json/i.test(ct)) throw new Error('Not a media file (' + ct + ')');   // error page instead of the file
        bump();
        const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
        if (!res.body || !res.body.getReader) return await res.blob();
        const reader = res.body.getReader();
        const chunks = [];
        let got = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value); got += value.length;
            bump(); ui.update(got, total);
        }
        return new Blob(chunks, { type: ct || 'application/octet-stream' });
    } finally {
        clearTimeout(stall);
    }
}

async function doDownload(urlOrList, filename) {
    const urls = (Array.isArray(urlOrList) ? urlOrList : [urlOrList]).filter(Boolean);
    if (!urls.length) { showToast('No URL', 'Download URL not available.', 'error'); return; }
    const isImage = /\.(?:jpe?g|png|webp|gif|avif)$/i.test(filename);
    const sources = isImage
        ? urls.flatMap(u => [imagePreviewUrl(u), `https://images.weserv.nl/?url=${encodeURIComponent(u)}`, u])
        : urls;
    const ui = openDlCard(filename, !isImage);

    for (let i = 0; i < sources.length; i++) {
        try {
            const blob = await fetchBlobProgress(sources[i], ui, 10000, 25000);
            if (!blob || blob.size < 1000) throw new Error('empty');
            saveBlob(blob, filename);
            ui.done();
            if (isImage) showToast('Downloaded!', 'Image saved.', 'success');
            return;
        } catch (err) {
            if (ui.cancelled) return;
            console.warn('[TikTok Downloader] Source failed:', sources[i], err && err.message);
            if (i < sources.length - 1) ui.note('Trying another server…');
        }
    }
    // every source failed or was blocked: let the browser handle it directly
    ui.manual(urls[0], /\.mp3$/i.test(filename) ? 'Open MP3' : 'Open file');
}

function doMp4() {
    if (!S.videoUrl) { showToast('No Video', 'Fetch a TikTok URL first.', 'error'); return; }
    doDownload(S.videoList && S.videoList.length ? S.videoList : S.videoUrl, makeFilename('mp4'));
}
function doMp3() {
    if (!S.audioUrl) { showToast('No Audio', 'No audio track found.', 'error'); return; }
    doDownload(S.audioList && S.audioList.length ? S.audioList : S.audioUrl, makeFilename('mp3'));
}
function downloadAllSlides() {
    if (!S.images.length) { showToast('No Images', 'No slideshow images found.', 'error'); return; }
    showToast('Bulk Download', `Downloading ${S.images.length} images...`, 'info');
    S.images.forEach((url, i) => setTimeout(() => doDownload(url, makeFilename('jpg', i + 1)), i * 900));
}

/* ============================================================
   CAPTION
============================================================ */
function copyCaption() {
    const el = document.getElementById('captionArea');
    const val = el.value;
    if (!val || val === 'No caption found for this video.') { showToast('No Caption', 'Fetch a TikTok video first.', 'error'); return; }
    navigator.clipboard.writeText(val)
        .then(() => {
            el.classList.add('copy-flash');
            setTimeout(() => el.classList.remove('copy-flash'), 400);
            S.copyCount++;
            document.getElementById('copyCountNum').textContent = S.copyCount;
            document.getElementById('copyCountBadge').style.display = 'flex';
            showToast('Caption Copied!', 'TikTok caption copied to clipboard.', 'success');
        })
        .catch(() => { el.select(); document.execCommand('copy'); showToast('Copied!', 'Caption copied.', 'success'); });
}

function saveCaption() {
    const val = document.getElementById('captionArea').value;
    if (!val) { showToast('No Caption', 'Fetch a TikTok video first.', 'error'); return; }
    const blob = new Blob([val], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const name = makeFilename('txt');
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    showToast('Saved!', 'Caption downloaded as a .txt file.', 'success');
}

async function shareCaption() {
    const val = document.getElementById('captionArea').value;
    if (!val || val === 'No caption found for this video.') { showToast('No Caption', 'Fetch a TikTok video first.', 'error'); return; }
    if (navigator.share) {
        try {
            await navigator.share({ title: 'TikTok Caption', text: val });
            showToast('Shared!', 'Caption shared successfully.', 'success');
        } catch { showToast('Cancelled', 'Share was cancelled.', 'info'); }
    } else {
        navigator.clipboard.writeText(val).then(() => showToast('Copied!', 'Share not supported. Caption copied instead.', 'info'));
    }
}

/* ============================================================
   RATING
============================================================ */
function rateTool(stars) {
    S.userRating = stars;
    updateStars(stars);
    const labels = ['', 'Poor 😔', 'Fair 😐', 'Good 😊', 'Great 😄', 'Amazing! 🤩'];
    document.getElementById('ratingLabel').textContent = `${labels[stars]}. Thank you for rating!`;
    localStorage.setItem('tt-user-rating', stars);
    showToast('Thank You! ⭐', `You rated us ${stars} star${stars > 1 ? 's' : ''}. We appreciate it!`, 'success');
}

function updateStars(active) {
    document.querySelectorAll('.star-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.star) <= active);
    });
}

/* ============================================================
   HISTORY
============================================================ */
function saveToHistory(data, url) {
    const author = data.author ? (data.author.nickname || 'Unknown') : 'Unknown';
    const item = {
        id: Date.now(),
        url,
        title: data.title || 'No caption',
        author: '@' + author,
        type: data.images && data.images.length > 0 ? 'slideshow' : 'video',
        cover: cleanMediaUrl(data.cover || data.origin_cover || null),
        videoUrl: cleanMediaUrl(data.hdplay || data.play || null),
        audioUrl: cleanMediaUrl(data.music || null),
        images: normalizeImages(data.images),
        timestamp: Date.now()
    };
    S.history = S.history.filter(h => h.url !== url);
    S.history.unshift(item);
    if (S.history.length > 10) S.history.pop();
    localStorage.setItem('tt-history', JSON.stringify(S.history));
    renderHistory();
}

function renderHistory() {
    const list = document.getElementById('historyList');
    if (!S.history.length) {
        list.innerHTML = `<div class="history-empty">
            <i class="bi bi-clock-history" aria-hidden="true"></i>
            <p style="font-size:0.88rem;font-weight:600;">No downloads yet</p>
            <p style="font-size:0.78rem;">Your recent downloads will appear here</p>
        </div>`;
        return;
    }
    list.innerHTML = S.history.map(item => `
        <div class="history-item" role="listitem">
            <div class="history-thumb">
                ${item.cover
                    ? `<img src="${item.cover}" alt="TikTok video by ${escHtml(item.author)}" loading="lazy" width="56" height="56" onerror="this.style.display='none'">`
                    : `<i class="bi bi-${item.type === 'slideshow' ? 'images' : 'camera-video'}" aria-hidden="true"></i>`
                }
            </div>
            <div class="history-info">
                <div class="history-title">${escHtml(item.title.substring(0, 60))}${item.title.length > 60 ? '...' : ''}</div>
                <div class="history-meta">
                    <i class="bi bi-person-circle" aria-hidden="true"></i> ${escHtml(item.author)} ·
                    <i class="bi bi-${item.type === 'slideshow' ? 'images' : 'camera-video'}" aria-hidden="true"></i> ${item.type === 'slideshow' ? `${item.images.length} images` : 'Video'} ·
                    ${fmtTime(item.timestamp)}
                </div>
            </div>
            <div class="history-actions">
                <button class="history-btn" onclick="reloadHistory(${item.id})" aria-label="Reload this download">
                    <i class="bi bi-arrow-clockwise" aria-hidden="true"></i> Reload
                </button>
                <button class="history-btn" onclick="copyHistoryCaption(${item.id})" aria-label="Copy caption from history">
                    <i class="bi bi-clipboard" aria-hidden="true"></i> Copy
                </button>
                <button class="history-btn" onclick="removeHistory(${item.id})" style="color:var(--secondary);" aria-label="Remove from history">
                    <i class="bi bi-trash" aria-hidden="true"></i>
                </button>
            </div>
        </div>
    `).join('');
}

function reloadHistory(id) {
    const item = S.history.find(h => h.id === id);
    if (!item) return;
    document.getElementById('tiktokUrl').value = item.url;
    document.getElementById('tiktokUrl').dispatchEvent(new Event('input'));
    fetchTikTok();
    document.getElementById('downloader').scrollIntoView();
}

function copyHistoryCaption(id) {
    const item = S.history.find(h => h.id === id);
    if (!item || !item.title) { showToast('No Caption', 'No caption in history.', 'error'); return; }
    navigator.clipboard.writeText(item.title)
        .then(() => showToast('Copied!', 'Caption copied from history.', 'success'))
        .catch(() => showToast('Failed', 'Could not copy caption.', 'error'));
}

function removeHistory(id) {
    S.history = S.history.filter(h => h.id !== id);
    localStorage.setItem('tt-history', JSON.stringify(S.history));
    renderHistory();
    showToast('Removed', 'Item removed from history.', 'info');
}

function clearHistory() {
    if (!S.history.length) { showToast('Already Empty', 'History is already empty.', 'info'); return; }
    S.history = [];
    localStorage.setItem('tt-history', '[]');
    renderHistory();
    showToast('History Cleared', 'Download history has been cleared.', 'success');
}

/* ============================================================
   FAQ
============================================================ */
function toggleFaq(el) {
    const item = el.closest('.faq-item');
    const wasOpen = item.classList.contains('open');
    document.querySelectorAll('.faq-item').forEach(i => { i.classList.remove('open'); i.querySelector('.faq-q').setAttribute('aria-expanded','false'); });
    if (!wasOpen) { item.classList.add('open'); el.setAttribute('aria-expanded','true'); }
}

/* ============================================================
   TOAST
============================================================ */
function showToast(title, sub, type = 'success') {
    const icons = { success:'bi-check-circle-fill', error:'bi-x-circle-fill', info:'bi-info-circle-fill' };
    const box = document.getElementById('toastBox');
    const el = document.createElement('div');
    el.className = `toast-el ${type}`;
    el.innerHTML = `
        <div class="toast-ico"><i class="bi ${icons[type] || icons.info}" aria-hidden="true"></i></div>
        <div><span class="toast-title">${escHtml(title)}</span><span class="toast-sub">${escHtml(sub)}</span></div>`;
    box.appendChild(el);
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('show')));
    setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 400); }, 3800);
}

/* ============================================================
   HELPERS
============================================================ */
function fmtDur(s) { if (!s) return 'N/A'; return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
function fmtNum(n) { if (!n) return 'N/A'; if (n>=1e6) return (n/1e6).toFixed(1)+'M'; if (n>=1e3) return (n/1e3).toFixed(1)+'K'; return String(n); }
function fmtTime(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
    return `${Math.floor(diff/86400000)}d ago`;
}
function escHtml(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
}