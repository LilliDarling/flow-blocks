import { $id } from './utils.js';

export type DeleteChoice = 'this' | 'future' | 'all' | null;

let resolveChoice: ((choice: DeleteChoice) => void) | null = null;

/**
 * Show a delete confirmation dialog.
 * For recurring items, shows three options: just this one / this & future / all.
 * For one-off items, shows a simple confirm.
 * Returns the user's choice, or null if cancelled.
 */
export function confirmDelete(name: string, isRecurring: boolean): Promise<DeleteChoice> {
  const dialog = $id('deleteConfirm');
  const title = $id('deleteConfirmTitle');
  const desc = $id('deleteConfirmDesc');
  const thisBtn = $id('deleteThisBtn');
  const futureBtn = $id('deleteFutureBtn');
  const allBtn = $id('deleteAllBtn');

  title.textContent = `Delete "${name}"?`;

  if (isRecurring) {
    desc.textContent = 'This is a recurring item. What would you like to delete?';
    thisBtn.style.display = 'block';
    futureBtn.style.display = 'block';
    allBtn.textContent = 'All occurrences';
  } else {
    desc.textContent = 'This will permanently remove this item.';
    thisBtn.style.display = 'none';
    futureBtn.style.display = 'none';
    allBtn.textContent = 'Delete';
  }

  dialog.classList.add('open');

  return new Promise((resolve) => {
    resolveChoice = resolve;
  });
}

function choose(choice: DeleteChoice): void {
  $id('deleteConfirm').classList.remove('open');
  if (resolveChoice) {
    resolveChoice(choice);
    resolveChoice = null;
  }
}

export function initDeleteConfirmEvents(): void {
  $id('deleteThisBtn').addEventListener('click', () => choose('this'));
  $id('deleteFutureBtn').addEventListener('click', () => choose('future'));
  $id('deleteAllBtn').addEventListener('click', () => choose('all'));
  $id('deleteCancelBtn').addEventListener('click', () => choose(null));

  $id('deleteConfirm').addEventListener('click', (e) => {
    if (e.target === $id('deleteConfirm')) choose(null);
  });
}
