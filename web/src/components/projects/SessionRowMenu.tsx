import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { Icon } from '../Icon';

export interface SessionRowMenuItem {
  readonly id: string;
  readonly label: string;
  /** Renders the item in the destructive style (e.g. delete). */
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Why the item is disabled; surfaced as the accessible description. */
  readonly hint?: string;
  readonly onSelect: () => void;
}

export interface SessionRowMenuProps {
  /** Accessible name for the trigger, e.g. `会话 X 操作`. */
  readonly label: string;
  readonly items: readonly SessionRowMenuItem[];
  readonly disabled?: boolean;
}

const NAVIGATION_KEYS = ['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'] as const;

/**
 * Row-level overflow menu for Session rows (v0.3.7). One trigger replaces the
 * ad-hoc rename icon so tags / archive / delete can join without another
 * layout change. Keyboard: ↑↓ move, Home/End jump, Esc closes and restores
 * focus to the trigger, activation closes the menu.
 */
export function SessionRowMenu({ label, items, disabled = false }: SessionRowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemsRef = useRef<Array<HTMLButtonElement | null>>([]);
  // Unique per-instance id base so disabled-item hints never collide across
  // rows (aria-describedby must point at the row's own hint).
  const hintIdBase = useId();

  const closeWithFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // Focus the first enabled item when the menu opens. `open` is the only real
  // trigger: the items array is rebuilt on every render by the caller.
  useEffect(() => {
    if (!open) return;
    const firstEnabled = items.findIndex(item => !item.disabled);
    itemsRef.current[firstEnabled >= 0 ? firstEnabled : 0]?.focus();
  }, [open]);

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!NAVIGATION_KEYS.includes(event.key as (typeof NAVIGATION_KEYS)[number])) return;
    event.preventDefault();
    if (event.key === 'Escape') {
      closeWithFocus();
      return;
    }
    const enabled = items
      .map((item, index) => ({ item, index }))
      .filter(entry => !entry.item.disabled);
    if (!enabled.length) return;
    const current = enabled.findIndex(
      entry => itemsRef.current[entry.index] === document.activeElement
    );
    let next = 0;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = enabled.length - 1;
    else {
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      next = current < 0 ? 0 : (current + delta + enabled.length) % enabled.length;
    }
    itemsRef.current[enabled[next].index]?.focus();
  };

  return (
    <div className="session-row-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="icon-button session-row-menu-trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
            if (open) return;
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name="more" size={15} />
      </button>
      {open ? (
        <div className="session-menu" role="menu" aria-label={label} onKeyDown={onMenuKeyDown}>
          {items.map((item, index) => (
            <button
              key={item.id}
              ref={element => {
                itemsRef.current[index] = element;
              }}
              type="button"
              role="menuitem"
              className={`session-menu-item${item.danger ? ' danger' : ''}`}
              tabIndex={-1}
              disabled={item.disabled}
              aria-describedby={item.hint ? `${hintIdBase}-${item.id}` : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
              {item.hint ? (
                <span id={`${hintIdBase}-${item.id}`} className="session-menu-hint">
                  {item.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
