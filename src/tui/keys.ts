// Pure keymap layer — no React, no Ink. The App component reads keystrokes via
// useInput and forwards them here, then dispatches the resulting Action onto
// the store. Splitting it out means the bindings are unit-testable without
// rendering anything.
//
// Bindings (grid mode, default):
//   j / down      next cell
//   k / up        previous cell
//   h / left      one column left
//   l / right     one column right
//   enter         open detail
//   /             enter filter mode
//   esc           clear filter / exit filter mode
//   a             toggle show-all (incl. stale + done sessions)
//   d             cycle density (card -> compact -> row)
//   c             copy `--resume <focused_sid>` to clipboard (OSC 52)
//   ctrl-d        scroll half-page down
//   ctrl-u        scroll half-page up
//   r             force reconcile (handled at App level)
//   q | ctrl-c    quit
//
// Bindings (detail mode):
//   esc           back to grid
//   j / down      scroll events down
//   k / up        scroll events up
//   q | ctrl-c    quit
//
// Filter editing mode is special-cased at the App level; this module only
// describes the structural action set.

import type { TuiState } from './store.ts';

// Subset of ink's Key type — we only consume what we need so this module is
// trivially mockable in tests without importing ink.
export interface KeyEvent {
  return?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  ctrl?: boolean;
}

export type Action =
  | { type: 'none' }
  | { type: 'quit' }
  | { type: 'open-detail' }
  | { type: 'back-to-grid' }
  | { type: 'enter-filter' }
  | { type: 'clear-filter' }
  | { type: 'toggle-show-all' }
  | { type: 'cycle-density' }
  | { type: 'copy-resume' }
  | { type: 'reconcile' }
  | { type: 'move-focus'; dx: -1 | 0 | 1; dy: -1 | 0 | 1 }
  | { type: 'scroll-events'; delta: number }
  | { type: 'scroll-page'; direction: -1 | 1 };

// Compute the visible keys list (after filter), then move focus dx/dy in a
// 2-D grid laid out left-to-right, top-to-bottom with `cols` columns. Returns
// the new focused key or `null` if nothing is focusable.
export function computeFocusAfterMove(
  visible: string[],
  cols: number,
  current: string | null,
  dx: -1 | 0 | 1,
  dy: -1 | 0 | 1,
): string | null {
  if (visible.length === 0) return null;
  const idx = current == null ? -1 : visible.indexOf(current);
  if (idx === -1) return visible[0] ?? null;

  const row = Math.floor(idx / cols);
  const col = idx % cols;

  let nextRow = row + dy;
  let nextCol = col + dx;

  // Horizontal wrap inside the row keeps movement intuitive.
  const lastIdx = visible.length - 1;
  const rowsCount = Math.floor(lastIdx / cols) + 1;

  if (nextCol < 0) nextCol = 0;
  if (nextCol >= cols) nextCol = cols - 1;
  if (nextRow < 0) nextRow = 0;
  if (nextRow >= rowsCount) nextRow = rowsCount - 1;

  let nextIdx = nextRow * cols + nextCol;
  if (nextIdx > lastIdx) nextIdx = lastIdx;
  return visible[nextIdx] ?? null;
}

export function handleGridKey(input: string, key: KeyEvent): Action {
  if (key.ctrl && input === 'c') return { type: 'quit' };
  // Half-page scroll. Ctrl-D / Ctrl-U match vim/less convention.
  if (key.ctrl && input === 'd') return { type: 'scroll-page', direction: 1 };
  if (key.ctrl && input === 'u') return { type: 'scroll-page', direction: -1 };
  if (input === 'q') return { type: 'quit' };
  if (key.return) return { type: 'open-detail' };
  if (input === '/') return { type: 'enter-filter' };
  if (key.escape) return { type: 'clear-filter' };
  if (input === 'a') return { type: 'toggle-show-all' };
  if (input === 'd') return { type: 'cycle-density' };
  if (input === 'c') return { type: 'copy-resume' };
  if (input === 'r') return { type: 'reconcile' };
  if (input === 'j' || key.downArrow) return { type: 'move-focus', dx: 0, dy: 1 };
  if (input === 'k' || key.upArrow) return { type: 'move-focus', dx: 0, dy: -1 };
  if (input === 'h' || key.leftArrow) return { type: 'move-focus', dx: -1, dy: 0 };
  if (input === 'l' || key.rightArrow) return { type: 'move-focus', dx: 1, dy: 0 };
  return { type: 'none' };
}

export function handleDetailKey(input: string, key: KeyEvent): Action {
  if (key.ctrl && input === 'c') return { type: 'quit' };
  if (input === 'q') return { type: 'quit' };
  if (key.escape) return { type: 'back-to-grid' };
  if (input === 'j' || key.downArrow) return { type: 'scroll-events', delta: 1 };
  if (input === 'k' || key.upArrow) return { type: 'scroll-events', delta: -1 };
  return { type: 'none' };
}

// Helper used by the unit tests: drive a tiny fake store through an action
// without standing up React. The App component implements its own dispatch
// because some actions are async (reconcile) or affect ink state (quit).
export function applyActionToStore(
  state: Pick<TuiState, 'mode' | 'focusedKey' | 'filter' | 'filterMode' | 'eventScroll'>,
  action: Action,
): typeof state & { quit?: boolean } {
  switch (action.type) {
    case 'none':
      return state;
    case 'quit':
      return { ...state, quit: true };
    case 'open-detail':
      return { ...state, mode: 'detail', eventScroll: 0 };
    case 'back-to-grid':
      return { ...state, mode: 'grid', eventScroll: 0 };
    case 'enter-filter':
      return { ...state, filterMode: true };
    case 'clear-filter':
      return { ...state, filter: '', filterMode: false };
    case 'toggle-show-all':
      return state; // App owns the showAll slice; pure helper just acks
    case 'cycle-density':
      return state; // App owns the density slice; pure helper just acks
    case 'copy-resume':
      return state; // App owns the side effect; pure helper just acks
    case 'reconcile':
      return state;
    case 'move-focus':
      return state; // requires visible-list context, handled at App level
    case 'scroll-events':
      return { ...state, eventScroll: Math.max(0, state.eventScroll + action.delta) };
    case 'scroll-page':
      return state; // App owns the scrollOffset slice; pure helper just acks
  }
}
