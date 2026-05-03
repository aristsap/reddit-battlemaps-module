// ── LOUD LOAD SIGNAL (must be first — fires even if everything else breaks) ──
console.log('%cRBI MODULE LOADED', 'background:red;color:white;font-size:24px;padding:8px');
try { Hooks.once('ready', () => ui.notifications.warn('RBI module loaded — check console')); } catch (e) { console.error('RBI early-hook failed:', e); }

// ── Reddit API ────────────────────────────────────────────────────────────────

const RBI_IMAGE_DOMAINS = new Set(['i.redd.it', 'i.imgur.com']);
const RBI_IMAGE_EXT = /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i;

function rbiIsImagePost(data) {
  const url = data.url || '';
  const domain = data.domain || '';
  return RBI_IMAGE_EXT.test(url) || RBI_IMAGE_DOMAINS.has(domain) || domain === 'imgur.com';
}

function rbiDecodeHtml(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function rbiExtractUrls(data) {
  const url = data.url || '';
  const domain = data.domain || '';
  let imageUrl = '';

  if (RBI_IMAGE_EXT.test(url) || RBI_IMAGE_DOMAINS.has(domain)) {
    imageUrl = url;
  } else if (domain === 'imgur.com') {
    imageUrl = 'https://i.imgur.com/' + url.split('/').pop() + '.jpg';
  }

  const preview = data.preview?.images?.[0];
  // Pick a small Reddit-pre-sized variant (~320–640px) instead of the full-res source.
  // resolutions[] is sorted ascending: [108, 216, 320, 640, 960, 1080]
  const resolutions = preview?.resolutions || [];
  const smallVariant = resolutions[2] || resolutions[1] || resolutions[3] || preview?.source;
  let thumbnailUrl = smallVariant?.url
    ? rbiDecodeHtml(smallVariant.url)
    : (data.thumbnail?.startsWith('http') ? data.thumbnail : imageUrl);

  // Larger variant for the lightbox preview — still capped, never the original
  const previewVariant = resolutions[4] || resolutions[3] || preview?.source;
  const previewUrl = previewVariant?.url ? rbiDecodeHtml(previewVariant.url) : imageUrl;

  return {
    imageUrl,            // full-res — only used at import time
    thumbnailUrl,        // ~320px — for the grid cards
    previewUrl,          // ~960px — for the lightbox
    width: preview?.source?.width || 0,
    height: preview?.source?.height || 0
  };
}

async function rbiFetchPosts(subreddit, { after = null, limit = 25, query = '' } = {}) {
  const ap = after ? '&after=' + encodeURIComponent(after) : '';
  let url;
  if (query) {
    url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=top&limit=${limit}${ap}`;
  } else {
    url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}${ap}`;
  }

  let json;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    json = await res.json();
  } catch (e) {
    const fallback = url.replace('www.reddit.com', 'old.reddit.com');
    const res2 = await fetch(fallback, { headers: { Accept: 'application/json' } });
    if (!res2.ok) throw new Error('HTTP ' + res2.status);
    json = await res2.json();
  }

  const children = json?.data?.children ?? [];
  const posts = children
    .map(c => c.data)
    .filter(rbiIsImagePost)
    .map(data => {
      const { imageUrl, thumbnailUrl, previewUrl, width, height } = rbiExtractUrls(data);
      return { id: data.id, title: data.title, author: data.author, score: data.score, permalink: data.permalink, imageUrl, thumbnailUrl, previewUrl, width, height };
    })
    .filter(p => p.imageUrl);

  return { posts, after: json?.data?.after ?? null };
}

// ── Scene Creator ─────────────────────────────────────────────────────────────

function rbiSanitize(title) {
  return (title || 'reddit-map').replace(/[^a-zA-Z0-9._\- ]/g, '').trim().replace(/\s+/g, '_').substring(0, 64) || 'reddit-map';
}

async function rbiImportScene(imageUrl, postTitle) {
  const N = (msg, type = 'info') => ui.notifications[type](msg, { permanent: false });
  try {
    N('1/5 Downloading image…');
    const res = await fetch(imageUrl);
    if (!res.ok) throw new Error('Download HTTP ' + res.status);
    const blob = await res.blob();
    const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const baseName = rbiSanitize(postTitle);
    const stamp = Date.now().toString(36);
    const file = new File([blob], `${baseName}-${stamp}.${ext}`, { type: blob.type });

    N('2/5 Uploading to Foundry…');
    try { await FilePicker.createDirectory('data', 'reddit-battlemaps', {}); } catch {}
    const result = await FilePicker.upload('data', 'reddit-battlemaps', file, {});
    if (!result?.path) throw new Error('Upload returned no path');

    let scenePath = result.path.replace(/\\/g, '/').replace(/^\/+/, '');
    N(`3/5 Uploaded to: ${scenePath}`);

    const { width, height } = await new Promise(resolve => {
      const img = new Image();
      const objUrl = URL.createObjectURL(blob);
      img.onload = () => { resolve({ width: img.naturalWidth, height: img.naturalHeight }); URL.revokeObjectURL(objUrl); };
      img.onerror = () => { resolve({ width: 2048, height: 2048 }); URL.revokeObjectURL(objUrl); };
      img.src = objUrl;
    });

    const sceneName = (postTitle || 'Reddit Map').substring(0, 48).trim();
    N(`4/5 Creating scene "${sceneName}" (${width}x${height})…`);

    // Discover the correct field name by inspecting an existing scene
    const sampleScene = game.scenes.find(s => {
      const obj = s.toObject();
      return JSON.stringify(obj).includes('.jpg') || JSON.stringify(obj).includes('.png') || JSON.stringify(obj).includes('.webp');
    });
    if (sampleScene) {
      const obj = sampleScene.toObject();
      // Find the path containing fields
      const fieldsWithImage = [];
      const scan = (o, path = '') => {
        if (!o || typeof o !== 'object') return;
        for (const [k, v] of Object.entries(o)) {
          const fullPath = path ? `${path}.${k}` : k;
          if (typeof v === 'string' && /\.(jpg|jpeg|png|webp|gif)/i.test(v)) {
            fieldsWithImage.push(`${fullPath}=${v.substring(0, 40)}`);
          } else if (v && typeof v === 'object' && !Array.isArray(v)) {
            scan(v, fullPath);
          }
        }
      };
      scan(obj);
      N('Existing scene image fields: ' + (fieldsWithImage.join(' | ') || '(none)'));
      console.log('RBI | sample scene full object:', obj);
    } else {
      N('No existing scene with an image to inspect');
    }

    // Step 1: Create a bare scene
    const created = await Scene.create({
      name: sceneName,
      width,
      height,
      grid: { type: 1, size: 100, color: '#000000', alpha: 0.2 },
      padding: 0,
      tokenVision: false,
      fogExploration: false
    });
    const scene = Array.isArray(created) ? created[0] : created;
    if (!scene) throw new Error('Scene.create returned nothing');

    // Verify the uploaded file is actually browseable at the path
    try {
      const browse = await FilePicker.browse('data', 'reddit-battlemaps');
      const filename = scenePath.split('/').pop();
      const found = browse.files.find(f => f.endsWith(filename));
      if (found) {
        N(`✓ File verified at: ${found}`);
        // Use the EXACT path the picker reports — it may differ from upload result
        scenePath = found;
      } else {
        N(`⚠ File NOT found in browse. Listed: ${browse.files.length} files`, 'warn');
      }
    } catch (browseErr) {
      N('Browse failed: ' + browseErr.message, 'warn');
    }

    // Try each strategy, surfacing actual errors
    const attempts = [
      { label: 'background.src flat', data: { 'background.src': scenePath } },
      { label: 'background object',   data: { background: { src: scenePath } } },
      { label: 'img legacy',          data: { img: scenePath } }
    ];

    let stuck = null;
    for (const attempt of attempts) {
      try {
        const updated = await scene.update(attempt.data);
        const fresh = game.scenes.get(scene.id);
        const src = fresh?.background?.src || fresh?.img;
        N(`Tried "${attempt.label}" → got back: ${src || '(empty)'}`);
        if (src) {
          stuck = { label: attempt.label, src };
          break;
        }
      } catch (e) {
        N(`"${attempt.label}" threw: ${e.message}`, 'warn');
      }
    }

    if (stuck) {
      N(`✓ Background applied via ${stuck.label}`);
    } else {
      // Final fallback: bypass schema entirely with updateSource + manual save
      try {
        scene.updateSource({ 'background.src': scenePath });
        await scene.update({ name: scene.name }); // trigger save
        const fresh = game.scenes.get(scene.id);
        if (fresh?.background?.src) {
          N(`✓ Background applied via updateSource bypass: ${fresh.background.src}`);
        } else {
          N(`⚠ Even updateSource failed. Path: ${scenePath}`, 'warn');
        }
      } catch (srcErr) {
        N('updateSource error: ' + srcErr.message, 'error');
      }
    }

    // Generate sidebar thumbnail
    try {
      if (scene.createThumbnail) {
        const thumb = await scene.createThumbnail();
        if (thumb?.thumb) await scene.update({ thumb: thumb.thumb });
      }
    } catch {}

  } catch (err) {
    N('Import failed: ' + err.message, 'error');
    throw err;
  }
}

// ── Application UI ────────────────────────────────────────────────────────────

class RedditImporterApp extends Application {
  constructor(...args) {
    super(...args);
    this._sub = 'battlemaps';
    this._posts = [];
    this._after = null;
    this._loading = false;
    this._error = null;
    this._query = '';
    this._hasMore = true;
  }

  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: 'reddit-battlemaps-importer',
      title: 'Reddit BattleMaps Importer',
      template: 'modules/reddit-battlemaps-importer/templates/importer.html',
      width: 880,
      height: 660,
      resizable: true
    });
  }

  async getData() {
    return {
      subreddit: this._sub,
      posts: this._posts,
      loading: this._loading,
      error: this._error,
      searchQuery: this._query,
      hasMore: this._hasMore && !this._loading && !this._error,
      statusText: this._loading ? 'Loading…' : `${this._posts.length} maps loaded`
    };
  }

  activateListeners(html) {
    super.activateListeners(html);
    html.find('.rbi-tab').on('click', ev => this._switchSub(ev.currentTarget.dataset.subreddit));
    html.find('.rbi-search-btn').on('click', () => this._doSearch());
    html.find('.rbi-search-input').on('keydown', ev => { if (ev.key === 'Enter') this._doSearch(); });
    html.find('.rbi-card').on('click', ev => {
      if ($(ev.target).closest('.rbi-import-btn').length) return;
      this._openLightbox(ev.currentTarget.dataset);
    });
    html.find('.rbi-import-btn').on('click', ev => {
      ev.stopPropagation();
      const d = $(ev.currentTarget).closest('.rbi-card')[0].dataset;
      this._importPost(d);
    });
    html.find('.rbi-load-more-btn').on('click', () => this._loadMore());
    html.find('.rbi-retry-btn').on('click', () => this._load(true));
    html.find('.rbi-lightbox-backdrop, .rbi-lightbox-close').on('click', () => this._closeLightbox());
    html.find('.rbi-lightbox-import-btn').on('click', () => {
      const lb = this.element.find('.rbi-lightbox')[0];
      this._importPost({ imageUrl: lb.dataset.imageUrl, title: lb.dataset.title });
    });
  }

  async _render(force, options) {
    await super._render(force, options);
    if (!this._posts.length && !this._loading && !this._error) this._load(true);
  }

  async _load(reset = true) {
    if (this._loading) return;
    if (reset) { this._posts = []; this._after = null; this._hasMore = true; }
    this._loading = true;
    this._error = null;
    this.render();
    try {
      const { posts, after } = await rbiFetchPosts(this._sub, { after: this._after, query: this._query });
      this._posts = reset ? posts : [...this._posts, ...posts];
      this._after = after;
      this._hasMore = !!after && posts.length > 0;
    } catch (err) {
      this._error = 'Could not load maps: ' + err.message;
    } finally {
      this._loading = false;
      const scrollTop = this.element?.find('.rbi-grid-container')[0]?.scrollTop ?? 0;
      this.render();
      setTimeout(() => { const c = this.element?.find('.rbi-grid-container')[0]; if (c) c.scrollTop = scrollTop; }, 0);
    }
  }

  _switchSub(sub) {
    if (sub === this._sub) return;
    this._sub = sub; this._query = '';
    this._load(true);
  }

  _doSearch() {
    this._query = (this.element?.find('.rbi-search-input')[0]?.value || '').trim();
    this._load(true);
  }

  _loadMore() {
    if (!this._hasMore || this._loading) return;
    this._load(false);
  }

  _openLightbox({ imageUrl, thumbnailUrl, previewUrl, title, author, score, permalink }) {
    const lb = this.element.find('.rbi-lightbox');
    lb.find('.rbi-lightbox-img').attr('src', previewUrl || thumbnailUrl || imageUrl || '');
    lb.find('.rbi-lightbox-title').text(title || '');
    lb.find('.rbi-lightbox-score').html('<i class="fas fa-arrow-up"></i> ' + (score || 0));
    lb.find('.rbi-lightbox-author').text(author ? 'u/' + author : '');
    lb.find('.rbi-lightbox-reddit-link').attr('href', permalink ? 'https://reddit.com' + permalink : '#');
    lb[0].dataset.imageUrl = imageUrl || '';
    lb[0].dataset.title = title || '';
    lb.css('display', 'flex');
  }

  _closeLightbox() {
    this.element.find('.rbi-lightbox').hide().find('.rbi-lightbox-img').attr('src', '');
  }

  async _importPost({ imageUrl, title }) {
    if (!imageUrl) { ui.notifications.warn('No image URL for this post.'); return; }
    const cardBtn = this.element.find(`.rbi-card[data-image-url="${CSS.escape(imageUrl)}"] .rbi-import-btn`);
    const lbBtn = this.element.find('.rbi-lightbox-import-btn');
    [cardBtn, lbBtn].forEach(b => b.prop('disabled', true).html('<i class="fas fa-spinner fa-spin"></i>'));
    try {
      await rbiImportScene(imageUrl, title || 'Reddit Map');
      this._closeLightbox();
    } catch {}
    finally {
      cardBtn.prop('disabled', false).html('<i class="fas fa-file-import"></i> Import');
      lbBtn.prop('disabled', false).html('<i class="fas fa-file-import"></i> Import to Foundry');
    }
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

let rbiApp = null;

function rbiOpen() {
  console.log('RBI | opening importer');
  if (!rbiApp || !rbiApp.rendered) rbiApp = new RedditImporterApp();
  rbiApp.render(true, { focus: true });
}

// FormApplication used purely as a "open the importer" trigger from settings menu
class RbiOpenerForm extends FormApplication {
  render() { rbiOpen(); return this; }
  async _updateObject() {}
}

Hooks.once('init', () => {
  console.log('RBI | init hook fired ✓');
  try {
    game.settings.registerMenu('reddit-battlemaps-importer', 'open', {
      name: 'Open Reddit BattleMaps Importer',
      label: 'Open Importer',
      hint: 'Browse r/battlemaps and r/dndmaps and import maps as scenes.',
      icon: 'fas fa-map',
      type: RbiOpenerForm,
      restricted: true
    });
    console.log('RBI | settings menu registered ✓');
  } catch (e) {
    console.error('RBI | settings menu registration failed:', e);
  }
});

Hooks.once('ready', () => {
  console.log('RBI | ready hook fired ✓  — call rbiOpen() to test');
  game.redditImporter = { open: rbiOpen };
  window.rbiOpen = rbiOpen;
});

// Inject button at the bottom of the Scenes sidebar tab (right side)
Hooks.on('renderSceneDirectory', (app, html) => {
  if (!game.user?.isGM) return;

  // jQuery in some Foundry versions, plain HTMLElement in others — normalize to jQuery
  const $html = html instanceof jQuery ? html : $(html);
  if ($html.find('#rbi-sidebar-btn').length) return;

  const btn = $(`
    <button type="button" id="rbi-sidebar-btn" class="rbi-sidebar-btn">
      <i class="fas fa-map"></i> Import from Reddit
    </button>
  `);
  btn.on('click', rbiOpen);

  // Append at the very end of the directory contents
  const root = $html.is('section, .directory') ? $html : $html.closest('section, .directory');
  (root.length ? root : $html).append(btn);
  console.log('RBI | sidebar button injected into Scenes directory ✓');
});
