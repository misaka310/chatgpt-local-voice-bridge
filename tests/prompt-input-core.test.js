'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const promptInput = require('../extension/prompt-input-core.js');

class FakeEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.bubbles = Boolean(options.bubbles);
  }
}

class FakeInputEvent extends FakeEvent {}

function createFixture() {
  let documentObject = null;
  const createElement = ({
    tagName = 'DIV',
    attributes = {},
    hidden = false,
    disabled = false,
    form = null,
  } = {}) => {
    const element = {
      tagName,
      hidden,
      inert: false,
      disabled,
      isConnected: true,
      value: '',
      textContent: '',
      innerText: '',
      clicked: 0,
      dispatched: [],
      getAttribute(name) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null; },
      closest(selector) {
        if (selector === 'form') return form;
        if (selector === '[hidden], [inert], [aria-hidden="true"]') return hidden ? element : null;
        return null;
      },
      contains(target) { return target === element; },
      focus() { documentObject.activeElement = element; },
      dispatchEvent(event) { element.dispatched.push(event.type); return true; },
      click() { element.clicked += 1; },
    };
    return element;
  };

  const scopedSendButton = createElement({ tagName: 'BUTTON', attributes: { 'aria-label': 'Send prompt' } });
  const form = {
    querySelector(selector) {
      return selector === 'button[aria-label="Send prompt"]' ? scopedSendButton : null;
    },
  };
  const hiddenComposer = createElement({
    tagName: 'TEXTAREA',
    attributes: { placeholder: 'Hidden composer' },
    hidden: true,
  });
  const visibleComposer = createElement({
    tagName: 'DIV',
    attributes: { contenteditable: 'true' },
    form,
  });
  const hiddenGlobalSendButton = createElement({
    tagName: 'BUTTON',
    attributes: { 'aria-label': 'Send prompt' },
    hidden: true,
  });

  const selectorMap = new Map([
    ['#prompt-textarea', [hiddenComposer]],
    ['textarea[data-id="root"]', []],
    ['textarea[placeholder]', [hiddenComposer]],
    ['[contenteditable="true"][data-virtualkeyboard]', []],
    ['div[contenteditable="true"].ProseMirror', [visibleComposer]],
    ['button[data-testid="send-button"]', []],
    ['button[aria-label="Send prompt"]', [hiddenGlobalSendButton]],
    ['button[aria-label*="送信"]', []],
    ['button[aria-label*="Send"]', [hiddenGlobalSendButton]],
  ]);

  documentObject = {
    activeElement: visibleComposer,
    querySelectorAll(selector) { return selectorMap.get(selector) || []; },
    querySelector(selector) { return (selectorMap.get(selector) || [])[0] || null; },
    execCommand() { return false; },
    addEventListener() {},
    removeEventListener() {},
  };

  return {
    documentObject,
    hiddenComposer,
    visibleComposer,
    hiddenGlobalSendButton,
    scopedSendButton,
  };
}

test('findComposer ignores stale hidden composers and keeps the active usable composer', () => {
  const fixture = createFixture();

  const composer = promptInput.findComposer(fixture.documentObject, fixture.visibleComposer);

  assert.equal(composer, fixture.visibleComposer);
  assert.equal(promptInput.isComposerTarget(fixture.documentObject, fixture.visibleComposer), true);
  assert.equal(promptInput.isComposerTarget(fixture.documentObject, fixture.hiddenComposer), false);
});

test('findComposer excludes computed-hidden and read-only composers', () => {
  const fixture = createFixture();
  fixture.hiddenComposer.hidden = false;
  fixture.hiddenComposer.ownerDocument = {
    defaultView: {
      getComputedStyle() { return { display: 'none', visibility: 'visible' }; },
    },
  };
  fixture.visibleComposer.readOnly = true;

  assert.equal(promptInput.findComposer(fixture.documentObject), null);
  assert.equal(promptInput.isComposerTarget(fixture.documentObject, fixture.visibleComposer), false);
});

test('pending voice send inserts into the selected composer and clicks its scoped send button', () => {
  const fixture = createFixture();
  const states = [];
  const controller = promptInput.createPendingSendController({
    document: fixture.documentObject,
    window: {},
    Event: FakeEvent,
    InputEvent: FakeInputEvent,
    getLocation: () => 'https://chatgpt.com/c/current',
    onState: (state) => states.push(state),
  });

  const result = controller.start({ sessionId: 1, text: '音声入力テスト', graceMs: 0 });

  assert.equal(result.ok, true);
  assert.equal(fixture.visibleComposer.innerText, '音声入力テスト');
  assert.equal(fixture.hiddenComposer.value, '');
  assert.equal(fixture.scopedSendButton.clicked, 1);
  assert.equal(fixture.hiddenGlobalSendButton.clicked, 0);
  assert.equal(states.at(-1).phase, 'waiting_response');
});
