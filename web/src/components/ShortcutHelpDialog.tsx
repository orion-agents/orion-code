import { useEffect, useRef, type MouseEvent } from 'react';

import { formatShortcut, shortcutsByGroup } from '../shortcuts';
import { Icon } from './Icon';

export interface ShortcutHelpDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * Keyboard shortcut reference (v0.3.6). Rendered from the shared `SHORTCUTS` table so
 * the panel can never drift from the bindings that are actually wired up.
 */
export function ShortcutHelpDialog({ open, onClose }: ShortcutHelpDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = 'shortcut-help-title';

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const onBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  const groups = shortcutsByGroup();

  return (
    <dialog
      ref={ref}
      id="shortcut-help"
      className="modal shortcut-help"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={onBackdropClick}
    >
      <header className="shortcut-help-header">
        <div>
          <span className="eyebrow">KEYBOARD</span>
          <h2 id={titleId}>键盘快捷键</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="关闭快捷键面板">
          <Icon name="close" size={15} />
        </button>
      </header>

      <div className="shortcut-help-body">
        {groups.map(({ group, items }) => (
          <section key={group} className="shortcut-help-group">
            <h3>{group}</h3>
            <dl>
              {items.map(binding => (
                <div key={binding.id} className="shortcut-row">
                  <dt>{binding.description}</dt>
                  <dd>
                    <kbd>{formatShortcut(binding.tokens)}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>

      <footer className="shortcut-help-footer">
        <p>
          按 <kbd>Esc</kbd> 关闭本面板，焦点会回到打开它的位置。
        </p>
      </footer>
    </dialog>
  );
}
