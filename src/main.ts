import {
  Notice,
  Plugin,
  TFile,
  TextFileView,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import {
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseAllDocuments,
} from "yaml";

const VIEW_TYPE_YAML_VIEWER = "yaml-viewer";
const YAML_EXTENSIONS = ["yaml", "yml"];
const OUTLINE_MAX_DEPTH = 4;

interface OutlineItem {
  label: string;
  path: string;
  depth: number;
  type: "map" | "seq";
  count: number;
}

export default class YamlViewerPlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(
      VIEW_TYPE_YAML_VIEWER,
      (leaf) => new YamlViewerView(leaf, this),
    );
    this.registerExtensions(YAML_EXTENSIONS, VIEW_TYPE_YAML_VIEWER);

    this.addCommand({
      id: "open-current-yaml-in-viewer",
      name: "Open current YAML file in viewer",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isYamlFile(file)) return false;

        if (!checking) {
          void this.openYamlFile(file);
        }
        return true;
      },
    });
  }

  async openYamlFile(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.setViewState({
      type: VIEW_TYPE_YAML_VIEWER,
      state: { file: file.path },
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }
}

class YamlViewerView extends TextFileView {
  private readonly plugin: YamlViewerPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: YamlViewerPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_YAML_VIEWER;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "YAML viewer";
  }

  getIcon(): string {
    return "braces";
  }

  setViewData(data: string): void {
    this.data = data;
    this.render();
  }

  getViewData(): string {
    return this.data;
  }

  clear(): void {
    this.data = "";
    this.contentEl.empty();
  }

  private render(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("yaml-viewer");

    const header = container.createDiv({ cls: "yaml-viewer__header" });
    const title = header.createDiv({ cls: "yaml-viewer__title" });
    title.createDiv({
      cls: "yaml-viewer__filename",
      text: this.file?.name ?? "YAML file",
    });
    title.createDiv({
      cls: "yaml-viewer__path",
      text: this.file?.path ?? "",
    });

    const toolbar = header.createDiv({ cls: "yaml-viewer__toolbar" });
    const searchWrap = toolbar.createDiv({ cls: "yaml-viewer__search" });
    setIcon(searchWrap.createSpan({ cls: "yaml-viewer__search-icon" }), "search");
    const searchInput = searchWrap.createEl("input", {
      attr: {
        "aria-label": "Filter YAML tree",
        placeholder: "Filter",
        spellcheck: "false",
        type: "search",
      },
    });
    const expandButton = createButton(toolbar, "chevrons-down", "Expand all");
    const collapseButton = createButton(toolbar, "chevrons-up", "Collapse all");
    const rawButton = createButton(toolbar, "file-code-2", "Copy raw YAML");

    rawButton.addEventListener("click", async () => {
      await navigator.clipboard.writeText(this.data);
      new Notice("YAML copied");
    });

    let documents: ReturnType<typeof parseAllDocuments> = [];
    try {
      documents = parseAllDocuments(this.data, {
        prettyErrors: true,
        strict: false,
        uniqueKeys: false,
      });
    } catch (error) {
      renderFatalError(container, error);
      renderRaw(container, this.data);
      return;
    }

    const errors = documents.flatMap((doc) => doc.errors);
    if (errors.length > 0) {
      renderParseErrors(container, errors);
    }

    const body = container.createDiv({ cls: "yaml-viewer__body" });
    const main = body.createDiv({ cls: "yaml-viewer__main" });
    const tree = main.createDiv({ cls: "yaml-viewer__tree" });
    const outlineItems: OutlineItem[] = [];

    if (documents.length === 0 || documents.every((doc) => !doc.contents)) {
      tree.createDiv({
        cls: "yaml-viewer__empty",
        text: "This YAML file is empty.",
      });
    } else {
      documents.forEach((doc, index) => {
        const rootPath = documents.length > 1 ? `$[${index}]` : "$";
        if (documents.length > 1) {
          const docHeader = tree.createDiv({
            cls: "yaml-viewer__document-label",
            text: `Document ${index + 1}`,
          });
          docHeader.dataset.path = rootPath;
        }
        renderDocumentCommentBefore(tree, doc.commentBefore);
        outlineItems.push(...collectOutline(doc.contents, rootPath, documents.length > 1 ? `Document ${index + 1}` : "root", 0));
        renderNode(tree, doc.contents, rootPath, documents.length > 1 ? `Document ${index + 1}` : "root");
      });
    }

    renderOutline(body, tree, outlineItems);

    searchInput.addEventListener("input", () => {
      applyFilter(tree, outlineItems, searchInput.value);
    });

    expandButton.addEventListener("click", () => {
      tree.querySelectorAll("details").forEach((detail) => {
        detail.setAttribute("open", "");
      });
    });

    collapseButton.addEventListener("click", () => {
      tree.querySelectorAll("details").forEach((detail) => {
        detail.removeAttribute("open");
      });
    });

    renderRaw(main, this.data);
  }
}

function renderNode(parent: HTMLElement, node: unknown, path: string, label: string): void {
  if (node === null) {
    renderScalar(parent, label, null, path);
    return;
  }

  if (isMap(node)) {
    const details = createBranch(parent, label, path, "map", `${node.items.length} keys`);
    node.items.forEach((item) => renderPair(details, item, path));
    renderComment(details, node.comment);
    return;
  }

  if (isSeq(node)) {
    const details = createBranch(parent, label, path, "seq", `${node.items.length} items`);
    node.items.forEach((item, index) => {
      renderNode(details, item, `${path}[${index}]`, `[${index}]`);
    });
    renderComment(details, node.comment);
    return;
  }

  if (isAlias(node)) {
    renderScalar(parent, label, `*${node.source}`, path, "alias");
    return;
  }

  if (isScalar(node)) {
    renderScalar(parent, label, node.value, path);
    renderComment(parent, node.comment);
    return;
  }

  renderScalar(parent, label, String(node), path);
}

function renderPair(parent: HTMLElement, pair: { key: unknown; value: unknown }, parentPath: string): void {
  const keyText = stringifyKey(pair.key);
  const childPath = keyText.match(/^[A-Za-z_$][\w$-]*$/)
    ? `${parentPath}.${keyText}`
    : `${parentPath}[${JSON.stringify(keyText)}]`;
  renderNode(parent, pair.value, childPath, keyText);
}

function createBranch(
  parent: HTMLElement,
  label: string,
  path: string,
  type: string,
  meta: string,
): HTMLElement {
  const details = parent.createEl("details", {
    cls: `yaml-viewer__branch yaml-viewer__type-${type}`,
    attr: { open: "" },
  });
  details.dataset.path = path;

  const summary = details.createEl("summary", { cls: "yaml-viewer__row" });
  summary.createSpan({ cls: "yaml-viewer__key", text: label });
  summary.createSpan({ cls: "yaml-viewer__badge", text: type });
  summary.createSpan({ cls: "yaml-viewer__meta", text: meta });
  addCopyPathButton(summary, path);

  return details;
}

function renderScalar(
  parent: HTMLElement,
  label: string,
  value: unknown,
  path: string,
  forcedType?: string,
): void {
  const type = forcedType ?? valueType(value);
  const row = parent.createDiv({ cls: "yaml-viewer__row yaml-viewer__leaf" });
  row.addClass(`yaml-viewer__type-${type}`);
  row.dataset.path = path;
  row.createSpan({ cls: "yaml-viewer__key", text: label });
  row.createSpan({ cls: "yaml-viewer__badge", text: type });
  row.createSpan({ cls: "yaml-viewer__value", text: formatValue(value) });
  addCopyPathButton(row, path);
}

function addCopyPathButton(parent: HTMLElement, path: string): void {
  const button = createButton(parent, "copy", "Copy YAML path");
  button.addClass("yaml-viewer__copy");
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await navigator.clipboard.writeText(path);
    new Notice(`Copied ${path}`);
  });
}

function renderParseErrors(parent: HTMLElement, errors: Error[]): void {
  const box = parent.createDiv({ cls: "yaml-viewer__errors" });
  box.createDiv({ cls: "yaml-viewer__errors-title", text: "Parse warnings/errors" });
  errors.forEach((error) => {
    box.createDiv({ cls: "yaml-viewer__error", text: error.message });
  });
}

function renderFatalError(parent: HTMLElement, error: unknown): void {
  const box = parent.createDiv({ cls: "yaml-viewer__errors" });
  box.createDiv({ cls: "yaml-viewer__errors-title", text: "Could not parse YAML" });
  box.createDiv({ cls: "yaml-viewer__error", text: getErrorMessage(error) });
}

function renderRaw(parent: HTMLElement, data: string): void {
  const details = parent.createEl("details", { cls: "yaml-viewer__raw" });
  details.createEl("summary", { text: "Raw YAML" });
  const pre = details.createEl("pre");
  renderHighlightedYaml(pre, data);
}

function renderComment(parent: HTMLElement, comment: string | null | undefined): void {
  if (!comment) return;
  parent.createDiv({ cls: "yaml-viewer__comment", text: `# ${comment.trim()}` });
}

function renderDocumentCommentBefore(parent: HTMLElement, comment: string | null | undefined): void {
  if (!comment) return;
  const block = parent.createDiv({ cls: "yaml-viewer__document-comments" });
  comment.split("\n").forEach((line) => {
    block.createDiv({
      cls: "yaml-viewer__document-comment",
      text: `#${line}`,
    });
  });
}

function createButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const button = parent.createEl("button", {
    cls: "clickable-icon yaml-viewer__button",
    attr: { "aria-label": label, title: label },
  });
  setIcon(button, icon);
  return button;
}

function stringifyKey(key: unknown): string {
  if (isScalar(key)) {
    return String(key.value);
  }
  if (key === null || key === undefined) {
    return "null";
  }
  return String(key);
}

function valueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isYamlFile(file: TFile | null): file is TFile {
  return file instanceof TFile && YAML_EXTENSIONS.includes(file.extension.toLowerCase());
}

function collectOutline(
  node: unknown,
  path: string,
  label: string,
  depth: number,
): OutlineItem[] {
  if (depth > OUTLINE_MAX_DEPTH) return [];
  if (!isMap(node) && !isSeq(node)) return [];

  const type = isMap(node) ? "map" : "seq";
  const count = node.items.length;
  const items: OutlineItem[] = [{ label, path, depth, type, count }];

  if (depth === OUTLINE_MAX_DEPTH) return items;

  if (isMap(node)) {
    node.items.forEach((item) => {
      const childLabel = stringifyKey(item.key);
      const childPath = childLabel.match(/^[A-Za-z_$][\w$-]*$/)
        ? `${path}.${childLabel}`
        : `${path}[${JSON.stringify(childLabel)}]`;
      items.push(...collectOutline(item.value, childPath, childLabel, depth + 1));
    });
  } else {
    node.items.forEach((item, index) => {
      if (!isMap(item) && !isSeq(item)) return;
      items.push(...collectOutline(item, `${path}[${index}]`, `[${index}]`, depth + 1));
    });
  }

  return items;
}

function renderOutline(parent: HTMLElement, tree: HTMLElement, items: OutlineItem[]): void {
  const aside = parent.createEl("aside", { cls: "yaml-viewer__outline" });
  aside.createDiv({ cls: "yaml-viewer__outline-title", text: "Outline" });

  if (items.length === 0) {
    aside.createDiv({ cls: "yaml-viewer__outline-empty", text: "No structure" });
    return;
  }

  items.forEach((item) => {
    const button = aside.createEl("button", {
      cls: "yaml-viewer__outline-item",
      attr: {
        "aria-label": `Go to ${item.path}`,
        type: "button",
      },
    });
    button.dataset.path = item.path;
    button.style.setProperty("--yaml-viewer-outline-depth", String(item.depth));
    button.createSpan({ cls: "yaml-viewer__outline-label", text: item.label });
    button.createSpan({ cls: "yaml-viewer__outline-meta", text: `${item.count}` });
    button.addEventListener("click", () => {
      const target = findPathElement(tree, item.path);
      if (!target) return;
      openAncestors(target);
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.addClass("yaml-viewer__pulse");
      window.setTimeout(() => target.removeClass("yaml-viewer__pulse"), 900);
    });
  });
}

function applyFilter(tree: HTMLElement, outlineItems: OutlineItem[], query: string): void {
  const needle = query.trim().toLowerCase();
  const nodes = Array.from(tree.querySelectorAll<HTMLElement>("[data-path]"));
  const outline = tree.parentElement?.parentElement?.querySelector<HTMLElement>(".yaml-viewer__outline");
  const outlineButtons = Array.from(outline?.querySelectorAll<HTMLButtonElement>(".yaml-viewer__outline-item") ?? []);

  if (!needle) {
    nodes.forEach((node) => {
      node.removeClass("yaml-viewer__hidden");
      node.removeClass("yaml-viewer__match");
    });
    outlineButtons.forEach((button) => button.removeClass("yaml-viewer__hidden"));
    return;
  }

  const visiblePaths = new Set<string>();
  const matchingPaths = new Set<string>();

  nodes.forEach((node) => {
    const path = node.dataset.path ?? "";
    const haystack = `${path} ${node.textContent ?? ""}`.toLowerCase();
    if (!haystack.includes(needle)) return;
    matchingPaths.add(path);
    visiblePaths.add(path);
    addAncestorPaths(path, visiblePaths);
  });

  nodes.forEach((node) => {
    const path = node.dataset.path ?? "";
    node.toggleClass("yaml-viewer__hidden", !visiblePaths.has(path));
    node.toggleClass("yaml-viewer__match", matchingPaths.has(path));
    if (visiblePaths.has(path)) openAncestors(node);
  });

  outlineButtons.forEach((button) => {
    const path = button.dataset.path ?? "";
    const item = outlineItems.find((outlineItem) => outlineItem.path === path);
    const haystack = `${path} ${item?.label ?? ""}`.toLowerCase();
    button.toggleClass("yaml-viewer__hidden", !haystack.includes(needle));
  });
}

function addAncestorPaths(path: string, paths: Set<string>): void {
  let current = path;
  while (current !== "$") {
    current = parentPath(current);
    paths.add(current);
  }
}

function parentPath(path: string): string {
  if (path.endsWith("]")) {
    const bracket = path.lastIndexOf("[");
    if (bracket > 0) return path.slice(0, bracket);
  }
  const dot = path.lastIndexOf(".");
  if (dot > 0) return path.slice(0, dot);
  return "$";
}

function findPathElement(tree: HTMLElement, path: string): HTMLElement | undefined {
  return Array.from(tree.querySelectorAll<HTMLElement>("[data-path]")).find((element) => {
    return element.dataset.path === path;
  });
}

function openAncestors(element: HTMLElement): void {
  let current: HTMLElement | null = element;
  while (current) {
    if (current instanceof HTMLDetailsElement) current.open = true;
    current = current.parentElement;
  }
}

function renderHighlightedYaml(parent: HTMLElement, data: string): void {
  const lines = data.split("\n");
  lines.forEach((line, index) => {
    const lineEl = parent.createDiv({ cls: "yaml-viewer__source-line" });
    lineEl.createSpan({ cls: "yaml-viewer__line-number", text: String(index + 1) });
    const code = lineEl.createSpan({ cls: "yaml-viewer__source-code" });
    highlightYamlLine(code, line);
  });
}

function highlightYamlLine(parent: HTMLElement, line: string): void {
  if (line.trimStart().startsWith("#")) {
    parent.createSpan({ cls: "yaml-viewer__tok-comment", text: line });
    return;
  }

  const hashIndex = findCommentStart(line);
  const codePart = hashIndex >= 0 ? line.slice(0, hashIndex) : line;
  const commentPart = hashIndex >= 0 ? line.slice(hashIndex) : "";
  const keyMatch = codePart.match(/^(\s*(?:-\s*)?)([^:#\n][^:\n]*?)(\s*:\s*)(.*)$/);

  if (keyMatch) {
    parent.appendText(keyMatch[1]);
    parent.createSpan({ cls: "yaml-viewer__tok-key", text: keyMatch[2] });
    parent.createSpan({ cls: "yaml-viewer__tok-punctuation", text: keyMatch[3] });
    highlightYamlValue(parent, keyMatch[4]);
  } else {
    highlightYamlValue(parent, codePart);
  }

  if (commentPart) {
    parent.createSpan({ cls: "yaml-viewer__tok-comment", text: commentPart });
  }
}

function highlightYamlValue(parent: HTMLElement, value: string): void {
  const trimmed = value.trim();
  const leading = value.slice(0, value.length - value.trimStart().length);
  const trailing = value.slice(value.trimEnd().length);

  parent.appendText(leading);
  if (!trimmed) {
    parent.appendText(trailing);
    return;
  }

  const cls = tokenClass(trimmed);
  parent.createSpan({ cls, text: trimmed });
  parent.appendText(trailing);
}

function tokenClass(value: string): string {
  if (/^["'].*["']$/.test(value)) return "yaml-viewer__tok-string";
  if (/^(true|false)$/i.test(value)) return "yaml-viewer__tok-boolean";
  if (/^(null|~)$/i.test(value)) return "yaml-viewer__tok-null";
  if (/^-?\d+(\.\d+)?$/.test(value)) return "yaml-viewer__tok-number";
  if (/^[\[{].*[\]}]$/.test(value)) return "yaml-viewer__tok-collection";
  return "yaml-viewer__tok-string";
}

function findCommentStart(line: string): number {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if ((character === "'" || character === "\"") && line[index - 1] !== "\\") {
      quote = quote === character ? null : quote ?? character;
      continue;
    }
    if (character === "#" && quote === null && (index === 0 || /\s/.test(line[index - 1]))) {
      return index;
    }
  }
  return -1;
}
