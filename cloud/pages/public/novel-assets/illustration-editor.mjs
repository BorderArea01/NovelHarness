import { StateField, StateEffect, EditorView, Decoration, WidgetType } from './editor-vendor.mjs';
import {
  illustrationEntries,
  illustrationMarker,
  imageAsset,
  ILLUSTRATION_LIMIT,
} from '../../../worker/shared/illustrations.mjs';

export async function prepareIllustration(file, caption) {
  if (!file || !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024)
    throw new Error('请选择 10 MiB 以内的 PNG、JPEG 或 WebP 图片。');
  const url = URL.createObjectURL(file),
    image = new Image();
  try {
    image.src = url;
    await image.decode();
    if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 24_000_000)
      throw new Error('图片像素过大，请缩小后再上传。');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片。');
    let data;
    for (const side of [1600, 1200, 800]) {
      const scale = Math.min(1, side / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      data = canvas.toDataURL('image/webp', 0.8);
      if (data.length < ILLUSTRATION_LIMIT - 1024) break;
    }
    const text = JSON.stringify({
      format: 'novel-illustration-v1',
      width: canvas.width,
      height: canvas.height,
      label: String(caption ?? '').slice(0, 160),
      data,
    });
    imageAsset(text);
    return text;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// CM owns positions, undo and the only editable chapter. Widgets are disposable
// views; no parallel prose DOM, draft store or autosave lifecycle is introduced.
export function illustrationExtension(options) {
  const refresh = StateEffect.define();
  class Illustration extends WidgetType {
    constructor(entry, hidden) {
      super();
      this.entry = entry;
      this.hidden = hidden;
    }
    eq(other) {
      return this.entry.marker === other.entry.marker && this.hidden === other.hidden;
    }
    toDOM(view) {
      const entry = this.entry,
        caption = entry.caption || '章节插图';
      const figure = document.createElement('figure');
      figure.className = 'novel-illustration';
      figure.contentEditable = 'false';
      const details = document.createElement('details');
      details.open = !this.hidden;
      const summary = document.createElement('summary');
      summary.textContent = '▧ ' + caption;
      details.append(summary);
      const preview = document.createElement('button');
      preview.type = 'button';
      preview.className = 'novel-illustration-preview';
      preview.setAttribute('aria-label', '放大插图：' + caption);
      const image = document.createElement('img');
      image.alt = caption;
      image.loading = 'lazy';
      image.decoding = 'async';
      preview.append(image);
      const status = document.createElement('span');
      status.setAttribute('role', 'status');
      let alive = true,
        loaded = false;
      const abort = new AbortController();
      const load = async () => {
        if (loaded || !details.open) return;
        loaded = true;
        status.textContent = '读取插图…';
        try {
          const asset = await options.read(entry.path, abort.signal);
          if (!alive) return;
          image.src = asset.data;
          status.textContent = '';
        } catch (error) {
          if (!alive) return;
          loaded = false;
          status.textContent = error.message;
          const retry = document.createElement('button');
          retry.type = 'button';
          retry.textContent = '重试';
          retry.onclick = () => {
            retry.remove();
            load();
          };
          status.append(retry);
        }
      };
      details.addEventListener('toggle', load);
      const observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          load();
        }
      });
      observer.observe(figure);
      let dialog;
      preview.onclick = () => {
        if (!image.src) return;
        dialog = document.createElement('dialog');
        dialog.className = 'novel-illustration-lightbox';
        const full = document.createElement('img');
        full.src = image.src;
        full.alt = caption;
        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '关闭大图';
        close.onclick = () => dialog.close();
        dialog.onclick = (e) => {
          if (e.target === dialog) dialog.close();
        };
        dialog.addEventListener(
          'close',
          () => {
            dialog.remove();
            preview.focus();
          },
          { once: true },
        );
        dialog.append(close, full);
        document.body.append(dialog);
        dialog.showModal();
      };
      details.append(preview, status);
      if (!options.readOnly()) {
        const controls = document.createElement('div');
        controls.className = 'novel-illustration-controls';
        const locate = () => {
          const at = view.posAtDOM(figure);
          return illustrationEntries(view.state.doc.toString()).find(
            (e) => e.from === at && e.marker === entry.marker,
          );
        };
        const change = (insert) => {
          const current = locate();
          if (!current) return;
          view.dispatch({ changes: { from: current.from, to: current.to, insert }, userEvent: 'input' });
        };
        const button = (name, action) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = name;
          b.onclick = action;
          controls.append(b);
        };
        button('图注', () => {
          if (controls.querySelector('input')) return;
          const input = document.createElement('input');
          input.maxLength = 160;
          input.value = entry.caption;
          input.setAttribute('aria-label', '插图图注');
          controls.append(input);
          const save = document.createElement('button');
          save.type = 'button';
          save.textContent = '完成图注';
          save.onclick = () => change(illustrationMarker(entry.path, input.value));
          controls.append(save);
          input.focus();
        });
        button('更换', () => {
          const current = locate();
          if (current) options.replace(current);
        });
        button('移除', () => change(''));
        const actions = document.createElement('details');
        actions.className = 'novel-illustration-actions';
        const edit = document.createElement('summary');
        edit.textContent = '编辑插图';
        actions.append(edit, controls);
        figure.append(actions);
      }
      figure.append(details);
      figure._disposeIllustration = () => {
        alive = false;
        abort.abort();
        observer.disconnect();
        dialog?.remove();
      };
      return figure;
    }
    destroy(dom) {
      dom._disposeIllustration?.();
    }
    ignoreEvent() {
      return true;
    }
    get estimatedHeight() {
      return this.hidden ? 36 : 202;
    }
  }
  const decorations = (state) =>
    Decoration.set(
      illustrationEntries(state.doc.toString()).map((entry) =>
        Decoration.replace({ block: true, widget: new Illustration(entry, options.hidden()) }).range(
          entry.from,
          entry.to,
        ),
      ),
      true,
    );
  const field = StateField.define({
    create: decorations,
    update: (value, tr) =>
      tr.docChanged || tr.effects.some((e) => e.is(refresh)) ? decorations(tr.state) : value,
    provide: (f) => [
      EditorView.decorations.from(f),
      EditorView.atomicRanges.of((view) => view.state.field(f)),
    ],
  });
  return { extension: field, refresh };
}
