'use strict';

(function exposePromptInputCore(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.LocalVoicePromptInput = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const COMPOSER_SELECTORS = [
    '#prompt-textarea',
    'textarea[data-id="root"]',
    'textarea[placeholder]',
    '[contenteditable="true"][data-virtualkeyboard]',
    'div[contenteditable="true"].ProseMirror',
  ];
  const SEND_SELECTORS = [
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label*="送信"]',
    'button[aria-label*="Send"]',
  ];

  function normalizeComposerValue(value) {
    return String(value || '').replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
  }

  function normalizeText(value) {
    return normalizeComposerValue(value).trim();
  }

  function composerText(element) {
    if (!element) return '';
    const tagName = String(element.tagName || '').toUpperCase();
    if (tagName === 'TEXTAREA' || tagName === 'INPUT') return normalizeComposerValue(element.value);
    return normalizeComposerValue(element.innerText !== undefined ? element.innerText : element.textContent);
  }

  function dispatchInput(element, environment = {}) {
    const EventCtor = environment.Event || globalThis.Event;
    const InputEventCtor = environment.InputEvent || globalThis.InputEvent;
    let event;
    try {
      event = InputEventCtor
        ? new InputEventCtor('input', { bubbles: true, inputType: 'insertText', data: null })
        : new EventCtor('input', { bubbles: true });
    } catch (_error) {
      event = new EventCtor('input', { bubbles: true });
    }
    element.dispatchEvent(event);
  }

  function setNativeValue(element, value, environment = {}) {
    const tagName = String(element.tagName || '').toUpperCase();
    const windowObject = environment.window || (typeof window !== 'undefined' ? window : null);
    if (windowObject && tagName === 'TEXTAREA' && windowObject.HTMLTextAreaElement) {
      const descriptor = Object.getOwnPropertyDescriptor(windowObject.HTMLTextAreaElement.prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
    } else if (windowObject && tagName === 'INPUT' && windowObject.HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(windowObject.HTMLInputElement.prototype, 'value');
      if (descriptor && descriptor.set) descriptor.set.call(element, value);
      else element.value = value;
    } else if (tagName === 'TEXTAREA' || tagName === 'INPUT') {
      element.value = value;
    } else {
      element.textContent = value;
      if ('innerText' in element) element.innerText = value;
    }
    dispatchInput(element, environment);
  }

  function insertComposerText(element, text, environment = {}) {
    const normalized = normalizeText(text);
    if (!element) return { ok: false, reason: 'composer-not-found' };
    if (!normalized) return { ok: false, reason: 'text-empty' };
    if (composerText(element) !== '') return { ok: false, reason: 'composer-not-empty' };
    if (typeof element.focus === 'function') element.focus();

    const tagName = String(element.tagName || '').toUpperCase();
    const documentObject = environment.document || (typeof document !== 'undefined' ? document : null);
    let insertedByCommand = false;
    if (tagName !== 'TEXTAREA' && tagName !== 'INPUT' && documentObject && typeof documentObject.execCommand === 'function') {
      try {
        insertedByCommand = Boolean(documentObject.execCommand('insertText', false, normalized));
      } catch (_error) {
        insertedByCommand = false;
      }
    }
    if (!insertedByCommand || normalizeText(composerText(element)) !== normalized) {
      setNativeValue(element, normalized, environment);
    }
    if (normalizeText(composerText(element)) !== normalized) {
      return { ok: false, reason: 'composer-state-not-updated' };
    }
    return { ok: true, insertedText: normalized };
  }

  function clearInsertedText(element, insertedText, environment = {}) {
    if (!element) return { ok: false, reason: 'composer-not-found' };
    const expected = normalizeText(insertedText);
    if (normalizeText(composerText(element)) !== expected) return { ok: false, reason: 'composer-changed' };
    setNativeValue(element, '', environment);
    return composerText(element) === ''
      ? { ok: true }
      : { ok: false, reason: 'composer-clear-failed' };
  }

  function isElementHidden(element) {
    if (!element) return true;
    if (element.isConnected === false || element.hidden === true || element.inert === true) return true;
    if (typeof element.getAttribute === 'function') {
      if (String(element.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return true;
      const style = String(element.getAttribute('style') || '').replace(/\s+/g, '').toLowerCase();
      if (style.includes('display:none') || style.includes('visibility:hidden')) return true;
    }
    if (typeof element.closest === 'function') {
      const hiddenAncestor = element.closest('[hidden], [inert], [aria-hidden="true"]');
      if (hiddenAncestor) return true;
    }
    return false;
  }

  function isComposerUsable(element) {
    if (!element || element.disabled || isElementHidden(element)) return false;
    if (typeof element.getAttribute === 'function') {
      if (String(element.getAttribute('aria-disabled') || '').toLowerCase() === 'true') return false;
      if (String(element.getAttribute('contenteditable') || '').toLowerCase() === 'false') return false;
    }
    return true;
  }

  function matchingElements(documentObject, selectors) {
    const matches = [];
    const seen = new Set();
    for (const selector of selectors) {
      let elements = [];
      if (typeof documentObject.querySelectorAll === 'function') {
        elements = Array.from(documentObject.querySelectorAll(selector) || []);
      } else if (typeof documentObject.querySelector === 'function') {
        const element = documentObject.querySelector(selector);
        if (element) elements = [element];
      }
      for (const element of elements) {
        if (!element || seen.has(element)) continue;
        seen.add(element);
        matches.push(element);
      }
    }
    return matches;
  }

  function containsTarget(element, target) {
    return Boolean(element && target && (
      element === target
      || (typeof element.contains === 'function' && element.contains(target))
    ));
  }

  function findComposer(documentObject, preferredTarget = null) {
    if (!documentObject || (typeof documentObject.querySelector !== 'function'
      && typeof documentObject.querySelectorAll !== 'function')) return null;
    const composers = matchingElements(documentObject, COMPOSER_SELECTORS).filter(isComposerUsable);
    if (!composers.length) return null;
    if (preferredTarget) {
      const preferred = composers.find((element) => containsTarget(element, preferredTarget));
      if (preferred) return preferred;
    }
    const activeElement = documentObject.activeElement || null;
    if (activeElement) {
      const active = composers.find((element) => containsTarget(element, activeElement));
      if (active) return active;
    }
    return composers[0];
  }

  function isComposerTarget(documentObject, target) {
    const composer = findComposer(documentObject, target);
    return Boolean(composer && containsTarget(composer, target));
  }

  function isButtonEnabled(button) {
    if (!button || button.disabled || isElementHidden(button)) return false;
    const ariaDisabled = typeof button.getAttribute === 'function' ? button.getAttribute('aria-disabled') : null;
    return String(ariaDisabled || '').toLowerCase() !== 'true';
  }

  function findSendButton(documentObject, composer = null) {
    if (!documentObject || (typeof documentObject.querySelector !== 'function'
      && typeof documentObject.querySelectorAll !== 'function')) return null;
    if (composer && typeof composer.closest === 'function') {
      const form = composer.closest('form');
      if (form && typeof form.querySelector === 'function') {
        for (const selector of SEND_SELECTORS) {
          const scopedButton = form.querySelector(selector);
          if (isButtonEnabled(scopedButton)) return scopedButton;
        }
      }
    }
    return matchingElements(documentObject, SEND_SELECTORS).find(isButtonEnabled) || null;
  }

  function createPendingSendController(environment = {}) {
    const documentObject = environment.document || (typeof document !== 'undefined' ? document : null);
    const windowObject = environment.window || (typeof window !== 'undefined' ? window : null);
    const setTimer = environment.setTimeout || globalThis.setTimeout.bind(globalThis);
    const clearTimer = environment.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    const getLocation = environment.getLocation || (() => (typeof location !== 'undefined' ? location.href : ''));
    const onState = typeof environment.onState === 'function' ? environment.onState : () => {};
    let pending = null;
    let generation = 0;

    const emit = (phase, statusText, error = '') => onState({ phase, statusText, error });

    function detachEsc(item) {
      if (item && documentObject && typeof documentObject.removeEventListener === 'function') {
        documentObject.removeEventListener('keydown', item.escHandler, true);
      }
    }

    function finishPending(item) {
      if (!item) return;
      if (item.timer) clearTimer(item.timer);
      detachEsc(item);
      if (pending === item) pending = null;
    }

    function cancel(reason = 'cancelled') {
      const item = pending;
      if (!item) return { ok: false, reason: 'nothing-pending' };
      generation += 1;
      finishPending(item);
      const cleared = clearInsertedText(item.composer, item.insertedText, {
        document: documentObject,
        window: windowObject,
        Event: environment.Event,
        InputEvent: environment.InputEvent,
      });
      if (cleared.ok) {
        emit('idle', reason === 'escape' ? 'Escでキャンセルしました' : '送信をキャンセルしました');
        return { ok: true, reason };
      }
      emit('error', '送信をキャンセルしましたが入力欄は変更されていました', cleared.reason);
      return { ok: false, reason: cleared.reason };
    }

    function send(item) {
      if (!item || pending !== item || item.generation !== generation) return { ok: false, reason: 'stale' };
      if (getLocation() !== item.location) {
        finishPending(item);
        emit('error', 'ページが変わったため送信しませんでした', 'page-changed');
        return { ok: false, reason: 'page-changed' };
      }
      if (normalizeText(composerText(item.composer)) !== item.insertedText) {
        finishPending(item);
        emit('error', '入力欄が変更されたため自動送信しませんでした', 'composer-changed');
        return { ok: false, reason: 'composer-changed' };
      }
      const button = findSendButton(documentObject, item.composer);
      if (!button) {
        finishPending(item);
        emit('error', 'ChatGPTの送信ボタンを確認できませんでした', 'send-button-not-ready');
        return { ok: false, reason: 'send-button-not-ready' };
      }
      finishPending(item);
      emit('sending', 'ChatGPTへ送信中');
      button.click();
      emit('waiting_response', 'ChatGPT応答待ち');
      return { ok: true };
    }

    function start({ sessionId, text, graceMs }) {
      if (pending) cancel('new-recording');
      const composer = findComposer(documentObject);
      if (!composer) {
        emit('error', 'ChatGPTの入力欄を検出できませんでした', 'composer-not-found');
        return { ok: false, reason: 'composer-not-found' };
      }
      const inserted = insertComposerText(composer, text, {
        document: documentObject,
        window: windowObject,
        Event: environment.Event,
        InputEvent: environment.InputEvent,
      });
      if (!inserted.ok) {
        const messages = {
          'composer-not-empty': '入力欄に既存文章があるため自動送信しませんでした',
          'text-empty': '文字起こし結果が空のため送信しませんでした',
          'composer-state-not-updated': 'ChatGPTの入力状態へ反映できませんでした',
        };
        emit('error', messages[inserted.reason] || 'ChatGPT入力欄へ反映できませんでした', inserted.reason);
        return inserted;
      }

      generation += 1;
      const safeGrace = Math.max(0, Math.min(5000, Math.round(Number(graceMs) || 0)));
      const item = {
        generation,
        sessionId: Number(sessionId) || 0,
        composer,
        insertedText: inserted.insertedText,
        location: getLocation(),
        timer: null,
        escHandler: null,
      };
      item.escHandler = (event) => {
        if (event.key !== 'Escape' || pending !== item) return;
        event.preventDefault();
        event.stopPropagation();
        cancel('escape');
      };
      if (documentObject && typeof documentObject.addEventListener === 'function') {
        documentObject.addEventListener('keydown', item.escHandler, true);
      }
      pending = item;
      if (safeGrace === 0) return send(item);
      emit('pending_send', `Escでキャンセルできます（${(safeGrace / 1000).toFixed(1)}秒）`);
      item.timer = setTimer(() => send(item), safeGrace);
      return { ok: true, pending: true, insertedText: item.insertedText };
    }

    return {
      start,
      cancel,
      hasPending: () => Boolean(pending),
    };
  }

  return {
    composerText,
    insertComposerText,
    clearInsertedText,
    findComposer,
    isComposerTarget,
    findSendButton,
    createPendingSendController,
  };
}));
