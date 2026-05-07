import { state, POOL_MAX_ACTIVE } from './state.js';
import { BlockType, FlowBlock, BLOCK_TYPE_KEYWORDS, TYPE_LABELS, $id, esc, getTodayDate } from './utils.js';
import { renderTimeline } from './timeline.js';
import { renderWeek } from './week.js';

const ALL_TYPES: BlockType[] = ['push', 'flow', 'steady', 'growth', 'drift', 'rest', 'buffer'];

// ────────────────────────────────────────────────────────────
// Keyword → Block Type mapping (fuzzy, stem-aware)
// ────────────────────────────────────────────────────────────

/** Quick tasks that should get short durations (10-15 min). */
const QUICK_TASK_PATTERNS = [
  /\bfeed\b/, /\bwater\s+(the\s+)?plant/, /\btake\s+(my\s+)?med/,
  /\btake\s+vitamin/, /\btake\s+pill/, /\bcheck\s+mail/,
  /\btake\s+out\s+(the\s+)?trash/, /\bscoop\s+litter/, /\blet\s+(the\s+)?dog/,
  /\bpick\s+up/, /\bput\s+away/, /\btake\s+out\b/, /\bwipe\b/, /\bsweep\b/,
  /\bunload\b/, /\bload\s+(the\s+)?dishwasher/,
];

/** Block types where tasks are interchangeable "pick one" options (group into one block). */
const GROUPABLE_TYPES = new Set<BlockType>(['drift', 'rest']);

/** Default durations by block type (minutes). */
const DEFAULT_DURATIONS: Record<BlockType, number> = {
  push: 60,
  flow: 45,
  steady: 30,
  growth: 30,
  drift: 30,
  rest: 20,
  buffer: 15,
};

const QUICK_DURATION = 15;

function inferBlockType(text: string): BlockType {
  const lower = text.toLowerCase();
  const words = lower.split(/\s+/);

  for (const word of words) {
    if (BLOCK_TYPE_KEYWORDS[word]) return BLOCK_TYPE_KEYWORDS[word];
  }

  const keywords = Object.keys(BLOCK_TYPE_KEYWORDS);
  for (const word of words) {
    for (const kw of keywords) {
      if (word.startsWith(kw) || kw.startsWith(word)) {
        return BLOCK_TYPE_KEYWORDS[kw];
      }
    }
  }

  for (const kw of keywords) {
    if (lower.includes(kw)) return BLOCK_TYPE_KEYWORDS[kw];
  }

  return 'steady';
}

function isQuickTask(text: string): boolean {
  const lower = text.toLowerCase();
  return QUICK_TASK_PATTERNS.some(p => p.test(lower));
}

// ────────────────────────────────────────────────────────────
// Group (no scheduling — everything goes to pool)
// ────────────────────────────────────────────────────────────

interface ParsedTask {
  text: string;
  type: BlockType;
  quick: boolean;
}

interface PoolItem {
  title: string;
  menu: string[];
  type: BlockType;
  duration: number;
  // Preserved per source task so type changes can recompute duration correctly.
  // For merged groups, this is the OR across the merged tasks (any quick → quick).
  quick: boolean;
}

function durationFor(type: BlockType, quick: boolean): number {
  return quick ? QUICK_DURATION : DEFAULT_DURATIONS[type];
}

function parseIntoPooItems(input: string): PoolItem[] {
  const rawTasks = input
    .split(/[,\n]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (rawTasks.length === 0) return [];

  const parsed: ParsedTask[] = rawTasks.map(text => ({
    text,
    type: inferBlockType(text),
    quick: isQuickTask(text),
  }));

  const items: PoolItem[] = [];
  const groupBuckets = new Map<BlockType, ParsedTask[]>();

  for (const task of parsed) {
    if (GROUPABLE_TYPES.has(task.type)) {
      if (!groupBuckets.has(task.type)) groupBuckets.set(task.type, []);
      groupBuckets.get(task.type)!.push(task);
    } else {
      items.push({
        title: task.text.slice(0, 200),
        menu: [task.text.slice(0, 100)],
        type: task.type,
        duration: durationFor(task.type, task.quick),
        quick: task.quick,
      });
    }
  }

  for (const [type, tasks] of groupBuckets) {
    const allQuick = tasks.every(t => t.quick);
    items.push({
      title: (tasks.length === 1 ? tasks[0].text : TYPE_LABELS[type]).slice(0, 200),
      menu: tasks.map(t => t.text.slice(0, 100)).slice(0, 20),
      type,
      duration: durationFor(type, allQuick),
      quick: allQuick,
    });
  }

  return items;
}

// ────────────────────────────────────────────────────────────
// UI
// ────────────────────────────────────────────────────────────

function showQuickStart(): void {
  const overlay = document.createElement('div');
  overlay.className = 'quickstart-overlay';

  overlay.innerHTML = `
    <div class="quickstart-modal">
      <h3>What's floating around in your head?</h3>
      <p class="quickstart-sub">Get it all out — separate with commas or new lines. Nothing gets scheduled, it all goes into your pool. You decide what to do when you're ready.</p>
      <textarea class="quickstart-input" rows="4" placeholder="e.g. gym, emails, work on thesis, cook dinner, feed the fish"></textarea>
      <div class="quickstart-preview" id="quickstartPreview"></div>
      <p class="quickstart-hint">Everything lands in your pool as options. Pick from them whenever the energy fits.</p>
      <div class="quickstart-actions">
        <button class="btn btn-primary quickstart-go" disabled>Add to pool</button>
        <button class="btn btn-ghost quickstart-cancel">Cancel</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const textarea = overlay.querySelector('.quickstart-input') as HTMLTextAreaElement;
  const preview = overlay.querySelector('#quickstartPreview') as HTMLElement;
  const goBtn = overlay.querySelector('.quickstart-go') as HTMLButtonElement;
  const cancelBtn = overlay.querySelector('.quickstart-cancel') as HTMLButtonElement;

  let planned: PoolItem[] = [];

  const renderPreview = (): void => {
    goBtn.disabled = planned.length === 0;

    if (planned.length === 0) {
      preview.innerHTML = '';
      return;
    }

    preview.innerHTML = planned.map((b, i) => {
      const menuStr = b.menu.length > 1
        ? `<span class="quickstart-preview-menu">${b.menu.map(m => esc(m)).join(' · ')}</span>`
        : '';
      const typeOptions = ALL_TYPES.map(t =>
        `<option value="${t}"${t === b.type ? ' selected' : ''}>${esc(TYPE_LABELS[t])}</option>`
      ).join('');
      const ungroupBtn = b.menu.length > 1
        ? `<button type="button" class="quickstart-ungroup" data-ungroup="${i}" title="Split into separate items">Ungroup</button>`
        : '';
      return `<div class="quickstart-preview-item">
        <select class="quickstart-preview-type type-badge-${b.type}" data-type-select="${i}" aria-label="Change category">
          ${typeOptions}
        </select>
        <div class="quickstart-preview-info">
          <span class="quickstart-preview-text">${esc(b.title)}</span>
          ${menuStr}
        </div>
        ${ungroupBtn}
        <span class="quickstart-preview-time">~${b.duration}m</span>
      </div>`;
    }).join('');
  };

  // Re-parse from the textarea on every keystroke. Any chip-level edits the
  // user has made will be discarded — the simple model is "type, then customize".
  const reparseFromText = (): void => {
    planned = parseIntoPooItems(textarea.value.trim());
    renderPreview();
  };

  textarea.addEventListener('input', reparseFromText);

  preview.addEventListener('change', (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-type-select]');
    if (!sel) return;
    const idx = parseInt(sel.dataset.typeSelect!, 10);
    const item = planned[idx];
    if (!item) return;
    const newType = sel.value as BlockType;
    item.type = newType;
    item.duration = durationFor(newType, item.quick);
    renderPreview();
  });

  preview.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-ungroup]');
    if (!btn) return;
    const idx = parseInt(btn.dataset.ungroup!, 10);
    const item = planned[idx];
    if (!item || item.menu.length <= 1) return;
    const split: PoolItem[] = item.menu.map(menuText => ({
      title: menuText.slice(0, 200),
      menu: [menuText.slice(0, 100)],
      type: item.type,
      duration: durationFor(item.type, item.quick),
      quick: item.quick,
    }));
    planned.splice(idx, 1, ...split);
    renderPreview();
  });

  goBtn.addEventListener('click', async () => {
    if (planned.length === 0) return;
    goBtn.disabled = true;
    goBtn.textContent = 'Adding...';

    // Respect the pool cap — only add as many as there's room for.
    const slotsLeft = Math.max(0, POOL_MAX_ACTIVE - state.countActivePool());
    const toAdd = planned.slice(0, slotsLeft);
    const dropped = planned.length - toAdd.length;

    for (const b of toAdd) {
      const block: FlowBlock = {
        type: b.type,
        title: b.title,
        menu: b.menu,
        start: '',       // no time = pool item
        duration: b.duration,
        days: [],
        date: null,      // persistent — stays until completed or removed
        status: 'pending',
      };
      await state.addBlock(block, 'modal');
    }

    if (dropped > 0) {
      // Surface so the user knows what didn't land, without losing their text
      goBtn.disabled = false;
      goBtn.textContent = `Add ${toAdd.length}`;
      const hint = overlay.querySelector('.quickstart-hint') as HTMLElement | null;
      if (hint) {
        hint.textContent = `Added ${toAdd.length}. Pool is full (${POOL_MAX_ACTIVE}) — ${dropped} item${dropped === 1 ? '' : 's'} didn't fit. Complete or remove some to make room.`;
        hint.classList.add('quickstart-hint-warn');
      }
      renderTimeline();
      renderWeek();
      return;
    }

    overlay.remove();
    renderTimeline();
    renderWeek();
  });

  cancelBtn.addEventListener('click', () => overlay.remove());

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  setTimeout(() => textarea.focus(), 100);
}

// ────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────

export function initQuickStart(): void {
  const btn = $id('quickStartBtn');
  if (btn) btn.addEventListener('click', showQuickStart);
}
