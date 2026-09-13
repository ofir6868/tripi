/**
 * TripMaker accessibility engine (WCAG 2.2 / IS 5568 AA tools).
 *
 * Floating FAB + overlay drawer when data-aaa-toolbar is not false.
 * Optional in-page menu via data-aaa-embed.
 *
 *   data-aaa-lang        he | en | fr | ru | ar
 *   data-aaa-skip        true | false   (skip-to-content link)
 *   data-aaa-audit       true | false
 *   data-aaa-toolbar     true | false   (FAB + overlay drawer)
 *   data-aaa-embed       CSS selector for in-page menu host
 *   data-aaa-statement   accessibility statement URL
 *   data-aaa-storage     localStorage key (default tripmaker-aaa)
 */
(function () {
  'use strict';

  if (window.WCAG22 && window.WCAG22.__kvatorAaa) return;

  var SCRIPT =
    document.currentScript ||
    document.querySelector('script[data-kvator-wcag22], script[src*="wcag22.js"]');
  var ALLOWED_LANG = { he: 1, en: 1, fr: 1, ru: 1, ar: 1 };
  var LANG = detectUiLang();
  var SPEECH_LANG = { he: 'he-IL', en: 'en-US', fr: 'fr-FR', ru: 'ru-RU', ar: 'ar-IL' };
  var AUDIT = !!(SCRIPT && SCRIPT.getAttribute('data-aaa-audit') === 'true');
  var TOOLBAR = !(SCRIPT && SCRIPT.getAttribute('data-aaa-toolbar') === 'false');
  var SKIP = !(SCRIPT && SCRIPT.getAttribute('data-aaa-skip') === 'false');
  var STORE_KEY = (SCRIPT && SCRIPT.getAttribute('data-aaa-storage')) || 'tripmaker-aaa';
  var EMBED_SEL = (SCRIPT && SCRIPT.getAttribute('data-aaa-embed')) || '#tripmaker-a11y-menu';
  var ROOT_ID = 'aaa-widget';
  var STATEMENT_URL = (SCRIPT && SCRIPT.getAttribute('data-aaa-statement')) || '/accessibility';

  function detectUiLang() {
    var q = '';
    try {
      q = (new URLSearchParams(window.location.search).get('lang') || '').slice(0, 2);
    } catch (e) { /* ignore */ }
    if (ALLOWED_LANG[q]) return q;
    var stored = '';
    try {
      stored = (localStorage.getItem('kvator-lang') || '').slice(0, 2);
    } catch (e) { /* ignore */ }
    if (ALLOWED_LANG[stored]) return stored;
    var htmlLang = (document.documentElement.getAttribute('lang') || document.documentElement.lang || '').slice(0, 2);
    if (ALLOWED_LANG[htmlLang]) return htmlLang;
    var attr = ((SCRIPT && SCRIPT.getAttribute('data-aaa-lang')) || '').slice(0, 2);
    if (ALLOWED_LANG[attr]) return attr;
    return 'he';
  }

  var I18N = {
    he: {
      dir: 'rtl',
      open: 'תפריט נגישות',
      close: 'סגירת תפריט נגישות',
      title: 'התאמות נגישות',
      subtitle: 'ת״י 5568 · רמת AA',
      reset: 'איפוס הכל',
      statement: 'הצהרת נגישות',
      skip: 'דילוג לתוכן',
      tab: 'נגישות',
      fontUp: 'הגדלת טקסט',
      fontDown: 'הקטנת טקסט',
      readable: 'גופן קריא',
      spacing: 'ריווח טקסט',
      contrast: 'ניגודיות גבוהה',
      invert: 'היפוך צבעים',
      gray: 'גווני אפור',
      links: 'הדגשת קישורים',
      headings: 'הדגשת כותרות',
      cursor: 'סמן גדול',
      motion: 'עצירת אנימציות',
      guide: 'מדריך קריאה',
      mask: 'מסכת קריאה',
      speak: 'קריאה בקול',
      speakStop: 'עצירת קריאה',
      on: 'פעיל',
      off: 'כבוי',
    },
    en: {
      dir: 'ltr',
      open: 'Accessibility menu',
      close: 'Close accessibility menu',
      title: 'Accessibility options',
      subtitle: 'IS 5568 · Level AA',
      reset: 'Reset all',
      statement: 'Accessibility statement',
      skip: 'Skip to content',
      tab: 'Accessibility',
      fontUp: 'Increase text',
      fontDown: 'Decrease text',
      readable: 'Readable font',
      spacing: 'Text spacing',
      contrast: 'High contrast',
      invert: 'Invert colors',
      gray: 'Grayscale',
      links: 'Highlight links',
      headings: 'Highlight headings',
      cursor: 'Large cursor',
      motion: 'Stop animations',
      guide: 'Reading guide',
      mask: 'Reading mask',
      speak: 'Read aloud',
      speakStop: 'Stop reading',
      on: 'On',
      off: 'Off',
    },
    fr: {
      dir: 'ltr',
      open: 'Menu d’accessibilité',
      close: 'Fermer le menu d’accessibilité',
      title: 'Options d’accessibilité',
      subtitle: 'IS 5568 · Niveau AA',
      reset: 'Tout réinitialiser',
      statement: 'Déclaration d’accessibilité',
      skip: 'Aller au contenu',
      tab: 'Accessibilité',
      fontUp: 'Agrandir le texte',
      fontDown: 'Réduire le texte',
      readable: 'Police lisible',
      spacing: 'Espacement du texte',
      contrast: 'Contraste élevé',
      invert: 'Inverser les couleurs',
      gray: 'Niveaux de gris',
      links: 'Surligner les liens',
      headings: 'Surligner les titres',
      cursor: 'Grand curseur',
      motion: 'Arrêter les animations',
      guide: 'Guide de lecture',
      mask: 'Masque de lecture',
      speak: 'Lecture à voix haute',
      speakStop: 'Arrêter la lecture',
      on: 'Activé',
      off: 'Désactivé',
    },
    ru: {
      dir: 'ltr',
      open: 'Меню доступности',
      close: 'Закрыть меню доступности',
      title: 'Параметры доступности',
      subtitle: 'IS 5568 · уровень AA',
      reset: 'Сбросить всё',
      statement: 'Заявление о доступности',
      skip: 'К содержанию',
      tab: 'Доступность',
      fontUp: 'Увеличить текст',
      fontDown: 'Уменьшить текст',
      readable: 'Читаемый шрифт',
      spacing: 'Интервалы текста',
      contrast: 'Высокий контраст',
      invert: 'Инверсия цветов',
      gray: 'Оттенки серого',
      links: 'Выделить ссылки',
      headings: 'Выделить заголовки',
      cursor: 'Большой курсор',
      motion: 'Остановить анимации',
      guide: 'Линейка чтения',
      mask: 'Маска чтения',
      speak: 'Читать вслух',
      speakStop: 'Остановить чтение',
      on: 'Вкл.',
      off: 'Выкл.',
    },
    ar: {
      dir: 'rtl',
      open: 'قائمة إمكانية الوصول',
      close: 'إغلاق قائمة إمكانية الوصول',
      title: 'خيارات إمكانية الوصول',
      subtitle: 'IS 5568 · المستوى AA',
      reset: 'إعادة ضبط الكل',
      statement: 'بيان إمكانية الوصول',
      skip: 'تخطٍ إلى المحتوى',
      tab: 'إمكانية الوصول',
      fontUp: 'تكبير النص',
      fontDown: 'تصغير النص',
      readable: 'خط مقروء',
      spacing: 'تباعد النص',
      contrast: 'تباين عالٍ',
      invert: 'عكس الألوان',
      gray: 'تدرج رمادي',
      links: 'إبراز الروابط',
      headings: 'إبراز العناوين',
      cursor: 'مؤشر كبير',
      motion: 'إيقاف الحركات',
      guide: 'دليل القراءة',
      mask: 'قناع القراءة',
      speak: 'قراءة بصوت عالٍ',
      speakStop: 'إيقاف القراءة',
      on: 'تشغيل',
      off: 'إيقاف',
    },
  };

  var t = I18N[LANG] || I18N.he;

  var DEFAULTS = {
    font: 0,
    readable: false,
    spacing: false,
    contrast: false,
    invert: false,
    gray: false,
    links: false,
    headings: false,
    cursor: false,
    motion: false,
    guide: false,
    mask: false,
  };

  var state = loadState();
  var panelOpen = false;
  var speaking = false;
  var lastFocus = null;
  var guideEl = null;
  var maskEl = null;
  var listenersBound = false;

  injectCss();
  applyState();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) { /* ignore quota / private mode */ }
  }

  function injectCss() {
    if (document.getElementById('aaa-widget-css')) return;
    var style = document.createElement('style');
    style.id = 'aaa-widget-css';
    style.textContent = [
      '.aaa-skip{position:absolute;inset-inline-start:1rem;top:-120px;z-index:2147483000;background:#1f2d27;color:#fff;padding:.75rem 1.2rem;border-radius:.7rem;font-weight:800;font-size:1rem;text-decoration:none;min-height:44px;min-width:44px;display:inline-flex;align-items:center}',
      '.aaa-skip:focus{top:1rem;outline:3px solid #fff;outline-offset:3px}',
      '#' + ROOT_ID + '{font-family:Assistant,system-ui,sans-serif}',
      '.aaa-fab{position:fixed;z-index:2147483647;left:max(12px,env(safe-area-inset-left));bottom:max(16px,env(safe-area-inset-bottom));width:42px;height:42px;border:0;border-radius:50%;background:#1f2d27;color:#fff;cursor:pointer;box-shadow:0 8px 18px rgba(31,45,39,.32);display:grid;place-items:center;padding:0}',
      '.aaa-fab:focus-visible{outline:3px solid #1f2d27;outline-offset:3px}',
      '.aaa-fab svg{width:20px;height:20px;fill:currentColor;pointer-events:none}',
      '.aaa-panel{display:none;position:fixed;z-index:2147483646;top:0;left:0;height:100vh;width:min(22rem,calc(100vw - 5rem));overflow:auto;background:#fffcfa;color:#1f2d27;border-right:1px solid #c5d4ca;box-shadow:12px 0 32px rgba(31,45,39,.18);padding:1rem 1rem 5.5rem;box-sizing:border-box}',
      '#' + ROOT_ID + '.is-open .aaa-panel{display:flex !important;flex-direction:column;gap:.55rem}',
      '.aaa-embed{font-family:Assistant,system-ui,sans-serif;color:#1f2d27}',
      '.aaa-head{display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;flex-shrink:0}',
      '.aaa-head h2{margin:0;font-size:1.1rem;font-weight:800}',
      '.aaa-head p{margin:.2rem 0 0;font-size:.8rem;color:#3d4441}',
      '.aaa-x{width:44px;height:44px;border:0;border-radius:.6rem;background:#ebf0ed;color:#1f2d27;font-size:1.4rem;cursor:pointer;flex-shrink:0}',
      '.aaa-grid{display:grid;grid-template-columns:1fr 1fr;gap:.55rem;flex:0 0 auto}',
      '.aaa-btn{min-height:48px;border:1px solid #c5d4ca;border-radius:.7rem;background:#fff;color:#1f2d27;font-weight:700;font-size:.85rem;cursor:pointer;padding:.45rem .5rem}',
      '.aaa-btn.is-on{background:#1f2d27;color:#fff;border-color:#1f2d27}',
      '.aaa-btn:focus-visible,.aaa-x:focus-visible,.aaa-reset:focus-visible,.aaa-statement:focus-visible{outline:3px solid #1f2d27;outline-offset:2px}',
      '.aaa-reset,.aaa-statement{display:flex;align-items:center;justify-content:center;width:100%;min-height:44px;margin-top:.55rem;border-radius:.7rem;font-weight:800;text-decoration:none;cursor:pointer;font-size:.9rem;box-sizing:border-box}',
      '.aaa-reset{border:1px solid #c5d4ca;background:#ebf0ed;color:#1f2d27}',
      '.aaa-statement{background:#1f2d27;color:#fff;border:0}',
      'html.aaa-readable,html.aaa-readable body,html.aaa-readable button,html.aaa-readable input,html.aaa-readable textarea,html.aaa-readable select{font-family:Arial,Helvetica,sans-serif !important}',
      'html.aaa-spacing body{line-height:1.8 !important;letter-spacing:.12em !important;word-spacing:.16em !important}',
      'html.aaa-spacing p,html.aaa-spacing li,html.aaa-spacing h1,html.aaa-spacing h2,html.aaa-spacing h3{line-height:1.8 !important;margin-bottom:2em}',
      'html.aaa-contrast{background:#000 !important}',
      'html.aaa-contrast body{background:#000 !important;color:#fff !important}',
      'html.aaa-contrast a{color:#ffe14d !important}',
      'html.aaa-contrast button:not(.aaa-fab):not(.aaa-x):not(.aaa-btn):not(.aaa-reset),html.aaa-contrast .btn,html.aaa-contrast summary{background:#000 !important;color:#fff !important;border-color:#fff !important}',
      'html.aaa-contrast .aaa-statement{background:#000 !important;color:#fff !important;border:1px solid #fff}',
      'html.aaa-invert body>*:not(#' + ROOT_ID + '):not(.aaa-skip):not(.aaa-guide):not(.aaa-mask):not(.aaa-audit){filter:invert(1) hue-rotate(180deg)}',
      'html.aaa-invert .aaa-fab{filter:invert(1) hue-rotate(180deg)}',
      'html.aaa-invert ' + EMBED_SEL + '{filter:invert(1) hue-rotate(180deg)}',
      'html.aaa-gray body>*:not(#' + ROOT_ID + '):not(.aaa-skip):not(.aaa-guide):not(.aaa-mask):not(.aaa-audit){filter:grayscale(1)}',
      'html.aaa-gray .aaa-fab{filter:none}',
      'html.aaa-links a:not(.aaa-statement):not(.aaa-skip){text-decoration:underline !important;text-underline-offset:.18em;background:#ffe14d;color:#000 !important}',
      'html.aaa-headings h1,html.aaa-headings h2,html.aaa-headings h3,html.aaa-headings h4{outline:3px solid #1f2d27;outline-offset:4px;background:#ffe14d}',
      'html.aaa-cursor,html.aaa-cursor *{cursor:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'48\' height=\'48\'%3E%3Cpath fill=\'%23000\' stroke=\'%23fff\' stroke-width=\'2\' d=\'M8 4 L8 40 L18 30 L26 46 L32 43 L24 27 L38 27 Z\'/%3E%3C/svg%3E") 4 4, auto !important}',
      'html.aaa-motion,html.aaa-motion *,html.aaa-motion *::before,html.aaa-motion *::after{animation:none !important;transition:none !important;scroll-behavior:auto !important}',
      '.aaa-guide{position:fixed;left:0;right:0;height:10px;background:rgba(255,225,77,.75);border-block:2px solid #1f2d27;pointer-events:none;z-index:2147483645}',
      '.aaa-mask{position:fixed;inset:0;pointer-events:none;z-index:2147483644;box-shadow:0 0 0 100vmax rgba(0,0,0,.62)}',
      '.aaa-audit{position:fixed;inset-inline-end:16px;bottom:16px;z-index:2147483646;max-width:22rem;max-height:40vh;overflow:auto;background:#1f2d27;color:#fff;padding:.9rem 1rem;border-radius:.85rem;font-size:.85rem;box-shadow:0 12px 28px rgba(0,0,0,.28)}',
      '.aaa-audit h2{margin:0 0 .5rem;font-size:.95rem}',
      '.aaa-audit li{margin:.35rem 0}',
    ].join('');
    document.head.appendChild(style);
  }

  function mount() {
    if (SKIP) ensureSkipLink();
    bindListeners();

    var embed = document.querySelector(EMBED_SEL);
    var root = document.getElementById(ROOT_ID);

    if (!TOOLBAR) {
      document.querySelectorAll('.aaa-fab').forEach(function (fab) {
        fab.hidden = true;
        fab.setAttribute('hidden', '');
      });
      if (root && !embed) {
        root.querySelectorAll('.aaa-panel').forEach(function (panel) {
          panel.hidden = true;
        });
        root.classList.remove('is-open');
      }
      syncToggleUi();
      if (AUDIT) runAudit();
      return;
    }

    if (root && root.getAttribute('data-aaa-ready') === '1') {
      syncToggleUi();
      return;
    }

    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      document.body.appendChild(root);
    }
    root.setAttribute('dir', t.dir);
    root.setAttribute('lang', LANG);

    var existingFab = document.querySelector('.aaa-fab');
    if (existingFab && existingFab.parentNode !== root) {
      root.insertBefore(existingFab, root.firstChild);
    }

    if (!root.querySelector('.aaa-panel')) {
      var fabHtml = root.querySelector('.aaa-fab')
        ? ''
        : '<button type="button" class="aaa-fab" aria-haspopup="dialog" aria-expanded="false" aria-controls="aaa-panel" title="' + escapeHtml(t.open) + '">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm-1 7h2l3.2 4.4-1.6 1.2L13 12.2V22h-2v-9.8l-1.6 2.4-1.6-1.2L11 9Z"/></svg>' +
          '</button>';
      root.insertAdjacentHTML('beforeend', fabHtml +
      '<div class="aaa-panel" id="aaa-panel" role="dialog" aria-modal="true" aria-labelledby="aaa-title" hidden>' +
        '<div class="aaa-head">' +
          '<div><h2 id="aaa-title">' + escapeHtml(t.title) + '</h2><p>' + escapeHtml(t.subtitle) + '</p></div>' +
          '<button type="button" class="aaa-x" data-aaa-close aria-label="' + escapeHtml(t.close) + '">×</button>' +
        '</div>' +
        '<div class="aaa-grid">' +
          actionButton('fontUp', t.fontUp) +
          actionButton('fontDown', t.fontDown) +
          toggleButton('readable', t.readable) +
          toggleButton('spacing', t.spacing) +
          toggleButton('contrast', t.contrast) +
          toggleButton('invert', t.invert) +
          toggleButton('gray', t.gray) +
          toggleButton('links', t.links) +
          toggleButton('headings', t.headings) +
          toggleButton('cursor', t.cursor) +
          toggleButton('motion', t.motion) +
          toggleButton('guide', t.guide) +
          toggleButton('mask', t.mask) +
          '<button type="button" class="aaa-btn" data-aaa-act="speak">' + escapeHtml(t.speak) + '</button>' +
        '</div>' +
        '<button type="button" class="aaa-reset" data-aaa-act="reset">' + escapeHtml(t.reset) + '</button>' +
        (STATEMENT_URL ? '<a class="aaa-statement" href="' + escapeHtml(STATEMENT_URL) + '">' + escapeHtml(t.statement) + '</a>' : '') +
      '</div>');
    }

    root.setAttribute('data-aaa-ready', '1');

    var fab = document.querySelector('.aaa-fab');
    if (fab) {
      fab.setAttribute('aria-label', t.open);
      fab.setAttribute('title', t.open);
      fab.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        panelOpen ? closePanel() : openPanel();
      });
    }
    var closeBtn = root.querySelector('[data-aaa-close]');
    if (closeBtn) {
      closeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        closePanel();
      });
    }
    syncToggleUi();
    if (AUDIT) runAudit();
  }

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;

    document.querySelectorAll('.skip-link, .aaa-skip').forEach(function (link) {
      link.addEventListener('click', function () {
        var id = (link.getAttribute('href') || '').replace('#', '');
        var target = document.getElementById(id);
        if (target) {
          if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
          window.setTimeout(function () { target.focus(); }, 0);
        }
      });
    });

    document.addEventListener('click', onActionClick);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', function (e) {
      if (!panelOpen || !TOOLBAR) return;
      if (e.target.closest('.aaa-fab, .aaa-panel, #' + ROOT_ID)) return;
      closePanel();
    });
    document.addEventListener('mousemove', onPointer);
  }

  function actionButton(act, label) {
    return '<button type="button" class="aaa-btn" data-aaa-act="' + act + '">' + escapeHtml(label) + '</button>';
  }

  function toggleButton(key, label) {
    return '<button type="button" class="aaa-btn" data-aaa-toggle="' + key + '" aria-pressed="false">' + escapeHtml(label) + '</button>';
  }

  function ensureSkipLink() {
    if (document.querySelector('.aaa-skip, a[href="#main-content"]')) return;
    var main = document.querySelector('main');
    if (main && !main.id) main.id = 'main-content';
    var target = (main && main.id) || 'main-content';
    if (!document.getElementById(target) && main) main.id = target;
    var a = document.createElement('a');
    a.className = 'aaa-skip';
    a.href = '#' + target;
    a.textContent = t.skip;
    document.body.insertBefore(a, document.body.firstChild);
  }

  function onActionClick(e) {
    var btn = e.target.closest('[data-aaa-toggle], [data-aaa-act]');
    if (!btn) return;
    var toggle = btn.getAttribute('data-aaa-toggle');
    var act = btn.getAttribute('data-aaa-act');
    if (toggle) {
      state[toggle] = !state[toggle];
      if (toggle === 'contrast' && state.contrast) {
        state.invert = false;
        state.gray = false;
      }
      if ((toggle === 'invert' || toggle === 'gray') && state[toggle]) state.contrast = false;
      saveState();
      applyState();
      syncToggleUi();
      return;
    }
    if (act === 'fontUp') changeFont(1);
    if (act === 'fontDown') changeFont(-1);
    if (act === 'reset') resetAll();
    if (act === 'speak') toggleSpeak();
  }

  function changeFont(delta) {
    state.font = Math.max(-1, Math.min(4, state.font + delta));
    saveState();
    applyState();
  }

  function resetAll() {
    stopSpeak();
    state = Object.assign({}, DEFAULTS);
    saveState();
    applyState();
    syncToggleUi();
  }

  function applyState() {
    var root = document.documentElement;
    var scale = 1 + state.font * 0.12;
    root.style.fontSize = state.font === 0 ? '' : (scale * 100) + '%';
    toggleClass(root, 'aaa-readable', state.readable);
    toggleClass(root, 'aaa-spacing', state.spacing);
    toggleClass(root, 'aaa-contrast', state.contrast);
    toggleClass(root, 'aaa-invert', state.invert);
    toggleClass(root, 'aaa-gray', state.gray);
    toggleClass(root, 'aaa-links', state.links);
    toggleClass(root, 'aaa-headings', state.headings);
    toggleClass(root, 'aaa-cursor', state.cursor);
    toggleClass(root, 'aaa-motion', state.motion);
    setGuide(state.guide);
    setMask(state.mask);
  }

  function toggleClass(el, name, on) {
    el.classList.toggle(name, !!on);
  }

  function syncToggleUi() {
    document.querySelectorAll('[data-aaa-toggle]').forEach(function (btn) {
      var key = btn.getAttribute('data-aaa-toggle');
      var on = !!state[key];
      btn.classList.toggle('is-on', on);
      btn.setAttribute('aria-pressed', String(on));
    });
    syncSpeakLabel();
  }

  function setGuide(on) {
    if (!on) {
      if (guideEl) guideEl.remove();
      guideEl = null;
      return;
    }
    if (!guideEl) {
      guideEl = document.createElement('div');
      guideEl.className = 'aaa-guide';
      guideEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(guideEl);
    }
  }

  function setMask(on) {
    if (!on) {
      if (maskEl) maskEl.remove();
      maskEl = null;
      return;
    }
    if (!maskEl) {
      maskEl = document.createElement('div');
      maskEl.className = 'aaa-mask';
      maskEl.setAttribute('aria-hidden', 'true');
      document.body.appendChild(maskEl);
    }
  }

  function onPointer(e) {
    if (guideEl) guideEl.style.top = Math.max(0, e.clientY - 5) + 'px';
    if (maskEl) {
      maskEl.style.top = e.clientY - 70 + 'px';
      maskEl.style.height = '140px';
      maskEl.style.left = '0';
      maskEl.style.right = '0';
    }
  }

  function openPanel() {
    var root = document.getElementById(ROOT_ID);
    var panel = document.getElementById('aaa-panel');
    var fab = document.querySelector('.aaa-fab');
    if (!root || !panel || !fab) return;
    lastFocus = document.activeElement;
    panelOpen = true;
    root.classList.add('is-open');
    panel.hidden = false;
    fab.setAttribute('aria-expanded', 'true');
    fab.setAttribute('aria-label', t.close);
    var first = panel.querySelector('button, a');
    if (first) first.focus();
  }

  function closePanel() {
    var root = document.getElementById(ROOT_ID);
    var panel = document.getElementById('aaa-panel');
    var fab = document.querySelector('.aaa-fab');
    if (!root || !panel || !fab) return;
    panelOpen = false;
    root.classList.remove('is-open');
    panel.hidden = true;
    fab.setAttribute('aria-expanded', 'false');
    fab.setAttribute('aria-label', t.open);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    else fab.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape' && panelOpen) {
      e.preventDefault();
      closePanel();
      return;
    }
    if (!panelOpen || e.key !== 'Tab') return;
    var panel = document.getElementById('aaa-panel');
    if (!panel) return;
    var focusable = Array.prototype.slice.call(
      panel.querySelectorAll('button, a[href], [tabindex]:not([tabindex="-1"])')
    ).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
    if (!focusable.length) return;
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function toggleSpeak() {
    if (speaking) {
      stopSpeak();
      return;
    }
    if (!window.speechSynthesis) return;
    var text = document.body.innerText || '';
    text = text.replace(/\s+/g, ' ').trim().slice(0, 4000);
    if (!text) return;
    var utter = new SpeechSynthesisUtterance(text);
    utter.lang = SPEECH_LANG[LANG] || 'en-US';
    utter.rate = 1;
    utter.onend = function () { speaking = false; syncSpeakLabel(); };
    utter.onerror = function () { speaking = false; syncSpeakLabel(); };
    speaking = true;
    syncSpeakLabel();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utter);
  }

  function stopSpeak() {
    speaking = false;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    syncSpeakLabel();
  }

  function syncSpeakLabel() {
    document.querySelectorAll('[data-aaa-act="speak"]').forEach(function (btn) {
      btn.textContent = speaking ? t.speakStop : t.speak;
    });
  }

  function runAudit() {
    var issues = [];
    if (!document.documentElement.lang) issues.push('חסר lang במסמך (3.1.1)');
    if (!document.querySelector('h1')) issues.push('חסרה כותרת H1 (2.4.6 / 2.4.10)');
    if (!document.querySelector('main, [role="main"]')) issues.push('חסר אזור main (1.3.1)');
    if (!document.querySelector('a[href="#main-content"], .aaa-skip, .skip-link')) {
      issues.push('חסר קישור דילוג לתוכן (2.4.1)');
    }
    document.querySelectorAll('img').forEach(function (img) {
      if (!img.hasAttribute('alt') && img.getAttribute('aria-hidden') !== 'true') {
        issues.push('תמונה ללא alt: ' + (img.getAttribute('src') || ''));
      }
    });
    document.querySelectorAll('a, button').forEach(function (el) {
      var name = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!name && el.getAttribute('aria-hidden') !== 'true') {
        issues.push('פקד ללא שם נגיש: <' + el.tagName.toLowerCase() + '>');
      }
    });
    var box = document.createElement('aside');
    box.className = 'aaa-audit';
    box.setAttribute('aria-label', 'דוח ביקורת נגישות');
    box.innerHTML = '<h2>ביקורת AAA</h2>' + (
      issues.length
        ? '<ul>' + issues.map(function (item) { return '<li>' + escapeHtml(item) + '</li>'; }).join('') + '</ul>'
        : '<p>לא נמצאו ממצאים אוטומטיים.</p>'
    );
    document.body.appendChild(box);
    if (typeof console !== 'undefined' && console.group) {
      console.group('WCAG 2.2 AAA audit');
      issues.forEach(function (item) { console.warn(item); });
      console.groupEnd();
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.WCAG22 = {
    __kvatorAaa: true,
    remount: mount,
    sync: syncToggleUi,
    apply: applyState,
    reset: resetAll,
    load: function () { return Object.assign({}, state); },
    save: saveState,
  };
})();
