import { beforeEach } from "vitest";

type DomOptions = string | { cls?: string; text?: string; attr?: Record<string, string>; type?: string; value?: string };

function applyDomOptions(el: Element, o?: DomOptions): void {
  if (o == null) return;
  if (typeof o === "string") {
    el.className = o;
    return;
  }
  if (o.cls) el.className = o.cls;
  if (o.text != null) el.textContent = o.text;
  if (o.attr) {
    for (const [key, value] of Object.entries(o.attr)) {
      el.setAttribute(key, value);
    }
  }
  if (o.type != null && "type" in el) {
    (el as HTMLInputElement).type = o.type;
  }
  if (o.value != null && "value" in el) {
    (el as HTMLInputElement).value = o.value;
  }
}

function resolveDocument(node: Node): Document {
  return node.nodeType === 9 ? (node as Document) : node.ownerDocument ?? document;
}

/**
 * Mirror Obsidian helpers for jsdom. Calls on Document stay detached (legacy
 * ownerDocument.createElement behavior). Calls on Element append to that node.
 */
function installCreateElHelpers(proto: typeof Node.prototype): void {
  Object.defineProperty(proto, "createEl", {
    configurable: true,
    writable: true,
    value(this: Node, tag: string, o?: DomOptions) {
      const doc = resolveDocument(this);
      const el = doc.createElement(tag);
      applyDomOptions(el, o);
      if (this.nodeType !== 9) {
        this.appendChild(el);
      }
      return el;
    }
  });

  Object.defineProperty(proto, "createDiv", {
    configurable: true,
    writable: true,
    value(this: Node, o?: DomOptions) {
      return (this as Node & { createEl: (tag: string, o?: DomOptions) => HTMLElement }).createEl("div", o);
    }
  });

  Object.defineProperty(proto, "createSpan", {
    configurable: true,
    writable: true,
    value(this: Node, o?: DomOptions) {
      return (this as Node & { createEl: (tag: string, o?: DomOptions) => HTMLElement }).createEl("span", o);
    }
  });

  Object.defineProperty(proto, "createSvg", {
    configurable: true,
    writable: true,
    value(this: Node, tag: string, o?: DomOptions) {
      const doc = resolveDocument(this);
      const el = doc.createElementNS("http://www.w3.org/2000/svg", tag);
      applyDomOptions(el, o);
      if (this.nodeType !== 9) {
        this.appendChild(el);
      }
      return el;
    }
  });
}

installCreateElHelpers(Node.prototype);

beforeEach(() => {
  (globalThis as typeof globalThis & { activeDocument: Document; activeWindow: Window }).activeDocument =
    globalThis.document;
  (globalThis as typeof globalThis & { activeDocument: Document; activeWindow: Window }).activeWindow =
    globalThis.window;
  installCreateElHelpers(Node.prototype);
});
