// A minimal DOM for rendering components with react-dom/client in node: the
// renderer tests run without jsdom, and only the virtual tables' effects need a
// live DOM. Elements, text, attributes, inline style, capture/bubble listeners,
// focus, and a scroll box whose height the test sets. Import it before
// react-dom/client: React decides at load time whether a DOM exists.

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;

type Listener = { fn: (e: ShimEvent) => void; capture: boolean };

export class ShimEvent {
  readonly type: string;
  readonly bubbles: boolean;
  readonly cancelable: boolean;
  defaultPrevented = false;
  target: ShimNode | null = null;
  currentTarget: ShimNode | null = null;
  eventPhase = 0;
  readonly timeStamp = Date.now();
  stopped = false;
  [k: string]: unknown;

  constructor(type: string, init: { bubbles?: boolean; cancelable?: boolean; [k: string]: unknown } = {}) {
    const { bubbles = false, cancelable = false, ...rest } = init;
    this.type = type;
    this.bubbles = bubbles;
    this.cancelable = cancelable;
    Object.assign(this, rest);
  }

  preventDefault(): void {
    if (this.cancelable) this.defaultPrevented = true;
  }

  stopPropagation(): void {
    this.stopped = true;
  }

  stopImmediatePropagation(): void {
    this.stopped = true;
  }
}

export class ShimNode {
  parentNode: ShimNode | null = null;
  childNodes: ShimNode[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly nodeType: number,
    readonly nodeName: string,
    public ownerDocument: ShimDocument | null,
  ) {}

  get firstChild(): ShimNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): ShimNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): ShimNode | null {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null;
  }

  get previousSibling(): ShimNode | null {
    const p = this.parentNode;
    if (!p) return null;
    return p.childNodes[p.childNodes.indexOf(this) - 1] ?? null;
  }

  get parentElement(): ShimNode | null {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }

  appendChild<T extends ShimNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends ShimNode>(child: T, ref: ShimNode | null): T {
    if (ref === null) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    const at = this.childNodes.indexOf(ref);
    if (at < 0) throw new Error('insertBefore: the reference node is not a child');
    child.parentNode = this;
    this.childNodes.splice(at, 0, child);
    return child;
  }

  removeChild<T extends ShimNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error('removeChild: not a child');
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }

  contains(n: ShimNode | null): boolean {
    for (let c: ShimNode | null = n; c; c = c.parentNode) if (c === this) return true;
    return false;
  }

  getRootNode(): ShimNode {
    let n: ShimNode = this;
    while (n.parentNode) n = n.parentNode;
    return n;
  }

  get textContent(): string {
    return this.childNodes.map((c) => c.textContent).join('');
  }

  set textContent(v: string) {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined && this.ownerDocument) this.appendChild(this.ownerDocument.createTextNode(String(v)));
  }

  addEventListener(type: string, fn: ((e: ShimEvent) => void) | null, opts?: boolean | { capture?: boolean }): void {
    if (!fn) return;
    const capture = typeof opts === 'boolean' ? opts : opts?.capture === true;
    const list = this.listeners.get(type) ?? [];
    if (!list.some((l) => l.fn === fn && l.capture === capture)) list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, fn: ((e: ShimEvent) => void) | null, opts?: boolean | { capture?: boolean }): void {
    const capture = typeof opts === 'boolean' ? opts : opts?.capture === true;
    const list = this.listeners.get(type);
    if (list) this.listeners.set(type, list.filter((l) => !(l.fn === fn && l.capture === capture)));
  }

  /** Capture from the root down, then the target, then bubbling back up (when the event bubbles). */
  dispatchEvent(e: ShimEvent): boolean {
    e.target = this;
    const path: ShimNode[] = [];
    for (let n: ShimNode | null = this; n; n = n.parentNode) path.push(n);
    const run = (node: ShimNode, capture: boolean | null, phase: number): void => {
      if (e.stopped) return;
      e.currentTarget = node;
      e.eventPhase = phase;
      for (const l of [...(node.listeners.get(e.type) ?? [])]) if (capture === null || l.capture === capture) l.fn.call(node, e);
    };
    for (let i = path.length - 1; i > 0; i--) run(path[i]!, true, 1);
    run(this, null, 2);
    if (e.bubbles) for (let i = 1; i < path.length; i++) run(path[i]!, false, 3);
    e.currentTarget = null;
    return !e.defaultPrevented;
  }
}

export class ShimText extends ShimNode {
  constructor(
    public data: string,
    doc: ShimDocument,
  ) {
    super(TEXT_NODE, '#text', doc);
  }

  get nodeValue(): string {
    return this.data;
  }

  set nodeValue(v: string) {
    this.data = String(v);
  }

  override get textContent(): string {
    return this.data;
  }

  override set textContent(v: string) {
    this.data = String(v);
  }
}

export class ShimComment extends ShimNode {
  constructor(
    public data: string,
    doc: ShimDocument,
  ) {
    super(COMMENT_NODE, '#comment', doc);
  }

  override get textContent(): string {
    return '';
  }

  override set textContent(_v: string) {
    // comments hold no text content
  }
}

/** Layout the test controls: every element reports these sizes. */
export const layout = { clientHeight: 600, offsetHeight: 34 };

export class ShimElement extends ShimNode {
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> & { setProperty(k: string, v: string): void; removeProperty(k: string): void };
  scrollTop = 0;
  scrollLeft = 0;
  readonly tagName: string;

  constructor(
    tag: string,
    readonly namespaceURI: string,
    doc: ShimDocument,
  ) {
    super(ELEMENT_NODE, namespaceURI === HTML_NS ? tag.toUpperCase() : tag, doc);
    this.tagName = this.nodeName;
    const style = {} as Record<string, string>;
    Object.defineProperty(style, 'setProperty', { value: (k: string, v: string) => (style[k] = v), enumerable: false });
    Object.defineProperty(style, 'removeProperty', { value: (k: string) => delete style[k], enumerable: false });
    this.style = style as ShimElement['style'];
  }

  setAttribute(k: string, v: string): void {
    this.attributes.set(k.toLowerCase(), String(v));
  }

  setAttributeNS(_ns: string | null, k: string, v: string): void {
    this.setAttribute(k, v);
  }

  getAttribute(k: string): string | null {
    return this.attributes.get(k.toLowerCase()) ?? null;
  }

  hasAttribute(k: string): boolean {
    return this.attributes.has(k.toLowerCase());
  }

  removeAttribute(k: string): void {
    this.attributes.delete(k.toLowerCase());
  }

  removeAttributeNS(_ns: string | null, k: string): void {
    this.removeAttribute(k);
  }

  get id(): string {
    return this.getAttribute('id') ?? '';
  }

  get className(): string {
    return this.getAttribute('class') ?? '';
  }

  set className(v: string) {
    this.setAttribute('class', v);
  }

  get clientHeight(): number {
    return layout.clientHeight;
  }

  get offsetHeight(): number {
    return layout.offsetHeight;
  }

  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: layout.clientHeight, width: 800, height: layout.clientHeight, toJSON: () => ({}) };
  }

  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body;
  }

  /** Every descendant element, depth first. */
  descendants(): ShimElement[] {
    const out: ShimElement[] = [];
    const walk = (n: ShimNode): void => {
      for (const c of n.childNodes) {
        if (c instanceof ShimElement) {
          out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out;
  }
}

const HTML_NS = 'http://www.w3.org/1999/xhtml';

export class ShimDocument extends ShimNode {
  readonly documentElement: ShimElement;
  readonly body: ShimElement;
  activeElement: ShimElement;
  defaultView: unknown = null;

  constructor() {
    super(DOCUMENT_NODE, '#document', null);
    this.documentElement = new ShimElement('html', HTML_NS, this);
    this.body = new ShimElement('body', HTML_NS, this);
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tag: string): ShimElement {
    return new ShimElement(tag, HTML_NS, this);
  }

  createElementNS(ns: string, tag: string): ShimElement {
    return new ShimElement(tag, ns, this);
  }

  createTextNode(text: string): ShimText {
    return new ShimText(String(text), this);
  }

  createComment(text: string): ShimComment {
    return new ShimComment(String(text), this);
  }

  getElementById(id: string): ShimElement | null {
    return this.documentElement.descendants().find((e) => e.id === id) ?? null;
  }
}

/** Installs `window`, `document` and the browser globals the tables use. Idempotent. */
export function installDomShim(): ShimDocument {
  const g = globalThis as Record<string, unknown>;
  if (g['document'] instanceof ShimDocument) return g['document'];
  const doc = new ShimDocument();
  class HTMLIFrameElement {}
  const frames = new Map<number, ReturnType<typeof setTimeout>>();
  let frameSeq = 0;
  const win: Record<string, unknown> = {
    document: doc,
    event: undefined,
    HTMLIFrameElement,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  doc.defaultView = win;
  win['window'] = win;
  g['window'] = win;
  g['document'] = doc;
  g['HTMLIFrameElement'] = HTMLIFrameElement;
  g['requestAnimationFrame'] = (fn: (t: number) => void): number => {
    const id = ++frameSeq;
    frames.set(
      id,
      setTimeout(() => {
        frames.delete(id);
        fn(Date.now());
      }, 0),
    );
    return id;
  };
  g['cancelAnimationFrame'] = (id: number): void => {
    clearTimeout(frames.get(id));
    frames.delete(id);
  };
  g['ResizeObserver'] = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  // React's act() warns unless the environment says it is a test.
  g['IS_REACT_ACT_ENVIRONMENT'] = true;
  return doc;
}
